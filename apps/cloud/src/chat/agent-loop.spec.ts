import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudStore } from "../store/cloud.store";
import { TasksService } from "../tasks/tasks.service";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { ChatService } from "./chat.service";

describe("background Agent loop with real task state machine", () => {
  let directory: string;
  let store: CloudStore;
  let chat: ChatService;
  let tasks: TasksService;
  let send: ReturnType<typeof vi.fn>;
  let answer: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-loop-"));
    process.env.MCAI_CONFIG_DIR = directory;
    store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Test", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager",
      collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    send = vi.fn().mockReturnValue(true);
    answer = vi.fn().mockResolvedValue({ status: "answered", answer: "核验完成。" });
    const model = {
      answer, decideRecovery: vi.fn().mockResolvedValue("请检查失败原因。"),
      route: vi.fn().mockResolvedValue({ route: "tool", answer: "正在读取配置。", toolIntent: "读取 server.properties", preferredTool: "config.inspect" }),
    } as unknown as ModelGatewayService;
    tasks = new TasksService(store, { send } as unknown as AgentConnectionRegistry, model);
    chat = new ChatService(store, model, tasks);
  });

  afterEach(async () => {
    await chat.onModuleDestroy();
    vi.useRealTimers();
    delete process.env.MCAI_CONFIG_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  async function start() {
    const session = await chat.create("tenant-1", "instance-1");
    const { task } = await chat.send(session.id, "tenant-1", "检查服务器配置");
    return { session, task: task! };
  }

  async function succeed(id: string) {
    for (const state of ["EXECUTING", "VERIFYING", "SUCCEEDED"]) {
      await tasks.recordAgentEvent({ task_id: id, state, summary: `receipt: ${state}` });
    }
  }

  function follow(intent = "列出 /plugins 目录", preferredTool = "files.list") {
    return { status: "answered", answer: "已收到工具结果。", continuation: {
      route: "tool", toolIntent: intent, preferredTool, answer: "正在继续核验。",
    } };
  }

  it("uses the startup timer to continue without a message poll and waits for real callbacks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await chat.onModuleInit();
    const { session, task } = await start();
    await chat.runAgentLoop();
    expect(answer).not.toHaveBeenCalled();
    answer.mockResolvedValueOnce(follow());
    await succeed(task.id);
    // Advance only timers; filesystem promises keep their real scheduling.
    await vi.advanceTimersByTimeAsync(1_000);
    await chat.runAgentLoop();
    expect(send).toHaveBeenCalledTimes(2);
    const child = [...store.tasks.values()].find((item) => item.parent_task_id === task.id)!;
    expect(child.chain_depth).toBe(1);
    expect(child.state).toBe("SNAPSHOTTING");
    await succeed(child.id);
    await chat.runAgentLoop();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(store.messages.get(session.id)?.at(-1)?.content).toBe("核验完成。");
  });

  it("coalesces ticks and browser polls into exactly one continuation", async () => {
    const { session, task } = await start();
    await succeed(task.id);
    answer.mockResolvedValueOnce(follow());
    await Promise.all([chat.runAgentLoop(), chat.runAgentLoop(), chat.messages(session.id, "tenant-1")]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(answer).toHaveBeenCalledOnce();
    const archive = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
    expect(archive.messages.filter((item: { task_phase: string }) => item.task_phase === "completion")).toHaveLength(1);
  });

  it("pauses a mutating continuation until its exact plan is confirmed", async () => {
    const { task } = await start();
    answer.mockResolvedValueOnce(follow("将视距设置为 8", "config.patch"));
    await succeed(task.id);
    await chat.runAgentLoop();
    const child = [...store.tasks.values()].find((item) => item.parent_task_id === task.id)!;
    expect(child.state).toBe("WAITING_CONFIRMATION");
    await chat.runAgentLoop();
    expect(send).toHaveBeenCalledOnce();
    const { token } = tasks.issueConfirmation(child.id, "tenant-1");
    tasks.confirm(child.id, "tenant-1", token);
    expect(send).toHaveBeenCalledTimes(2);
    await succeed(child.id);
    await chat.runAgentLoop();
    expect(child.completion_response).toBe("核验完成。");
  });

  it.each(["FAILED", "CANCELLED"])("stops a %s task even if the model requests continuation", async (state) => {
    const { session, task } = await start();
    await tasks.recordAgentEvent({ task_id: task.id, state: "EXECUTING" });
    await tasks.recordAgentEvent({ task_id: task.id, state, summary: state });
    answer.mockResolvedValueOnce(follow());
    await chat.runAgentLoop();
    expect(send).toHaveBeenCalledOnce();
    expect(store.messages.get(session.id)?.at(-1)?.content).toContain("循环已停止");
  });

  it("stops identical requests and enforces the maximum continuation depth", async () => {
    const { session, task } = await start();
    await succeed(task.id);
    answer.mockResolvedValueOnce(follow(task.intent, task.plan.steps[0].tool));
    await chat.runAgentLoop();
    expect(send).toHaveBeenCalledOnce();
    expect(store.messages.get(session.id)?.at(-1)?.content).toContain("重复工具请求");
    const second = await start();
    second.task.chain_depth = 6;
    await succeed(second.task.id);
    answer.mockResolvedValueOnce(follow());
    await chat.runAgentLoop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.messages.get(second.session.id)?.at(-1)?.content).toContain("自动执行上限");
  });

  it("does not advance a deleted session after a delayed model response", async () => {
    const { session, task } = await start();
    await succeed(task.id);
    let release!: (value: unknown) => void;
    answer.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const tick = chat.runAgentLoop();
    await chat.remove(session.id, "tenant-1");
    release(follow());
    await tick;
    expect(send).toHaveBeenCalledOnce();
    expect(store.messages.has(session.id)).toBe(false);
  });
});
