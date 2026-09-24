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

  it("asks the AI for a strict tool decision before legacy deterministic routing", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-ai", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      decideAgentLoop: vi.fn().mockResolvedValue({
        status: "answered", requestId: "ai-loop-1",
        decision: { action: "tool_call", tool: "files.list", arguments: { path: "/plugins", suffix: ".jar" }, reason: "读取实际目录" },
      }),
      route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const task = { id: "task-ai", state: "SNAPSHOTTING", evidence: [] };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "列出插件目录里的jar并计数");
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-ai" });
    expect(model.decideAgentLoop).toHaveBeenCalledTimes(1);
    expect(model.route).not.toHaveBeenCalled();
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      agentToolCall: expect.objectContaining({ tool: "files.list", arguments: { path: "/plugins", suffix: ".jar" } }),
    }));
  });

  it("routes an explicit multi-key configuration query to config.inspect without consulting the model", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "stopped", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-config", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "Show motd and online-mode from staging/paper.conf without changing anything.");

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-config" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      intent: "Show motd and online-mode from staging/paper.conf without changing anything.",
      preferredTool: "config.inspect",
    }));
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
  });

  it("routes plugin metadata research to plugin.resolve without consulting the model", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "purpur", minecraft_version: "1.20.4",
      state: "running", profile_revision: "rev-plugin", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-plugin-read", state: "SNAPSHOTTING" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "禁止下载与部署，只核对 ViaVersion 对 Purpur 1.20.4 的兼容性，并报告可信来源和哈希。";

    const result = await service.send(session.id, "tenant-1", intent);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-plugin-read" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: "plugin.resolve" }));
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
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
      intent: "我说插件目录",
      preferredTool: "files.list",
    }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it.each([
    "告诉我当前节点实际跑的服务端发行版和 Minecraft 版本",
    "Which runtime implementation and MC build is this bound server using?",
    "核对这台服的内核、build 与游戏版本",
  ])("creates an audited read task for current runtime identity instead of trusting a direct model answer: %s", async (intent) => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn().mockResolvedValue({ route: "direct", answer: "Paper / 1.21.1" }) } as unknown as ModelGatewayService;
    const task = { id: "task-version", state: "SNAPSHOTTING", evidence: [] };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", intent);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-version" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent }));
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
      intent: "看看服务器有没有问题",
      preferredTool: "logs.query",
    }));
    expect(model.route).toHaveBeenCalledOnce();
  });

  it("creates a deterministic topic-scoped log task without waiting for a slow model route", async () => {
    const entryLogs: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((value) => entryLogs.push(String(value)));
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      route: vi.fn(() => new Promise(() => undefined)),
      routeStream: vi.fn(() => new Promise(() => undefined)),
    } as unknown as ModelGatewayService;
    const task = { id: "task-log-topic", state: "SNAPSHOTTING", evidence: [] };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "Scan the prior 90 minutes of logs for member login refusals or timeouts, then state whether the connection looks unhealthy.";

    const result = await Promise.race([
      service.send(session.id, "tenant-1", intent, "request_log_topic_01"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deterministic log route timed out")), 1000)),
    ]);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-log-topic" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: "logs.query" }));
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
    const metrics = entryLogs.map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "mcai_chat_entry_stage", stage: "route_selected", route_source: "explicit_legacy_compatibility", model_calls: 0, deterministic_capability: "logs.query" }),
      expect.objectContaining({ event: "mcai_chat_entry_stage", stage: "task_persisted", task_created: true }),
      expect.objectContaining({ event: "mcai_chat_entry_stage", stage: "request_completed", route: "tool" }),
    ]));
    expect(entryLogs.join("\n")).not.toContain(intent);
    info.mockRestore();
  });

  it("creates two distinct deterministic log tasks in one session without model routing", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const tasks = {
      create: vi.fn()
        .mockResolvedValueOnce({ id: "task-log-first", state: "SNAPSHOTTING", evidence: [] })
        .mockResolvedValueOnce({ id: "task-log-second", state: "SNAPSHOTTING", evidence: [] }),
      get: vi.fn().mockImplementation((id: string) => ({ id, state: "SNAPSHOTTING", evidence: [] })),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const first = await service.send(session.id, "tenant-1", "Review the last 15 minutes of logs for permission denials.", "request_log_first1");
    const second = await service.send(session.id, "tenant-1", "Scan recent logs for proxy handshake errors and disconnects.", "request_log_second");

    expect(first.message.task_id).toBe("task-log-first");
    expect(second.message.task_id).toBe("task-log-second");
    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
  });

  it("coalesces a streamed deterministic log retry without creating or executing twice", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = { id: "task-log-retry", state: "SNAPSHOTTING", evidence: [] };
    const tasks = {
      create: vi.fn().mockImplementation(async () => { await gate; return task; }),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const model = { route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "Inspect the previous hour of logs for authentication failures.";

    const streamed = service.sendStream(session.id, "tenant-1", intent, "request_log_retry1", () => undefined);
    const retry = service.send(session.id, "tenant-1", intent, "request_log_retry1");
    release();
    const [first, second] = await Promise.all([streamed, retry]);

    expect(first.message.id).toBe(second.message.id);
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
  });

  it("does not downgrade a short service-abnormality check to logs only", async () => {
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
      trace: [{ stage: "planning", label: "目标已细化", result: "补全三项只读检查" }],
    }) } as unknown as ModelGatewayService;
    const task = { id: "task-health-abnormal", state: "SNAPSHOTTING" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "查看服务是否有异常");

    expect(result.message).toMatchObject({
      route: "tool",
      task_id: "task-health-abnormal",
      trace: [expect.objectContaining({ stage: "planning" })],
    });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      intent: "查看服务是否有异常",
      preferredTool: "logs.query",
    }));
    expect(model.route).toHaveBeenCalledOnce();
  });

  it("appends one final answer in the background while overlapping GETs stay read-only", async () => {
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
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");

    await service.send(session.id, "tenant-1", "根目录有什么文件？");
    const firstPoll = service.messages(session.id, "tenant-1");
    const overlappingPoll = service.messages(session.id, "tenant-1");
    release();
    await Promise.all([firstPoll, overlappingPoll]);
    await vi.waitFor(async () => expect((await service.messages(session.id, "tenant-1")).filter((message) => message.task_phase === "completion")).toHaveLength(1));
    const [once, twice] = await Promise.all([service.messages(session.id, "tenant-1"), service.messages(session.id, "tenant-1")]);

    expect(once.at(-1)).toMatchObject({ task_id: "task-1", task_phase: "completion", content: "根目录包含 paper.jar。" });
    expect(twice.filter((message) => message.task_phase === "completion")).toHaveLength(1);
    expect(tasks.complete).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
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
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");

    await service.send(session.id, "tenant-1", "帮我安装 EssentialsX");
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledTimes(2));
    const messages = await service.messages(session.id, "tenant-1");

    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(tasks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      parentTaskId: "task-install",
      chainDepth: 1,
      preferredTool: "files.list",
      sessionId: session.id,
    }));
    expect(messages.at(-1)).toMatchObject({ task_id: "task-verify", task_phase: "request", route: "tool" });
    await service.onModuleDestroy();
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
      { type: "status", stage: "understanding", text: "正在理解请求" },
      { type: "status", stage: "routing", text: "正在判断是否需要工具" },
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

  it("routes a scoped broadcast as a confirmation task without treating message text as lifecycle intent", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-broadcast", state: "WAITING_CONFIRMATION" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "Announce 'The server will restart tomorrow' on this console, nothing else";

    const result = await service.send(session.id, "tenant-1", intent);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-broadcast" });
    expect(result.message.content).toContain("等待确认");
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", instanceRef: "instance-1", intent,
    }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("routes an actionbar write before the online-player roster read shortcut", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-actionbar", state: "WAITING_CONFIRMATION" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "在所有在线成员的快捷栏显示“请准备进入下一回合”，不要修改游戏规则";

    const result = await service.send(session.id, "tenant-1", intent);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-actionbar" });
    expect(result.message.content).toContain("等待确认");
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", instanceRef: "instance-1", intent,
    }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("routes a bounded transient player effect to confirmation without a model call", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-transient-effect", state: "WAITING_CONFIRMATION", evidence: [] };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "Show exactly five happy villager particles once beside every connected player and change no settings.";

    const result = await service.send(session.id, "tenant-1", intent);

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-transient-effect" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, instanceRef: "instance-1" }));
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

  it("fails closed when the model returns direct for an unknown write goal", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn().mockResolvedValue({ route: "direct", answer: "出生点已经设置完成。" }) } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "把世界出生点重新设置一下");

    expect(result.message.route).toBe("clarify");
    expect(result.message.content).toContain("没有执行");
    expect(result.message.content).not.toContain("已经设置完成");
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it("resets unsafe streamed success text before returning the guarded answer", async () => {
    const { store } = chatFixture();
    const model = {
      routeStream: vi.fn().mockImplementation(async (_input, onProgress) => {
        onProgress({ type: "delta", text: "配置已经修改完成。" });
        return { route: "direct", answer: "配置已经修改完成。" };
      }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const progress: Array<{ type: string; text?: string }> = [];

    const result = await service.sendStream(session.id, "tenant-1", "请修改当前插件的配置", undefined, (event) => progress.push(event));

    expect(progress).toEqual([
      { type: "status", stage: "understanding", text: "正在理解请求" },
      { type: "status", stage: "routing", text: "正在判断是否需要工具" },
      { type: "delta", text: "配置已经修改完成。" },
      { type: "reset" },
      { type: "delta", text: expect.stringContaining("没有执行") },
    ]);
    expect(result.message.route).toBe("clarify");
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it("routes a catalog operation directly to a controlled task in English", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-whitelist", state: "WAITING_CONFIRMATION" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "turn the whitelist on for this server");

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-whitelist" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.stringContaining("whitelist") }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("replaces a model execution claim with the authoritative WAITING task answer", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn().mockResolvedValue({
      route: "tool", answer: "已经开始执行并即将完成。", toolIntent: "修复未说明的子系统",
    }) } as unknown as ModelGatewayService;
    const task = {
      id: "task-waiting", state: "WAITING",
      assistant_response: "计划尚未覆盖全部目标，未执行。需要先明确目标。",
    };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "修复我说的那个问题");

    expect(result.message).toMatchObject({ route: "tool", task_id: "task-waiting", content: expect.stringContaining("未执行") });
    expect(result.message.content).not.toContain("即将完成");
  });
  it("never presents a direct model execution claim as completed without a task or tool evidence", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn().mockResolvedValue({ route: "direct", answer: "LuckPerms 已下载、校验并安装完成，文件已经落盘。Agent 也触发了重启。" }) } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "概括上一条回答");
    expect(result.message).toMatchObject({ route: "direct", content: "我还没有执行，无法确认操作已经完成。" });
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it("answers a short evidence challenge from session context without a model call or new task", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn().mockResolvedValue({ route: "direct", answer: "插件已经安装完成并落盘。" }) } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    await service.send(session.id, "tenant-1", "LuckPerms 插件是什么？");
    const result = await service.send(session.id, "tenant-1", "确定吗");
    expect(result.message).toMatchObject({ route: "direct", content: "不能确定。上一条没有实际工具执行记录，因此无法证明插件已安装或文件已落盘。" });
    expect(model.route).toHaveBeenCalledTimes(1);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it("confirms a short follow-up only when the recent succeeded task has matching real evidence", async () => {
    const { store } = chatFixture();
    const task = {
      id: "task-evidenced", state: "SUCCEEDED", evidence: [{ kind: "console", summary: "控制台确认当前难度为 easy", at: new Date().toISOString(), result: "match", tool_calls: 1 }],
      plan: { operation: { execution_evidence: [{ kind: "console" }], verification_evidence: [] } },
    };
    const model = { route: vi.fn().mockResolvedValue({ route: "tool", answer: "正在查询。", toolIntent: "查询当前难度" }) } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    await service.send(session.id, "tenant-1", "查询当前难度");
    const result = await service.send(session.id, "tenant-1", "真的么");
    expect(result.message.content).toContain("可以确认");
    expect(result.message.content).toContain("控制台确认当前难度为 easy");
    expect(model.route).not.toHaveBeenCalled();
    expect(tasks.create).toHaveBeenCalledTimes(1);
  });

  it("maps internal compiler terminology to a user-safe answer", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn().mockResolvedValue({ route: "direct", answer: "INTENT_COMPILER_PARSE_ERROR: typed intent compiler is unavailable" }) } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "帮我理解这个结果");
    expect(result.message.content).toBe("我暂时没能理解这条请求，因此没有执行任何操作。请把要做的事说完整一些。");
    expect(result.message.content).not.toMatch(/INTENT_COMPILER|typed intent compiler|gateway|schema|digest/i);
  });

  it("creates one no-restart plugin confirmation preview without routing through a direct answer", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-plugin-preview", state: "WAITING_CONFIRMATION", evidence: [], assistant_response: "计划已准备，等待你确认后才会执行。" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "帮我下载并安装 LuckPerms 插件，不要重启服务器；安装后确认文件已经落盘。";
    const result = await service.send(session.id, "tenant-1", intent);
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-plugin-preview", content: expect.stringContaining("等待确认") });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: "plugin.install" }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it.each([
    "把当前生存服务器开起来，只操作这个实例，别重启或停服",
    "Start this bound game instance only; do not reboot or shut it down",
    "这台联机服还离线，只让它启动，关闭与重开都不允许",
    "Do not shut down or reboot; bring this game host online",
    "当前服务仍处于停止状态；将它恢复为在线，关机与重启均排除",
    "This host remains offline. Transition it to running; shutdown and reboot are outside scope.",
  ])("routes lifecycle intent to instance.start before console planning: %s", async (intent) => {
    const { store } = chatFixture();
    store.instances.get("instance-1")!.state = "stopped";
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-start-preview", state: "WAITING_CONFIRMATION", evidence: [], assistant_response: "启动计划已准备，等待你确认后执行。" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", intent);
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-start-preview" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, instanceRef: "instance-1", preferredTool: "instance.start" }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it.each([
    "看看当前联机服有多少成员在线",
    "Who is online on this bound server?",
    "If somebody is connected, read only the first connected member's current game mode; if nobody is present, simply report that branch.",
    "不要重启这台服务，只列出在线成员",
  ])("routes online-player reads to a read-only tool instead of lifecycle clarification: %s", async (intent) => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-player-read", state: "RUNNING", evidence: [], assistant_response: "正在查询在线玩家。" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", intent);
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-player-read" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: undefined }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it.each([
    "Could you report RAM consumption together with the current tick rate?",
    "先报内存用了多少，再看一下TPS",
    "这台实例性能怎么样？读取MSPT和memory usage",
  ])("routes explicit runtime metrics to the deterministic read planner: %s", async (intent) => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-performance-read", state: "RUNNING", evidence: [], assistant_response: "正在读取性能指标。" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", intent);
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-performance-read" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: undefined }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it.each([
    "只核对 gamerule doWeatherCycle 现在的值，不要修改规则",
    "Check the current value of gamerule doInsomnia; do not change any rule.",
  ])("routes a gamerule getter without a model call: %s", async (intent) => {
    const { store } = chatFixture();
    const model = { route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-gamerule-read", state: "RUNNING", evidence: [], assistant_response: "正在读取游戏规则。" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", intent);
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-gamerule-read" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: "console.command" }));
    expect(model.route).not.toHaveBeenCalled();
    expect(model.routeStream).not.toHaveBeenCalled();
  });

  it("routes a generic directory filter/count request without asking the model to choose a tool", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const task = { id: "task-filesystem-read", state: "RUNNING", evidence: [], assistant_response: "正在读取目录。" };
    const tasks = { create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task) } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const intent = "Within the snapshots folder, list all NBT files and report how many matched.";
    const result = await service.send(session.id, "tenant-1", intent);
    expect(result.message).toMatchObject({ route: "tool", task_id: "task-filesystem-read" });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ intent, preferredTool: "files.list" }));
    expect(model.route).not.toHaveBeenCalled();
  });

  it("clarifies an ambiguous lifecycle action without model or console fallback", async () => {
    const { store } = chatFixture();
    store.instances.get("instance-1")!.state = "stopped";
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "启动或重启当前游戏节点");
    expect(result.message).toMatchObject({ route: "clarify", task_id: undefined });
    expect(tasks.create).not.toHaveBeenCalled();
    expect(model.route).not.toHaveBeenCalled();
  });

  it("answers an already-running start request idempotently without creating a task", async () => {
    const { store } = chatFixture();
    const model = { route: vi.fn() } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "请把这台服务器启动起来");
    expect(result.message).toMatchObject({ route: "direct", content: "当前实例本来就在运行，无需再次启动。" });
    expect(tasks.create).not.toHaveBeenCalled();
    expect(model.route).not.toHaveBeenCalled();
  });
});

function chatFixture() {
  const store = new CloudStore();
  store.instances.set("instance-1", {
    instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
    state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
    tenant_id: "tenant-1", agent_id: "agent-1",
  });
  return { store };
}
