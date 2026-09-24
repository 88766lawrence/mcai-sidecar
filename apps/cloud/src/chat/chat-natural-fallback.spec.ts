import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunStore } from "../agents/agent-run.store";
import { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { TasksService } from "../tasks/tasks.service";
import { ChatService } from "./chat.service";

describe("ChatService safe natural fallback", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-natural-fallback-"));
    process.env.MCAI_CONFIG_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.MCAI_CONFIG_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("streams a normal answer when the agent protocol fails before any tool", async () => {
    const { service, model, tasks } = await fixture({ route: "direct", answer: "我是 MCAI，负责协助管理 Minecraft 服务器。" });
    const session = await service.create("tenant-1", "instance-1");
    const events: unknown[] = [];

    const result = await service.sendStream(session.id, "tenant-1", "你是谁", undefined, (event) => events.push(event));

    expect(result.message).toMatchObject({ route: "direct", content: "我是 MCAI，负责协助管理 Minecraft 服务器。" });
    expect(model.routeStream).toHaveBeenCalledTimes(1);
    expect(tasks.create).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "delta", text: "我是 MCAI，负责协助管理 Minecraft 服务器。" });
  });

  it("emits ordered analysis stages before the initial model decision completes", async () => {
    const { service, model } = await fixture({ route: "direct", answer: "unused" });
    const session = await service.create("tenant-1", "instance-1");
    const events: unknown[] = [];
    let resolveDecision!: (value: {
      status: "answered";
      decision: { action: "final"; answer: string; citations: never[] };
      requestId: string;
    }) => void;
    const pendingDecision = new Promise<Parameters<typeof resolveDecision>[0]>((resolve) => {
      resolveDecision = resolve;
    });
    model.decideAgentLoop.mockImplementation(() => pendingDecision);

    const pendingSend = service.sendStream(session.id, "tenant-1", "你是谁", undefined, (event) => events.push(event));

    await vi.waitFor(() => expect(events).toEqual([
      { type: "status", stage: "understanding", text: "正在理解请求" },
      { type: "status", stage: "routing", text: "正在判断是否需要工具" },
    ]));
    resolveDecision({
      status: "answered",
      decision: { action: "final", answer: "我是 MCAI。", citations: [] },
      requestId: "request-direct",
    });
    await pendingSend;

    expect(events.slice(2)).toEqual([
      { type: "route", route: "direct" },
      { type: "delta", text: "我是 MCAI。" },
    ]);
  });

  it("keeps an operational request closed when the agent protocol fails", async () => {
    const { service, model, tasks } = await fixture({ route: "direct", answer: "服务器已重启。" });
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "重启服务器");

    expect(result.message).toMatchObject({ route: "clarify" });
    expect(result.message.content).toContain("没有调用任何工具");
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
    expect(tasks.create).not.toHaveBeenCalled();
  });

  async function fixture(fallback: { route: "direct"; answer: string }) {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "revision-1", provider_type: "mcsmanager",
      collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      decideAgentLoop: vi.fn().mockResolvedValue({ status: "unavailable", error: "AGENT_LOOP_INVALID_RESPONSE" }),
      route: vi.fn().mockResolvedValue(fallback),
      routeStream: vi.fn().mockImplementation(async (_input, onProgress) => {
        onProgress({ type: "route", route: fallback.route });
        onProgress({ type: "delta", text: fallback.answer });
        return fallback;
      }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const runs = new AgentRunStore(join(directory, "agent-runs.json"));
    const service = new ChatService(store, model, tasks, runs, join(directory, "conversations.json"));
    return { service, model: model as unknown as { decideAgentLoop: ReturnType<typeof vi.fn>; route: ReturnType<typeof vi.fn>; routeStream: ReturnType<typeof vi.fn> }, tasks: tasks as unknown as { create: ReturnType<typeof vi.fn> } };
  }
});
