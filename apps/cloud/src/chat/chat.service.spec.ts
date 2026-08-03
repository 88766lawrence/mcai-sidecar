import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudStore } from "../store/cloud.store";
import { ChatService } from "./chat.service";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import type { TasksService } from "../tasks/tasks.service";

describe("ChatService", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-chat-"));
    process.env.MCAI_CONFIG_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.MCAI_CONFIG_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("creates independent sessions, saves prompts, and keeps direct answers out of the tool queue", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1",
      name: "Survival",
      platform: "paper",
      minecraft_version: "1.21.4",
      state: "running",
      profile_revision: "rev-1",
      provider_type: "mcsmanager",
      collected_at: new Date().toISOString(),
      tenant_id: "tenant-1",
      agent_id: "agent-1",
    });
    const model = {
      route: vi.fn().mockResolvedValue({ route: "direct", answer: "Paper 更适合插件生态。" }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);

    const first = await service.create("tenant-1", "instance-1");
    const second = await service.create("tenant-1", "instance-1", "性能规划");
    await service.update(first.id, "tenant-1", { system_prompt: "回答要简洁，并优先说明风险。" });
    const result = await service.send(first.id, "tenant-1", "Paper 和 Fabric 有什么区别？");

    expect(service.list("tenant-1")).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    expect(result.message).toMatchObject({ role: "assistant", route: "direct" });
    expect(tasks.create).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "conversations.json"), "utf8")).toContain("回答要简洁");
  });

  it("routes plugin inventory and plugin-directory corrections without trusting the model", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const consoleTask = { id: "task-console", state: "SNAPSHOTTING" };
    const filesTask = { id: "task-files", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValueOnce(consoleTask).mockResolvedValueOnce(filesTask),
      get: vi.fn().mockImplementation((id: string) => id === consoleTask.id ? consoleTask : filesTask),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const inventory = await service.send(session.id, "tenant-1", "查看服务器插件有哪些");
    const directoryResult = await service.send(session.id, "tenant-1", "我说插件目录");

    expect(inventory.message).toMatchObject({ route: "tool", task_id: "task-console" });
    expect(directoryResult.message).toMatchObject({ route: "tool", task_id: "task-files" });
    expect(tasks.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ intent: "查看服务器插件有哪些" }));
    expect(tasks.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      intent: expect.stringContaining("/plugins"),
      preferredTool: "files.list",
    }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("passes a short health request through the model planning pipeline", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1",
    });
    const model = { route: vi.fn().mockResolvedValue({
      route: "tool",
      answer: "正在执行只读健康检查。",
      toolIntent: "对当前实例完成一次只读健康检查：执行 version、plugins 并读取最近日志，等待真实回调后总结。",
      preferredTool: "logs.query",
    }) } as unknown as ModelGatewayService;
    const task = { id: "task-health", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "看看服务器有没有问题");

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-health" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.stringContaining("执行 version"),
      preferredTool: "logs.query",
    }));
    expect(model.route).toHaveBeenCalledOnce();
  });

  it("appends one final answer when message polls overlap after a terminal tool callback", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      route: vi.fn().mockResolvedValue({ route: "tool", answer: "正在查询实例目录。", toolIntent: "列出根目录文件" }),
    } as unknown as ModelGatewayService;
    const task = { id: "task-1", state: "SUCCEEDED" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
      complete: vi.fn().mockImplementation(async () => {
        await gate;
        return { answer: "根目录包含 paper.jar。", status: "answered" };
      }),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    await service.send(session.id, "tenant-1", "根目录有什么文件？");
    const firstPoll = service.messages(session.id, "tenant-1");
    const overlappingPoll = service.messages(session.id, "tenant-1");
    release();
    const [once, twice] = await Promise.all([firstPoll, overlappingPoll]);

    expect(once.at(-1)).toMatchObject({ task_id: "task-1", task_phase: "completion", content: "根目录包含 paper.jar。" });
    expect(twice.filter((message) => message.task_phase === "completion")).toHaveLength(1);
    expect(tasks.complete).toHaveBeenCalledTimes(1);
  });

  it("creates one bounded follow-up task when completion returns a controlled continuation", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      route: vi.fn().mockResolvedValue({ route: "tool", answer: "正在安装插件。", toolIntent: "安装 EssentialsX", preferredTool: "plugin.install" }),
    } as unknown as ModelGatewayService;
    const firstTask = { id: "task-install", state: "SUCCEEDED", chain_depth: 0, plan: { steps: [{ tool: "plugin.install" }] } };
    const verificationTask = { id: "task-verify", state: "SNAPSHOTTING", chain_depth: 1, plan: { steps: [{ tool: "files.list" }] } };
    const tasks = {
      create: vi.fn()
        .mockResolvedValueOnce(firstTask)
        .mockResolvedValueOnce(verificationTask),
      get: vi.fn().mockImplementation((id: string) => id === firstTask.id ? firstTask : verificationTask),
      complete: vi.fn().mockImplementation(async (taskId: string) => taskId === firstTask.id ? ({
          answer: "插件任务缺少实际落盘证据，正在继续核验。",
          status: "answered",
          continuation: {
            intent: "列出当前实例 /plugins 目录并确认目标插件 JAR 是否实际落盘",
            preferred_tool: "files.list",
            answer: "正在继续读取 /plugins 目录核验。",
            request_id: "model-follow-up",
          },
        }) : undefined),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    await service.send(session.id, "tenant-1", "帮我安装 EssentialsX");
    const messages = await service.messages(session.id, "tenant-1");
    await service.messages(session.id, "tenant-1");

    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(tasks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      parentTaskId: "task-install",
      chainDepth: 1,
      preferredTool: "files.list",
      sessionId: session.id,
    }));
    expect(messages.at(-1)).toMatchObject({ task_id: "task-verify", task_phase: "request", route: "tool" });
  });

  it("streams direct answer deltas and persists one complete assistant message", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      routeStream: vi.fn().mockImplementation(async (_input, onProgress) => {
        onProgress({ type: "delta", text: "服务器" });
        onProgress({ type: "delta", text: "正在运行。" });
        return { route: "direct", answer: "服务器正在运行。" };
      }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const progress: Array<{ type: string; text?: string }> = [];

    const result = await service.sendStream(session.id, "tenant-1", "Paper 和 Fabric 有什么区别？", undefined, (event) => progress.push(event));
    const messages = await service.messages(session.id, "tenant-1");

    expect(progress).toEqual([
      { type: "delta", text: "服务器" },
      { type: "delta", text: "正在运行。" },
    ]);
    expect(result.message).toMatchObject({ role: "assistant", content: "服务器正在运行。", route: "direct" });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it("coalesces concurrent sends with the same request id", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = {
      route: vi.fn().mockImplementation(async () => {
        await gate;
        return { route: "direct", answer: "Only one answer" };
      }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const first = service.send(session.id, "tenant-1", "status", "request_12345678");
    const duplicate = service.send(session.id, "tenant-1", "status", "request_12345678");
    release();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    const messages = await service.messages(session.id, "tenant-1");

    expect(firstResult.message.id).toBe(duplicateResult.message.id);
    expect(model.route).toHaveBeenCalledTimes(1);
    expect(messages.filter((message) => message.request_id === "request_12345678")).toHaveLength(2);
  });

  it("returns the persisted answer when a completed request is retried", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      route: vi.fn().mockResolvedValue({ route: "direct", answer: "Only one answer" }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const first = await service.send(session.id, "tenant-1", "status", "request_12345678");
    const retry = await service.send(session.id, "tenant-1", "status", "request_12345678");

    expect(retry.message.id).toBe(first.message.id);
    expect(model.route).toHaveBeenCalledTimes(1);
  });

  it("routes an explicit console command immediately without waiting for the model", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-console", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "console command list");

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-console" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      instanceRef: "instance-1",
      intent: "console command list",
    }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("routes a natural-language player query to the console without waiting for the model", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-console", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(
      session.id,
      "tenant-1",
      "\u5e2e\u6211\u770b\u770b\u73b0\u5728\u6709\u591a\u5c11\u73a9\u5bb6\u5728\u7ebf",
    );

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-console" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.stringContaining("\u73a9\u5bb6") }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("routes a real-time log diagnosis without waiting for the model", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-logs", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const intent = "读取这台服务器最近一小时的日志，分析刚才崩服的原因。";
    const result = await service.send(session.id, "tenant-1", intent);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-logs" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent }));
    expect(model.route).not.toHaveBeenCalled();
  });
});
