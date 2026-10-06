import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunStore } from "../agents/agent-run.store";
import { CloudStore } from "../store/cloud.store";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import type { TasksService } from "../tasks/tasks.service";
import { ChatService } from "./chat.service";
import type { AgentLoopDecision, AgentLoopObservation } from "./agent-loop";

describe("agent loop recovery effects", () => {
  const directories: string[] = [];
  const services: ChatService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("lets the AI correct parameters after a non-retryable tool error", async () => {
    const result = await scenario(
      failed("PATH_NOT_FOUND", false),
      { action: "tool_call", tool: "files.list", arguments: { path: "/world/advancements" }, reason: "Try the correct safe directory." },
    );
    expect(result.tasks.create).toHaveBeenCalledTimes(2);
    expect(result.tasks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      agentToolCall: expect.objectContaining({ tool: "files.list", arguments: { path: "/world/advancements" } }),
    }));
  });

  it("lets the AI switch tools after a non-retryable provider result", async () => {
    const result = await scenario(
      failed("UNSUPPORTED_QUERY", false),
      { action: "tool_call", tool: "console.command", arguments: { command: "list" }, reason: "Use the canonical online-player read." },
    );
    expect(result.tasks.create).toHaveBeenCalledTimes(2);
    expect(result.tasks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      agentToolCall: expect.objectContaining({ tool: "console.command", arguments: { command: "list" } }),
    }));
    expect(result.tasks.complete).not.toHaveBeenCalled();
  });

  it("lets the AI end honestly without another dispatch when no safe recovery exists", async () => {
    const result = await scenario(
      failed("PERMISSION_DENIED", false),
      { action: "cannot_proceed", answer: "当前权限不足，未执行任何更改。" },
    );
    expect(result.tasks.create).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await result.service.messages(result.sessionId, "tenant-1")).at(-1)).toMatchObject({
      task_phase: "completion", content: "当前权限不足，未执行任何更改。",
    }));
  });

  it("keeps cannot_proceed authoritative after an auxiliary recovery tool succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-mixed-terminal-"));
    directories.push(directory);
    const cloud = new CloudStore();
    cloud.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "stopped",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const failedObservation: AgentLoopObservation = {
      tool_call_id: "", tool: "config.inspect", status: "failed", retryable: false, side_effect: "none",
      error: { code: "PROVIDER_HTTP_500", message: "面板返回 HTTP 500，配置读取失败。" },
      evidence: { ids: ["e1"], summaries: ["工具返回错误：panel returned HTTP 500"] },
    };
    const succeededObservation: AgentLoopObservation = {
      tool_call_id: "", tool: "files.list", status: "succeeded", retryable: false, side_effect: "none",
      evidence: { ids: ["e2"], summaries: ["实例目录 .：共 1 项；匹配 1 项：server.properties"] },
    };
    const records = new Map<string, { id: string; state: string; evidence: unknown[]; plan: { agent_execution: { tool_call_id: string } } }>();
    let createIndex = 0;
    const tasks = {
      create: vi.fn(async (input: { agentToolCall: { toolCallId: string } }) => {
        const first = createIndex++ === 0;
        const record = {
          id: first ? "task-failed" : "task-succeeded", state: first ? "FAILED" : "SUCCEEDED", evidence: [],
          plan: { agent_execution: { tool_call_id: input.agentToolCall.toolCallId } },
        };
        (first ? failedObservation : succeededObservation).tool_call_id = input.agentToolCall.toolCallId;
        records.set(record.id, record);
        return record;
      }),
      get: vi.fn((id: string) => records.get(id)),
      agentLoopObservation: vi.fn((id: string) => id === "task-failed" ? failedObservation : succeededObservation),
      bindAgentApproval: vi.fn(), complete: vi.fn(),
    } as unknown as TasksService;
    const answer = "无法完成指定配置读取。具体失败原因：面板返回 HTTP 500。";
    const model = { decideAgentLoop: vi.fn()
      .mockResolvedValueOnce({ status: "answered", requestId: "first", decision: {
        action: "tool_call", tool: "config.inspect", arguments: { path: "missing.properties", keys: ["enabled"] }, reason: "Read the requested configuration.",
      } })
      .mockResolvedValueOnce({ status: "answered", requestId: "second", decision: {
        action: "tool_call", tool: "files.list", arguments: { path: ".", suffix: ".properties" }, reason: "Try one bounded recovery.",
      } })
      .mockResolvedValueOnce({ status: "answered", requestId: "terminal", decision: { action: "cannot_proceed", answer } }),
      route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const store = new AgentRunStore(join(directory, "runs.json"));
    const finish = vi.spyOn(store, "finish");
    const service = new ChatService(cloud, model, tasks, store, join(directory, "conversations.json"));
    services.push(service);
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");
    await service.send(session.id, "tenant-1", "Read one requested configuration and stop with the concrete reason if it fails.");
    await vi.waitFor(async () => expect((await service.messages(session.id, "tenant-1")).at(-1)).toMatchObject({
      task_id: "task-failed", task_phase: "completion", content: answer,
    }));
    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith(expect.any(String), "FAILED", expect.objectContaining({ answer }));
  });

  it("projects the concrete failed observation when a repeated recovery call is blocked", async () => {
    const observation: AgentLoopObservation = {
      tool_call_id: "call-initial", tool: "files.list", status: "failed", retryable: false, side_effect: "none",
      error: { code: "TASK_FAILED", message: "The tool could not complete." },
      evidence: { ids: ["e1"], summaries: ["工具返回错误：panel returned HTTP 500"] },
    };
    const result = await scenario(observation, {
      action: "tool_call", tool: "files.list", arguments: { path: "/missing" }, reason: "Repeat the same read.",
    });
    expect(result.tasks.create).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await result.service.messages(result.sessionId, "tenant-1")).at(-1)).toMatchObject({
      task_phase: "completion",
      content: expect.stringMatching(/HTTP 500.*made no changes/iu),
    }));
  });

  it("retries one transient model-decision failure without replaying the completed tool", async () => {
    const result = await scenario(
      succeeded(),
      { action: "final", answer: "当前加载 3 个插件：LuckPerms、ProtocolLib、WorldEdit。", citations: ["call-initial"] },
      true,
    );
    expect(result.tasks.create).toHaveBeenCalledTimes(1);
    expect(result.model.decideAgentLoop).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await result.service.messages(result.sessionId, "tenant-1")).at(-1)).toMatchObject({
      task_phase: "completion", content: "当前加载 3 个插件：LuckPerms、ProtocolLib、WorldEdit。",
    }));
  });

  it("continues a resolved plugin to approval when the model guesses a non-authoritative artifact identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-plugin-binding-effects-"));
    directories.push(directory);
    const cloud = new CloudStore();
    cloud.instances.set("instance-1", {
      instance_id: "instance-1", name: "Test", platform: "paper", minecraft_version: "1.21.1", state: "stopped",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const hash = "ab".repeat(64);
    const observation: AgentLoopObservation = {
      tool_call_id: "call-resolve", tool: "plugin.resolve", status: "succeeded", retryable: false, side_effect: "none",
      data: { task_id: "task-resolve", goal_results: [], observations: [{ kind: "plugin", observed: {
        schema_version: "resolved-plugin/v1", project: "coreprotect", artifact: "CoreProtect-CE-24.0.jar",
        sha256: "", source_sha512: hash,
      } }] }, evidence: { ids: ["e1"], summaries: ["resolved"] },
    };
    const records = new Map<string, { id: string; state: string; evidence: unknown[]; plan: { agent_execution: { tool_call_id: string } } }>();
    let createIndex = 0;
    const tasks = {
      create: vi.fn(async (input: { agentToolCall: { toolCallId: string } }) => {
        const record = {
          id: createIndex++ === 0 ? "task-resolve" : "task-install",
          state: createIndex === 1 ? "SUCCEEDED" : "WAITING_CONFIRMATION",
          evidence: [], plan: { agent_execution: { tool_call_id: input.agentToolCall.toolCallId } },
        };
        if (record.id === "task-resolve") observation.tool_call_id = input.agentToolCall.toolCallId;
        records.set(record.id, record);
        return record;
      }),
      get: vi.fn((id: string) => records.get(id)),
      agentLoopObservation: vi.fn((id: string) => id === "task-resolve" ? observation : undefined),
      bindAgentApproval: vi.fn(),
      complete: vi.fn(),
    } as unknown as TasksService;
    const model = { decideAgentLoop: vi.fn()
      .mockResolvedValueOnce({ status: "answered", requestId: "resolve", decision: {
        action: "tool_call", tool: "plugin.resolve", arguments: {
          project: "CoreProtect", source: "modrinth", platform: "paper", minecraft_version: "1.21.1", loader: "paper",
        }, reason: "Resolve a trusted artifact.",
      } })
      .mockResolvedValueOnce({ status: "answered", requestId: "install", decision: {
        action: "tool_call", tool: "plugin.install", arguments: {
          project: "coreprotect", artifact_ref: "modrinth:coreprotect:24.0",
          expected_integrity: { algorithm: "sha512", value: hash },
        }, reason: "Install the resolved artifact.",
      } }), route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const service = new ChatService(cloud, model, tasks, new AgentRunStore(join(directory, "runs.json")), join(directory, "conversations.json"));
    services.push(service);
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");
    await service.send(session.id, "tenant-1", "Choose and install a trusted compatible plugin without starting the server.");
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledTimes(2));
    expect(tasks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      preferredTool: "plugin.install",
      agentToolCall: expect.objectContaining({ arguments: {
        project: "coreprotect", artifact_ref: "CoreProtect-CE-24.0.jar",
        expected_integrity: { algorithm: "sha512", value: hash },
        source_task_id: "task-resolve", source_call_id: observation.tool_call_id,
      } }),
    }));
    await vi.waitFor(() => expect(tasks.bindAgentApproval).toHaveBeenCalledTimes(2));
    expect(tasks.bindAgentApproval).toHaveBeenLastCalledWith(expect.any(String), "task-install", expect.any(String));
  });

  it("explains a negative plugin resolution when terminal model generation is unavailable", async () => {
    const observation: AgentLoopObservation = {
      tool_call_id: "call-initial", tool: "plugin.resolve", status: "succeeded", retryable: false, side_effect: "none",
      data: { call_arguments: { project: "beta" }, observations: [{ observed: {
        schema_version: "resolved-plugin/v1", resolution: "no-compatible-artifact", project: "beta",
        checked_sources: ["Modrinth", "Hangar"], requested_minecraft_version: "1.21.1",
      } }] }, evidence: { ids: ["e1"], summaries: ["no compatible artifact found"] },
    };
    const result = await scenario(observation, { action: "final", answer: "unused", citations: [] }, false, "安装 Beta", true);
    await vi.waitFor(async () => expect((await result.service.messages(result.sessionId, "tenant-1")).at(-1)).toMatchObject({
      task_phase: "completion", content: expect.stringMatching(/beta：未安装.*Modrinth, Hangar.*1\.21\.1/u),
    }));
    expect(result.tasks.create).toHaveBeenCalledTimes(1);
  });

  it("does not publish unsupported model advice even when it cites a retrieved source", async () => {
    const url = "https://docs.example.org/plugins";
    const observation: AgentLoopObservation = {
      tool_call_id: "call-initial", tool: "web.search", status: "succeeded", retryable: false, side_effect: "none",
      data: { qa0144_read_result: { schema_version: "qa0144-read-result/v1", output_schema_id: "web-search-result/v1", value: {
        schema_version: "web-search-result/v1", provider: "fixture", query: "plugin compatibility", results: [{
          title: "Plugin release docs", url, snippet: "Search snippet", date: "", page: {
            status: "read", url, fetched_at: "2026-10-06T12:00:00Z", sha256: "a".repeat(64),
            passages: ["Check the release notes for the exact supported server version."],
          },
        }],
      } } }, evidence: { ids: ["e-web"], summaries: ["retrieved source"] },
    };
    const result = await scenario(observation, {
      action: "final", answer: `Every plugin is compatible with every version. ${url}`, citations: ["call-initial"],
    }, false, "搜索插件兼容建议");
    await vi.waitFor(async () => {
      const message = (await result.service.messages(result.sessionId, "tenant-1")).at(-1);
      expect(message?.task_phase).toBe("completion");
      expect(message?.content).toContain("Check the release notes for the exact supported server version.");
      expect(message?.content).not.toContain("Every plugin is compatible");
    });
    expect(result.tasks.create).toHaveBeenCalledTimes(1);
  });

  async function scenario(observation: AgentLoopObservation, recovery: AgentLoopDecision, transientUnavailable = false, request = "Find the relevant files safely.", unavailable = false) {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-recovery-effects-"));
    directories.push(directory);
    const cloud = new CloudStore();
    cloud.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "running",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const records = new Map<string, { id: string; state: string; evidence: unknown[]; plan?: { agent_execution?: { tool_call_id: string } } }>();
    const firstTask = { id: "task-1", state: observation.status === "succeeded" ? "SUCCEEDED" : "FAILED", evidence: [{ kind: "provider", summary: observation.error?.message ?? "failed" }] };
    const secondTask = { id: "task-2", state: "SNAPSHOTTING", evidence: [] };
    let createIndex = 0;
    const tasks = {
      create: vi.fn(async (input: { agentToolCall: { toolCallId: string } }) => {
        const task = createIndex++ === 0 ? firstTask : secondTask;
        const record = { ...task, plan: { agent_execution: { tool_call_id: input.agentToolCall.toolCallId } } };
        records.set(record.id, record);
        return record;
      }),
      get: vi.fn((id: string) => records.get(id)),
      agentLoopObservation: vi.fn((id: string) => id === firstTask.id ? observation : undefined),
      bindAgentApproval: vi.fn(),
      complete: vi.fn(),
    } as unknown as TasksService;
    const initial = { decideAgentLoop: vi.fn().mockResolvedValue({
      status: "answered", requestId: "initial", decision: { action: "tool_call", tool: "files.list", arguments: { path: "/missing" }, reason: "Read files." },
    }), route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const path = join(directory, "runs.json");
    const chatPath = join(directory, "conversations.json");
    const first = new ChatService(cloud, initial, tasks, new AgentRunStore(path), chatPath);
    const session = await first.create("tenant-1", "instance-1");
    await first.send(session.id, "tenant-1", request);
    const decideAgentLoop = vi.fn();
    if (transientUnavailable) decideAgentLoop.mockResolvedValueOnce({ status: "unavailable", error: "MODEL_TIMEOUT" });
    decideAgentLoop.mockResolvedValue(unavailable ? { status: "unavailable", error: "AGENT_LOOP_INVALID_RESPONSE" } : { status: "answered", requestId: "recovery", decision: recovery });
    const next = { decideAgentLoop, route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const service = new ChatService(cloud, next, tasks, new AgentRunStore(path), chatPath);
    services.push(service);
    await service.onModuleInit();
    await vi.waitFor(() => expect(next.decideAgentLoop).toHaveBeenCalledTimes(transientUnavailable ? 2 : 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { service, model: next as unknown as { decideAgentLoop: ReturnType<typeof vi.fn> }, tasks: tasks as unknown as { create: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> }, sessionId: session.id };
  }

  function failed(code: string, retryable: boolean): AgentLoopObservation {
    return {
      tool_call_id: "call-initial", tool: "files.list", status: "failed", retryable, side_effect: "none",
      error: { code, message: code === "PERMISSION_DENIED" ? "Access was denied." : "The tool could not complete." },
      evidence: { ids: ["e1"], summaries: ["bounded provider failure"] },
    };
  }

  function succeeded(): AgentLoopObservation {
    return {
      tool_call_id: "call-initial", tool: "console.command", status: "succeeded", retryable: false, side_effect: "none",
      data: { plugins: ["LuckPerms", "ProtocolLib", "WorldEdit"] }, evidence: { ids: ["e1"], summaries: ["3 plugins"] },
    };
  }
});
