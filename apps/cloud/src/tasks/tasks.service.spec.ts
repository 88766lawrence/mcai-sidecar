import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IntentCandidateV2, TaskRecord } from "@mcai/contracts";
import { CloudStore } from "../store/cloud.store";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { TasksService } from "./tasks.service";
import { buildIntentSourceCatalog } from "./intent-ir";

describe("TasksService recovery events", () => {
  it("auto-dispatches a producer-verified staged download and requires both byte-bound callbacks", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const url = "https://unlisted.example/releases/grim.jar";
    const observed = {
      schema_version: "file-download-result/v1", target: "downloads/grim.jar", size_bytes: 42,
      sha256: "a".repeat(64), source_url_sha256: createHash("sha256").update(url).digest("hex"), created: true,
    };
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Download the task artifact.",
      assistantResponse: "Downloading the public resource.", modelStatus: "answered",
      agentToolCall: {
        toolCallId: "call-download", action: "tool_call", tool: "file.download",
        arguments: { url, target: "downloads/grim.jar" }, reason: "Create one inert staged file.",
      },
    });
    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "low" });
    expect(task.plan.operation).toMatchObject({
      action: "write", requires_confirmation: false, recovery: "diagnose",
      execution_evidence: [{ kind: "download" }], verification_evidence: [{ kind: "verification.download" }],
    });
    expect(connections.send).toHaveBeenCalledTimes(1);
    await service.recordAgentEvent({ task_id: task.id, kind: "download", step_id: "s1", tool: "file.download", summary: "created", observed });
    await service.recordAgentEvent({ task_id: task.id, kind: "verification.download", step_id: "s1", tool: "file.download", summary: "verified", observed });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "download complete", tool_calls: 1 });
    expect(service.agentLoopObservation(task.id, "tenant-1")).toMatchObject({
      tool_call_id: "call-download", tool: "file.download", status: "succeeded", side_effect: "applied",
      data: { observations: expect.arrayContaining([
        expect.objectContaining({ kind: "download", observed }),
        expect.objectContaining({ kind: "verification.download", observed }),
      ]) },
    });
  });

  it("fails closed when a download callback is not bound to the requested source URL", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Download the task artifact.",
      assistantResponse: "Downloading.", modelStatus: "answered",
      agentToolCall: { toolCallId: "call-bad-download", action: "tool_call", tool: "file.download", arguments: { url: "https://example.org/a.bin", target: "downloads/a.bin" }, reason: "download" },
    });
    const forged = { schema_version: "file-download-result/v1", target: "downloads/a.bin", size_bytes: 1, sha256: "a".repeat(64), source_url_sha256: "b".repeat(64), created: true };
    await service.recordAgentEvent({ task_id: task.id, kind: "download", step_id: "s1", tool: "file.download", summary: "created", observed: forged });
    await service.recordAgentEvent({ task_id: task.id, kind: "verification.download", step_id: "s1", tool: "file.download", summary: "verified", observed: forged });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "done" });
    expect(service.agentLoopObservation(task.id, "tenant-1")).toMatchObject({ status: "failed" });
  });

  it("bridges an AI-first read call into the existing audited task and observation chain", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Can creatures alter blocks in this world right now?",
      assistantResponse: "Reading the current value.", modelStatus: "answered",
      agentToolCall: { toolCallId: "call-1", action: "tool_call", tool: "console.command", arguments: { command: "gamerule mobGriefing" }, reason: "Read the current rule." },
    });
    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan).toMatchObject({ execution_mode: "agent_direct", source_goals: [], goal_requirements: [] });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "console.command", args: { command: "gamerule mobGriefing" }, risk: "read" })]);
    expect(connections.send).toHaveBeenCalledTimes(1);
    expect(service.agentLoopObservation(task.id, "tenant-1")).toBeUndefined();
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "mobGriefing = true", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(service.agentLoopObservation(task.id, "tenant-1")).toEqual(expect.objectContaining({ tool_call_id: "call-1", tool: "console.command", status: "succeeded" }));
  });

  it("preserves a resolved GitHub artifact as typed agent-loop evidence", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const hash = "ab".repeat(32);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Resolve EssentialsX.",
      assistantResponse: "Resolving the artifact.", modelStatus: "answered",
      agentToolCall: { toolCallId: "call-plugin", action: "tool_call", tool: "plugin.resolve", arguments: { project: "EssentialsX", source: "modrinth", platform: "paper", minecraft_version: "1.21.1", loader: "paper" }, reason: "Resolve one trusted artifact." },
    });
    await service.recordAgentEvent({
      task_id: task.id, kind: "plugin", step_id: "s1", tool: "plugin.resolve", result: "match", tool_calls: 1,
      summary: `Plugin resolve result: project=essentialsx; version=2.22.0; source=github-official; artifact=EssentialsX-2.22.0.jar; compatibility=official-release-train:1.21; sha256=${hash}; source_sha512=`,
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    const observation = service.agentLoopObservation(task.id, "tenant-1");
    expect(observation).toMatchObject({
      status: "succeeded",
      data: { observations: expect.arrayContaining([expect.objectContaining({
        kind: "plugin",
        observed: expect.objectContaining({ project: "essentialsx", artifact: "EssentialsX-2.22.0.jar", sha256: hash }),
      })]) },
    });
  });

  it("accepts an agent-direct callback whose nested parameter keys arrive in a different JSON order", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const groups = [{ all_of: [], any_of: ["out_of_memory", "cannot_keep_up"] }];
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Read recent memory or lag logs.",
      assistantResponse: "Reading logs.", modelStatus: "answered",
      agentToolCall: {
        toolCallId: "call-logs", action: "tool_call", tool: "logs.query",
        arguments: { filter_query: { groups }, max_lines: 200, window_minutes: 45 },
        reason: "Read the bounded log window.",
      },
    });
    await service.recordAgentEvent({
      task_id: task.id, kind: "logs", step_id: "s1", tool: "logs.query", summary: "0 matches", result: "match",
      parameters: (() => {
        const args = task.plan.agent_execution!.arguments as Record<string, any>;
        return { window_minutes: args.window_minutes, filters: args.filters, max_lines: args.max_lines, filter_query: { digest: args.filter_query.digest, groups: args.filter_query.groups, schema_version: args.filter_query.schema_version } };
      })(),
      tool_calls: 1,
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(service.agentLoopObservation(task.id, "tenant-1")).toEqual(expect.objectContaining({ tool_call_id: "call-logs", tool: "logs.query", status: "succeeded" }));
  });

  it("keeps an AI-first medium write behind the existing confirmation boundary", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Make the weather clear.",
      assistantResponse: "The exact change is ready for confirmation.", modelStatus: "answered",
      agentToolCall: { toolCallId: "call-write", action: "tool_call", tool: "console.command", arguments: { command: "weather clear" }, reason: "Apply the requested weather change." },
    });
    expect(task).toMatchObject({ state: "WAITING_CONFIRMATION", risk: "medium" });
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("dispatches an AI-selected bounded file listing without re-entering the legacy semantic compiler", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, {
      compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "List every JAR in /plugins and give me the matching count.",
      assistantResponse: "Reading the directory.", modelStatus: "answered",
      agentToolCall: {
        toolCallId: "call-files", action: "tool_call", tool: "files.list",
        arguments: { path: "/plugins", suffix: ".jar" }, reason: "List matching files and count them.",
      },
    });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "plugins", suffix: ".jar" }, risk: "read" })]);
    expect(task.plan).toMatchObject({ execution_mode: "agent_direct", source_goals: [], goal_requirements: [] });
    expect(task.state).toBe("SNAPSHOTTING");
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("hands an under-grouped top-level log OR to the bounded compiler but keeps a complete single-topic log query deterministic", async () => {
    const cross = fixture();
    const crossCompile = vi.fn().mockResolvedValue({ status: "unavailable", error: "TEST_COMPILER_UNAVAILABLE" });
    const crossService = new TasksService(cross.store, cross.connections, { compileIntent: crossCompile, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const crossTask = await crossService.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Review logs for an unregistered moon drift or an unknown biome fault; count matches and assess impact.", preferredTool: "logs.query", assistantResponse: "checking", modelStatus: "answered" });
    expect(crossCompile).toHaveBeenCalledTimes(1);
    expect(crossTask.state).toBe("WAITING");
    expect(cross.connections.send).not.toHaveBeenCalled();

    const local = fixture();
    const localCompile = vi.fn();
    const localService = new TasksService(local.store, local.connections, { compileIntent: localCompile, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const localTask = await localService.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Check recent timeout records and give the count.", preferredTool: "logs.query", assistantResponse: "checking", modelStatus: "answered" });
    expect(localCompile).not.toHaveBeenCalled();
    expect(localTask.plan.steps).toEqual([expect.objectContaining({ tool: "logs.query", risk: "read" })]);
    expect(local.connections.send).toHaveBeenCalledTimes(1);
  });

  it("routes a registered punctuationless cross-topic OR without depending on the compiler", async () => {
    const cross = fixture();
    const compileIntent = vi.fn().mockResolvedValue({ status: "unavailable", error: "TEST_COMPILER_UNAVAILABLE" });
    const service = new TasksService(cross.store, cross.connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Review recent logs for authentication denied or world chunk corruption; count matches and assess impact.", preferredTool: "logs.query", assistantResponse: "checking", modelStatus: "answered" });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "logs.query", risk: "read" })]);
    expect(task.plan.goal_requirements).toHaveLength(3);
    const domainClauses = task.plan.clause_ledger.filter((clause) => clause.role === "domain_goal");
    expect(domainClauses).toHaveLength(1);
    expect(domainClauses[0]?.source_goal_ids).toHaveLength(3);
    expect(domainClauses[0]?.source_atom_ids).toHaveLength(3);
    expect(task.plan.source_atoms.every((atom) => atom.clause_id === domainClauses[0]?.id)).toBe(true);
    expect(task.state).toBe("SNAPSHOTTING");
    expect(cross.connections.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    "现在测试服有多少人在线，最大能进多少人？只查看，不要改设置。",
  ])("dispatches a complete online count plus capacity read without compiler dependency: %s", async (intent) => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn().mockResolvedValue({ status: "unavailable", error: "TEST_COMPILER_UNAVAILABLE" });
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "checking", modelStatus: "answered" });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(task.state).toBe("SNAPSHOTTING");
    expect(task.plan.coverage).toBe("full");
    expect(task.plan.steps).toEqual([
      expect.objectContaining({ tool: "console.command", args: { command: "list" }, risk: "read" }),
      expect.objectContaining({ tool: "config.inspect", args: { path: "server.properties", keys: ["max-players"] }, risk: "read" }),
    ]);
    expect(task.plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("dispatches registered loaded-plugin inventory without the compiler", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Show the loaded plugin names and total count, read only.", assistantResponse: "checking", modelStatus: "answered" });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "console.command", args: { command: "plugins" }, risk: "read" })]);
    expect(task.plan.goal_requirements).toHaveLength(2);
    const domainClauses = task.plan.clause_ledger.filter((clause) => clause.role === "domain_goal");
    expect(domainClauses).toHaveLength(1);
    expect(domainClauses[0]?.source_goal_ids).toHaveLength(2);
    expect(domainClauses[0]?.source_atom_ids).toHaveLength(2);
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("renders loaded plugin collection and count from one authoritative callback", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "只读列出当前已加载的插件名称，并告诉我总数。", assistantResponse: "checking", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "Server Plugins (3): Spark, ViaVersion, LuckPerms", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(task.goal_results.find((goal) => goal.result_kind === "collection")?.observed).toEqual(["Spark", "ViaVersion", "LuckPerms"]);
    expect(task.goal_results.find((goal) => goal.result_kind === "count")?.observed).toBe(3);
    expect(task.plan.goal_requirements.map((goal) => ({ domain: goal.domain, target: goal.target, result_kind: goal.result_kind }))).toEqual([
      { domain: "plugin", target: "loaded", result_kind: "collection" },
      { domain: "plugin", target: "loaded", result_kind: "count" },
    ]);
    const answer = (await service.complete(task.id, "tenant-1"))?.answer ?? "";
    expect(answer).toContain("当前已加载 3 个插件");
    expect(answer).toContain("ViaVersion");
    expect(answer).not.toContain("[]");
  });

  it.each([
    ["检查最近一小时日志里有没有内存不足或者服务器跟不上运行的报错，告诉我匹配数量，并判断是否需要处理。", 3],
    ["当前服务器加载了哪些插件？请把插件名称和总数一起告诉我，只读查询。", 2],
  ])("keeps every published registered capability domain clause fully reverse mapped: %s", async (intent, goalCount) => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "checking", modelStatus: "answered" });
    const clauses = task.plan.clause_ledger.filter((clause) => clause.role === "domain_goal");
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.source_goal_ids).toHaveLength(goalCount);
    expect(clauses[0]?.source_atom_ids).toHaveLength(goalCount);
    expect(task.plan.source_goals.every((goal) => clauses[0]?.source_goal_ids.includes(goal.id))).toBe(true);
    expect(task.plan.source_atoms.filter((atom) => atom.required).every((atom) => clauses[0]?.source_atom_ids.includes(atom.id))).toBe(true);
    expect(task.plan.clause_ledger.filter((clause) => clause.role === "safety_constraint").every((clause) => clause.source_goal_ids.length === 0 && clause.source_atom_ids.every((id) => task.plan.source_atoms.find((atom) => atom.id === id)?.polarity === "negative"))).toBe(true);
    expect(compileIntent).not.toHaveBeenCalled();
  });

  it("dispatches a validated AI decomposition for online count plus configured capacity", async () => {
    const { store, connections } = fixture();
    const intent = "现在测试服有多少人在线，最大能进多少人？只查看，不要改设置。";
    const catalog = buildIntentSourceCatalog(intent);
    const candidate: IntentCandidateV2 = {
      schema_version: "intent-candidate/v2",
      clauses: [
        { source_refs: [catalog.refs[0].id], role: "domain_goal", polarity: "positive", status: "mapped", reason: "two live facts" },
        { source_refs: [catalog.refs[1].id], role: "safety_constraint", polarity: "negative", status: "mapped", reason: "write forbidden" },
      ],
      goals: [
        { source_refs: [catalog.refs[0].id], clause: 0, domain: "players", entity: "players-online", capability: "players.online", target: "players-online", parameters: { command: "list" }, result_kind: "collection", required: false },
        { source_refs: [catalog.refs[0].id], clause: 0, domain: "players", entity: "players-online", capability: "players.online", target: "players-online", parameters: { command: "list" }, result_kind: "count", depends_on: [0], required: true },
        { source_refs: [catalog.refs[0].id], clause: 0, domain: "config", entity: "server.properties#max-players", capability: "config.inspect", target: "server.properties#max-players", parameters: { path: "server.properties", keys: ["max-players"] }, result_kind: "fact", required: true },
      ],
      scopes: [],
      constraints: [{ source_refs: [catalog.refs[1].id], clause: 1, action: "write", effect: "forbid" }],
      evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    };
    const compileIntent = vi.fn().mockResolvedValue({ status: "answered", candidate, requestId: "req-ai-read", providerModel: "fixture-model" });
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(), recordIntentCompilerTerminal: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "checking", modelStatus: "answered" });
    expect(task.state).toBe("SNAPSHOTTING");
    expect(task.risk).toBe("read");
    expect(task.plan.coverage).toBe("full");
    expect(task.plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "console.command", args: { command: "list" }, risk: "read" }),
      expect.objectContaining({ tool: "config.inspect", args: { path: "server.properties", keys: ["max-players"] }, risk: "read" }),
    ]));
    expect(task.plan.steps).toHaveLength(2);
    expect(task.plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("dispatches one gamerule getter without compiler/confirmation and completes only from the bound callback", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const answer = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer, decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const intent = "请读取 gamerule doTraderSpawning 的当前值，不要修改任何规则";
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, preferredTool: "console.command", assistantResponse: "reading", modelStatus: "answered" });
    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "gamerule doTraderSpawning" }, risk: "read" }]);
    expect(task.plan.goal_requirements).toEqual([expect.objectContaining({ domain: "gamerule", target: "doTraderSpawning", result_kind: "fact" })]);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "控制台返回：\nGamerule doTraderSpawning is currently set to: false\nGamerule read result: rule=doTraderSpawning; value=false", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "done", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results).toEqual([expect.objectContaining({ status: "satisfied", observed: false })]);
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toBe("doTraderSpawning 当前值为 false。");
    expect(answer).not.toHaveBeenCalled();
  });

  it("dispatches one controlled config read and requires every requested key from the callback", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const intent = "Read alpha-mode and cache.limit from config/engine.properties; do not modify the file.";
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, preferredTool: "config.inspect", assistantResponse: "reading", modelStatus: "answered" });

    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "config.inspect", args: { path: "config/engine.properties", keys: ["alpha-mode", "cache.limit"] }, risk: "read" }]);
    expect(task.plan.goal_requirements).toHaveLength(2);
    expect(task.plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "config", step_id: "s1", tool: "config.inspect", summary: "Read config/engine.properties (42 bytes, sha256:0123456789abcdef)\nalpha-mode=true\ncache.limit=128", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "done", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "satisfied", observed: "true" }),
      expect.objectContaining({ status: "satisfied", observed: "128" }),
    ]));

    const incomplete = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, preferredTool: "config.inspect", assistantResponse: "reading", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: incomplete.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: incomplete.id, kind: "config", step_id: "s1", tool: "config.inspect", summary: "Read config/engine.properties (24 bytes, sha256:abcdef0123456789)\nalpha-mode=true\ncache.limit=<MISSING>", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: incomplete.id, state: "SUCCEEDED", kind: "execution", summary: "done", tool_calls: 1 });
    expect(incomplete.state).not.toBe("SUCCEEDED");
    expect(incomplete.goal_statuses).toEqual(expect.arrayContaining([expect.objectContaining({ status: "pending" })]));
  });

  it.each([
    "报告当前服务端实现与 Minecraft 版本",
    "Identify this host's live server platform and MC build",
    "查清眼前实例实际运行的内核、构建号和游戏版本",
  ])("dispatches runtime identity through version without compiler or inventory shortcuts: %s", async (intent) => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "正在读取实时版本。", modelStatus: "answered" });
    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "version" }, risk: "read" }]);
    expect(task.plan.goal_requirements).toHaveLength(1);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("requires both implementation and Minecraft version from the real callback before completing", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Report the current runtime implementation and Minecraft version", assistantResponse: "reading", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "This server is running Paper version 1.21.1-132-main@abcdef (MC: 1.21.1)", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "Executed successfully; not independently verified" });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "satisfied" })]);
    expect(task.goal_results[0].observed).toMatchObject({ platform: "paper", minecraft_version: "1.21.1", build: "1.21.1-132-main@abcdef" });
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("服务端实现：Paper");
    expect(completion?.answer).toContain("Minecraft 版本：1.21.1");
    expect(completion?.answer).not.toMatch(/INTENT_COMPILER|SourceGoal|schema|digest/i);
    expect(task.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "console", step_id: "s1" }),
      expect.objectContaining({ kind: "verification", step_id: "terminal" }),
    ]));

    const incomplete = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Read this instance's actual server implementation and MC version", assistantResponse: "reading", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: incomplete.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: incomplete.id, kind: "console", step_id: "s1", tool: "console.command", summary: "Server platform: Paper", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: incomplete.id, state: "SUCCEEDED", kind: "execution", summary: "done" });
    expect(incomplete.state).not.toBe("SUCCEEDED");
    expect(incomplete.goal_statuses[0].status).not.toBe("satisfied");
  });

  it.each([
    "读一下TPS并告诉我内存用了多少",
    "What is the current RAM usage together with TPS?",
    "先看MSPT，再报这台实例的memory consumption",
    "Give the tick rate together with current heap usage",
    "看一下每秒 ticks，再读这台实例的 RAM 使用量",
  ])("dispatches a deterministic complete performance read without compiler overwrite: %s", async (intent) => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "正在读取性能指标。", modelStatus: "answered" });
    expect(task.state).toBe("SNAPSHOTTING");
    expect(task.risk).toBe("read");
    expect(task.plan.coverage).toBe("full");
    expect(task.plan.steps).toHaveLength(2);
    expect(task.plan.steps.map((step) => step.tool)).toEqual(expect.arrayContaining(["console.command", "instance.metrics"]));
    expect(task.plan.goal_requirements).toHaveLength(2);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("requires distinct real callbacks for TPS and memory before succeeding", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Give memory consumption and TPS", assistantResponse: "reading", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "metrics", summary: "Instance metrics v2: cpu_percent=4.25; memory_bytes=805306368; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "done" });
    expect(task.state).not.toBe("SUCCEEDED");
    expect(task.goal_statuses.filter((goal) => goal.status === "satisfied")).toHaveLength(1);

    const second = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Give memory consumption and TPS", assistantResponse: "reading", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: second.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: second.id, kind: "metrics", summary: "Instance metrics v2: cpu_percent=4.25; memory_bytes=805306368; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1" });
    await service.recordAgentEvent({ task_id: second.id, kind: "console", summary: "TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0" });
    await service.recordAgentEvent({ task_id: second.id, state: "SUCCEEDED", kind: "execution", summary: "done" });
    expect(second.state).toBe("SUCCEEDED");
    expect(second.goal_results.map((goal) => goal.observed)).toEqual(expect.arrayContaining([805306368, 19.98]));
  });

  it("completes CPU, memory and pressure only from one complete authoritative metrics callback", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Report process memory and CPU, then assess whether resource pressure is high.",
      assistantResponse: "正在读取实例资源。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "instance.metrics", args: { schema_version: "instance-metrics/v2", metrics: ["cpu", "memory"], include_capacity: true }, risk: "read" }]);
    expect(task.plan.goal_requirements).toHaveLength(3);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "metrics", step_id: "s1", tool: "instance.metrics", result: "match", tool_calls: 1,
      summary: "Instance metrics v2: cpu_percent=21.50; memory_bytes=1073741824; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses.every((goal) => goal.status === "satisfied")).toBe(true);
    expect(task.goal_results.map((goal) => goal.observed)).toEqual(expect.arrayContaining([21.5, 1073741824, false]));
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("CPU usage is 21.50%");
    const memoryGoal = task.plan.goal_requirements.find((goal) => goal.target === "memory");
    expect(task.goal_results.find((goal) => goal.goal_id === memoryGoal?.id)?.capacity).toBe(2147483648);
    expect(completion?.answer).toContain("Memory usage is 1.00 GiB out of 2.00 GiB total");
    expect(completion?.answer).toContain("resource pressure is below the high threshold");
    expect(completion?.answer).not.toMatch(/metrics|verification|SourceGoal|Clause|schema|digest|provider|gateway|compiler/i);
  });

  it.each([
    "查查当前游戏服在线成员有几位",
    "List who is online on this bound server",
    "不要重启服务，只统计在线玩家人数",
  ])("dispatches a deterministic player read without the semantic compiler: %s", async (intent) => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent,
      assistantResponse: "正在查询在线玩家。", modelStatus: "answered",
    });
    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "list" }, risk: "read" }]);
    expect(task.plan.operation).toMatchObject({ capability: "console.command", action: "read", risk: "read", requires_confirmation: false });
    expect(task.plan.clause_ledger.some((clause) => clause.role === "domain_goal" && clause.source_goal_ids.length > 0)).toBe(true);
    expect(task.plan.clause_ledger.some((clause) => clause.role === "unknown_business_goal")).toBe(false);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("dispatches a bounded conditional player inspection without waiting on the semantic compiler", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn(() => new Promise(() => undefined));
    const service = new TasksService(store, connections, {
      compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await Promise.race([
      service.create({
        tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
        intent: "If someone is connected, inspect only the first connected member's current game mode; otherwise report the empty branch.",
        assistantResponse: "Reading the conditional player fact.", modelStatus: "answered",
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("conditional player planning waited for compiler")), 250)),
    ]);
    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "players.inspect", args: { schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] }, risk: "read" }]);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("converges a player read from its real console callback and the Agent terminal success event", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "0 players are online." }),
      decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Count the members currently online on this game host",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "console", step_id: "s1", tool: "console.command",
      summary: "There are 0 of a max of 20 players online:", result: "match", tool_calls: 1,
    });
    await service.recordAgentEvent({
      task_id: task.id, state: "SUCCEEDED", kind: "execution",
      summary: "Executed successfully; not independently verified",
    });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "satisfied" })]);
    expect(task.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "console", step_id: "s1", result: "match" }),
      expect.objectContaining({ kind: "verification", step_id: "terminal", result: "match" }),
    ]));
  });

  it("dispatches a whitelist roster and count read without consulting the semantic compiler", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const service = new TasksService(store, connections, {
      compileIntent, proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "保持准入名单原样，帮我列出其中用户并统计总人数。",
      assistantResponse: "正在读取白名单。", modelStatus: "answered",
    });

    expect(task).toMatchObject({ state: "SNAPSHOTTING", risk: "read" });
    expect(task.plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "whitelist list" }, risk: "read" }]);
    expect(task.plan.goal_requirements.filter((goal) => goal.required)).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "access", target: "whitelist", result_kind: "collection", execute_step_ids: ["s1"] }),
      expect.objectContaining({ domain: "access", target: "whitelist", result_kind: "count", execute_step_ids: ["s1"] }),
    ]));
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("creates one canonical instance.start confirmation without compiler, provider, or dispatch", async () => {
    const { store, connections } = fixture();
    store.instances.get("mcs:daemon:instance")!.state = "stopped";
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Power on this bound game server; never reboot or shut it down.", preferredTool: "instance.start",
      assistantResponse: "启动计划已准备，等待确认后执行。", modelStatus: "answered",
    });
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.risk).toBe("medium");
    expect(task.plan.steps).toEqual([{
      id: "s1", tool: "instance.start", args: { target: "mcs:daemon:instance", timeout_seconds: 120 }, risk: "medium", requires_confirmation: true,
    }]);
    expect(task.plan.operation).toMatchObject({ capability: "instance.start", action: "lifecycle", target: "mcs:daemon:instance", requires_confirmation: true });
    expect(task.plan.confirmed_write_proposal).toMatchObject({ tool: "instance.start", target: "mcs:daemon:instance" });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("keeps a suffix-negated lifecycle request on one canonical start step despite a console preference", async () => {
    const { store, connections } = fixture();
    store.instances.get("mcs:daemon:instance")!.state = "stopped";
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "让当前联机服正常运行起来，关机和重启均禁止", preferredTool: "console.command",
      assistantResponse: "计划已准备。", modelStatus: "answered",
    });
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.risk).toBe("medium");
    expect(task.plan.steps).toEqual([{
      id: "s1", tool: "instance.start", args: { target: "mcs:daemon:instance", timeout_seconds: 120 }, risk: "medium", requires_confirmation: true,
    }]);
    expect(task.plan.steps.some((step) => step.tool === "console.command")).toBe(false);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("uses one canonical start confirmation for current-state plus desired-state language", async () => {
    const { store, connections } = fixture();
    store.instances.get("mcs:daemon:instance")!.state = "stopped";
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "当前节点还离线；让它恢复到在线状态，停止与重启都排除", preferredTool: "console.command",
      assistantResponse: "计划已准备。", modelStatus: "answered",
    });
    expect(task).toMatchObject({ state: "WAITING_CONFIRMATION", risk: "medium" });
    expect(task.plan.steps).toEqual([{
      id: "s1", tool: "instance.start", args: { target: "mcs:daemon:instance", timeout_seconds: 120 }, risk: "medium", requires_confirmation: true,
    }]);
    expect(task.plan.steps.some((step) => step.tool === "console.command")).toBe(false);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("keeps ambiguous lifecycle language waiting without compiler, proposal, or dispatch", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Either start or reboot this bound game service", preferredTool: "console.command",
    });
    expect(task.state).toBe("WAITING");
    expect(task.plan.steps).toEqual([]);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("builds a no-restart plugin confirmation plan without invoking the typed compiler or dispatching", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent, proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "帮我下载并安装 LuckPerms 插件，不要重启服务器；安装后确认文件已经落盘。",
      preferredTool: "plugin.install", assistantResponse: "计划已准备，等待确认后执行。", modelStatus: "answered",
    });
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.plan.steps.map((step) => step.tool)).toEqual(["plugin.resolve", "plugin.install", "files.list"]);
    expect(task.plan.steps.filter((step) => step.requires_confirmation)).toHaveLength(1);
    expect(task.plan.steps.some((step) => ["instance.start", "instance.stop", "instance.restart"].includes(step.tool))).toBe(false);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("does not start a second Cloud repair after the provider already used its single bounded repair", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn().mockResolvedValue({
      status: "answered", requestId: "intent-invalid", providerModel: "fixture", repairUsed: true,
      candidate: { schema_version: "intent-candidate/v2", clauses: [], goals: [], scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [] },
    });
    const service = new TasksService(store, connections, { compileIntent, recordIntentCompilerTerminal: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Inspect the current shard and cite evidence." });
    expect(compileIntent).toHaveBeenCalledTimes(1);
    expect(task.state).toBe("WAITING");
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("does not restart the root provider budget after deterministic IR rejection", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn().mockResolvedValue({
      status: "answered", requestId: "intent-invalid", providerModel: "fixture",
      candidate: { schema_version: "intent-candidate/v2", clauses: [], goals: [], scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [] },
    });
    const model = { compileIntent, recordIntentCompilerTerminal: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Inspect a current realm build and cite the callback." });
    expect(compileIntent).toHaveBeenCalledTimes(1);
    expect(task.state).toBe("WAITING");
    expect(task.assistant_response).toContain("没有执行任何操作");
    expect(task.assistant_response).not.toMatch(/INTENT_COMPILER|typed intent compiler|gateway|schema|digest/i);
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("keeps a task active while the Agent retries and only completes after verification succeeds", async () => {
    const store = new CloudStore();
    store.instances.set("mcs:daemon:instance", {
      instance_id: "mcs:daemon:instance",
      name: "Recovery Test",
      platform: "paper",
      minecraft_version: "1.21.1",
      state: "running",
      profile_revision: "rev-1",
      provider_type: "mcsmanager",
      collected_at: new Date().toISOString(),
      tenant_id: "tenant-1",
      agent_id: "agent-1",
    });
    const connections = {
      send: vi.fn().mockReturnValue(true),
    } as unknown as AgentConnectionRegistry;
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "工具重试后已通过验收。" }),
      decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1",
      instanceRef: "mcs:daemon:instance",
      intent: "list files under '/data'",
      assistantResponse: "正在调用文件工具。",
      modelStatus: "answered",
    });

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "diagnosis", summary: "temporary service unavailable" });
    await service.recordAgentEvent({ task_id: task.id, kind: "recovery", summary: "files.list 自动重试（第 2/4 次）" });
    await service.recordAgentEvent({ task_id: task.id, kind: "files", summary: "实例目录 /：paper.jar" });

    expect(task.state).toBe("EXECUTING");
    expect(await service.complete(task.id, "tenant-1")).toBeUndefined();
    expect(model.decideRecovery).not.toHaveBeenCalled();

    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "Checking acceptance" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "Acceptance passed" });

    expect(task.state).toBe("SUCCEEDED");
    await expect(service.complete(task.id, "tenant-1")).resolves.toEqual({
      answer: "工具重试后已通过验收。",
      status: "answered",
    });
    expect(task.evidence.some((item) => item.kind === "recovery")).toBe(true);
  });

  it("refuses a success answer when a terminal task has no real execution evidence", async () => {
    const { store, connections } = fixture();
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "任务已经完成。" }),
      decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "list files",
      assistantResponse: "正在读取。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "Checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "Acceptance passed" });

    const completion = await service.complete(task.id, "tenant-1");

    expect(completion).toMatchObject({ status: "unavailable" });
    expect(completion?.answer).toContain("缺少真实执行结果");
    expect(completion?.answer).not.toMatch(/files|verification|console\.command/i);
    expect(model.answer).not.toHaveBeenCalled();
  });

  it("requires an independent matching readback before confirming a write", async () => {
    const { store, connections } = fixture();
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "难度已设置并复验为 Easy。" }),
      decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "把服务器难度调成简单", assistantResponse: "等待审批。", modelStatus: "answered",
    });
    const confirmation = service.issueConfirmation(task.id, "tenant-1");
    service.confirm(task.id, "tenant-1", confirmation.token);
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "Set difficulty to easy" });
    await service.recordAgentEvent({ task_id: task.id, kind: "verification.console", summary: "The difficulty is Easy" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "Checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "Acceptance passed" });

    await expect(service.complete(task.id, "tenant-1")).resolves.toEqual({
      answer: "难度已设置并复验为 Easy。", status: "answered",
    });
  });

  it("rejects contradictory verification evidence for a write", async () => {
    const { store, connections } = fixture();
    const model = { answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "把服务器难度调成简单", assistantResponse: "等待审批。", modelStatus: "answered",
    });
    const confirmation = service.issueConfirmation(task.id, "tenant-1");
    service.confirm(task.id, "tenant-1", confirmation.token);
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "Set difficulty to easy" });
    await service.recordAgentEvent({ task_id: task.id, kind: "verification.console", summary: "The difficulty is Hard" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "Checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "Acceptance passed" });

    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.status).toBe("unavailable");
    expect(completion?.answer).toContain("结果复核与预期矛盾");
    expect(completion?.answer).not.toMatch(/verification|console\.command|sha256/i);
    expect(completion?.continuation).toMatchObject({ preferred_tool: "console.command" });
  });

  it("does not repeat a model success claim after a failed tool callback", async () => {
    const { store, connections } = fixture();
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "修复已成功完成。" }),
      decideRecovery: vi.fn().mockResolvedValue("只读取日志定位失败原因。"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "读取日志",
      assistantResponse: "正在读取。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, state: "FAILED", kind: "tool", summary: "panel returned HTTP 500" });

    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("panel returned HTTP 500");
    expect(completion?.answer).not.toContain("成功完成");
  });

  it("does not let a model-proposed high-risk continuation replace a deterministic log conclusion", async () => {
    const { store, connections } = fixture();
    const model = {
      answer: vi.fn().mockResolvedValue({
        status: "answered", answer: "只读诊断结束；建议重启，但尚未执行。",
        continuation: {
          route: "tool", answer: "重启需要单独审批。", toolIntent: "重启当前服务器", preferredTool: "instance.restart",
        },
      }),
      decideRecovery: vi.fn().mockResolvedValue("可以提出重启计划，但必须重新审批。"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "诊断最近异常",
      assistantResponse: "正在读取日志。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "logs", summary: "Recent log excerpt: watchdog timeout" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "Checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "Read completed" });
    const completion = await service.complete(task.id, "tenant-1");

    expect(completion?.continuation).toBeUndefined();
    expect(connections.send).toHaveBeenCalledTimes(1);
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "logs.query", risk: "read" })]);
  });

  it.each([
    ["把难度改成困难", "command accepted: difficulty hard", "difficulty is easy", "hard", "easy"],
    ["把游戏规则 doPatrolSpawning 设为 false", "command accepted: gamerule doPatrolSpawning false", "doPatrolSpawning is true", "false", "true"],
    ["把时间改成晚上", "command accepted: time set night", "current time is noon", "night", "noon"],
    ["把 PineBadger 加入白名单", "command accepted: whitelist add PineBadger", "whitelist does not contain PineBadger", "present", "absent"],
  ])("rejects structured contradictory verification facts for %s", async (intent, executionSummary, verificationSummary, expected, observed) => {
    const { store, connections } = fixture();
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "操作成功。" }),
      decideRecovery: vi.fn().mockResolvedValue("仅允许只读复验。"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "等待审批", modelStatus: "answered" });
    const issued = service.issueConfirmation(task.id, "tenant-1");
    await service.confirm(task.id, "tenant-1", issued.token);
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: executionSummary });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "verifying" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "verification.console", summary: verificationSummary,
      expected, observed, result: "contradiction", target: task.plan.operation.target,
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "terminal" });

    const completion = await service.complete(task.id, "tenant-1");
    expect(completion).toMatchObject({ status: "unavailable" });
    expect(completion?.continuation?.preferred_tool).toBe("console.command");
    expect(model.answer).not.toHaveBeenCalled();
  });
});

describe("runtime rejection and watchdog convergence", () => {
  it("converges an Agent validation rejection and ignores a late success", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "version", assistantResponse: "checking", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: task.id, state: "REJECTED", kind: "validation", code: "PLAN_VALIDATION_REJECTED", summary: "readback capability mismatch", provider_calls: 0, tool_calls: 0 });
    expect(task.state).toBe("REJECTED");
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "late" });
    expect(task.state).toBe("REJECTED");
    expect(task.evidence.some((item) => item.kind === "validation")).toBe(true);
  });

  it("uses a fake clock to fail a stuck snapshot and records timeout evidence", async () => {
    let now = Date.parse("2026-08-04T02:00:00.000Z");
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService, {
      now: () => now, stageTimeoutMs: { SNAPSHOTTING: 50 }, watchdogIntervalMs: 0,
    });
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "version", assistantResponse: "checking", modelStatus: "answered" });
    expect(task.state).toBe("SNAPSHOTTING");
    now += 51;
    service.sweepExpiredTasks(now);
    expect(task.state).toBe("FAILED");
    expect(task.evidence.some((item) => item.kind === "timeout")).toBe(true);
  });

  it("refreshes an executing deadline only for task-specific progress", async () => {
    let now = Date.parse("2026-08-04T03:00:00.000Z");
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService, {
      now: () => now, stageTimeoutMs: { SNAPSHOTTING: 50, EXECUTING: 50 }, watchdogIntervalMs: 0,
    });
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "version", assistantResponse: "checking", modelStatus: "answered" });
    now += 40;
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    now += 40;
    await service.recordAgentEvent({ task_id: task.id, kind: "progress", summary: "received a task-specific provider heartbeat" });
    now += 40;
    service.sweepExpiredTasks(now);
    expect(task.state).toBe("EXECUTING");
    now += 11;
    service.sweepExpiredTasks(now);
    expect(task.state).toBe("FAILED");
  });
});

describe("bounded transient player effects", () => {
  it.each([
    ["Ring one bell sound for every connected player and do nothing else.", /^playsound minecraft:block\.note_block\.bell master @a /],
    ["Show five happy villager particles once beside every connected player; do not change configuration.", /^execute if entity @a run execute as @a at @s run particle minecraft:happy_villager /],
  ])("requires one exact medium confirmation before dispatch: %s", async (intent, command) => {
    const { store, connections } = fixture();
    const proposeConfirmedWrite = vi.fn();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "等待确认。", modelStatus: "answered" });
    expect(task).toMatchObject({ state: "WAITING_CONFIRMATION", risk: "medium" });
    expect(task.plan.steps).toHaveLength(1);
    expect(task.plan.steps[0]).toMatchObject({ tool: "console.command", risk: "medium", requires_confirmation: true });
    expect(String(task.plan.steps[0].args.command)).toMatch(command);
    expect(task.plan.steps.some((step) => ["console.command:list", "instance.start", "instance.stop", "instance.restart", "config.patch", "logs.query"].includes(`${step.tool}:${step.args.command ?? ""}`) || ["instance.start", "instance.stop", "instance.restart", "config.patch", "logs.query"].includes(step.tool))).toBe(false);
    expect(connections.send).not.toHaveBeenCalled();
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();

    const issued = service.issueConfirmation(task.id, "tenant-1");
    service.confirm(task.id, "tenant-1", issued.token);
    expect(connections.send).toHaveBeenCalledTimes(1);
    expect(task.plan.confirmed_operation).toMatchObject({ schema_version: "confirmed-operation/v1" });
  });

  it("renders an indeterminate confirmed command failure without backend terminology", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Show five happy villager particles once beside every connected player; do nothing else.", assistantResponse: "Awaiting confirmation.", modelStatus: "answered" });
    const issued = service.issueConfirmation(task.id, "tenant-1");
    service.confirm(task.id, "tenant-1", issued.token);
    await service.recordAgentEvent({ task_id: task.id, state: "FAILED", kind: "execution", summary: "console.command failed: 服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效", tool_calls: 1 });
    const answer = (await service.complete(task.id, "tenant-1"))?.answer ?? "";
    expect(answer).toBe("服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效。");
    expect(answer).not.toMatch(/console\.command|verification|hash|证据门禁/i);
  });
});

function fixture() {
  const store = new CloudStore();
  store.instances.set("mcs:daemon:instance", {
    instance_id: "mcs:daemon:instance", name: "Recovery Test", platform: "paper",
    minecraft_version: "1.21.1", state: "running", profile_revision: "rev-1",
    provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
  });
  const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
  return { store, connections };
}

function bindLogQueryEvidence(task: TaskRecord, summary: string) {
  const step = task.plan.steps.find((item) => item.tool === "logs.query");
  const digest = (step?.args.filter_query as { digest?: string } | undefined)?.digest;
  if (!digest) throw new Error("test plan omitted its structured log query digest");
  return summary.replace("filters=", `query_digest=${digest}; filters=`);
}

describe("authoritative log diagnostic completion", () => {
  function serviceFixture() {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    return { service, connections };
  }

  it("does not await the typed compiler for a deterministic structured log query", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn(() => new Promise(() => undefined));
    const service = new TasksService(store, connections, {
      compileIntent, answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const intent = "Examine the preceding 70 minutes of logs for authentication refusals or disconnects and report whether any such event occurred.";

    const task = await Promise.race([
      service.create({
        tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent,
        preferredTool: "logs.query", assistantResponse: "Reading recent records.", modelStatus: "answered",
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("task planning waited for compiler")), 250)),
    ]);

    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "logs.query", risk: "read" })]);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("does not await the typed compiler for a deterministic plugin metadata read", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn(() => new Promise(() => undefined));
    const service = new TasksService(store, connections, {
      compileIntent, answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const intent = "Audit SquareMap compatibility with Paper 1.21.3 and return its provenance and checksum; never fetch or install it.";
    const task = await Promise.race([
      service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, preferredTool: "plugin.resolve", assistantResponse: "正在核对插件资料。", modelStatus: "answered" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("plugin planning waited for compiler")), 250)),
    ]);
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "plugin.resolve", risk: "read" })]);
    expect(task.plan.operation).toMatchObject({ action: "read", requires_confirmation: false });
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).toHaveBeenCalledTimes(1);
  });

  it("completes a plugin metadata read only from one complete authoritative callback", async () => {
    const { service } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Check HarborMap compatibility with Purpur 1.20.6 and return its trusted source and checksum without fetching or installing it.",
      preferredTool: "plugin.resolve", assistantResponse: "正在核对插件资料。", modelStatus: "answered",
    });
    expect(task.plan.goal_requirements.filter((goal) => goal.required && goal.domain === "plugin")).toHaveLength(1);
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "plugin", step_id: "s1", tool: "plugin.resolve", result: "match", tool_calls: 1,
      summary: `Plugin resolve result: project=harbormap; version=5.7.0; source=modrinth; artifact=HarborMap-5.7.0.jar; compatibility=purpur 1.20.6; sha256=; source_sha512=${"cd".repeat(64)}`,
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "metadata lookup completed", tool_calls: 1 });

    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses.length).toBeGreaterThan(0);
    expect(task.goal_statuses.every((goal) => goal.status === "satisfied")).toBe(true);
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("HarborMap-5.7.0.jar");
    expect(completion?.answer).toContain("trusted source");
    expect(completion?.answer).toContain("The source declares compatibility with purpur 1.20.6");
    expect(completion?.answer.match(/trusted source/gi)).toHaveLength(1);
    expect(completion?.answer).not.toMatch(/goal|schema|provider|digest|adapter|verification/i);
  });

  it("does not claim success when plugin resolution omits required integrity metadata", async () => {
    const { service } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Resolve AsterBridge for Fabric 1.20.4 and report compatibility, provenance, and integrity metadata only; do not install it.",
      preferredTool: "plugin.resolve", assistantResponse: "正在核对插件资料。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "plugin", step_id: "s1", tool: "plugin.resolve", result: "match", tool_calls: 1,
      summary: "Plugin resolve result: project=asterbridge; version=1.8.2; source=official; artifact=AsterBridge-1.8.2.jar; compatibility=fabric 1.20.4; sha256=; source_sha512=",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "metadata lookup completed", tool_calls: 1 });

    expect(task.state).not.toBe("SUCCEEDED");
    expect(task.goal_statuses.some((goal) => goal.status !== "satisfied")).toBe(true);
    expect((await service.complete(task.id, "tenant-1"))?.answer).toContain("未完成");
  });

  it("reuses one real log callback for the event list, count, and deterministic conclusion", async () => {
    const { service, connections } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Review the logs from the past 25 minutes for handshake failures or timeouts and conclude whether there are warning signs.",
      preferredTool: "logs.query", assistantResponse: "正在检查近期记录。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "logs.query", risk: "read" })]);
    expect(task.plan.goal_requirements.map((goal) => goal.result_kind)).toEqual(expect.arrayContaining(["collection", "count", "judgement"]));
    expect(connections.send).toHaveBeenCalledTimes(1);

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "logs", step_id: "s1", tool: "logs.query", result: "match", tool_calls: 1,
      summary: bindLogQueryEvidence(task, "Log query result: matches=2; window_minutes=25; scanned_lines=90; sample_count=2; filters=authentication_failure|timeout\nMatched samples:\n[11:31:00] Handshake authentication failed\n[11:33:00] Connection timed out"),
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed", tool_calls: 1 });

    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toHaveLength(3);
    expect(task.goal_statuses.every((goal) => goal.status === "satisfied")).toBe(true);
    expect(task.goal_results.find((goal) => goal.result_kind === "count")?.observed).toBe(2);
    expect(task.goal_results.find((goal) => goal.result_kind === "judgement")?.observed).toBe(true);
    expect(task.evidence.filter((item) => item.kind === "logs")).toHaveLength(1);
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("matching warning signs were found");
    expect(completion?.answer).not.toMatch(/verification|SourceGoal|Clause|schema|digest|provider|gateway|compiler/i);
  });

  it("completes a component-event handling diagnosis from one bound callback", async () => {
    const { service, connections } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "检查近期日志中的模块初始化错误或依赖缺失，给出匹配数并判断是否需要处理。",
      preferredTool: "logs.query", assistantResponse: "正在读取近期记录。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([expect.objectContaining({
      tool: "logs.query", args: expect.objectContaining({ filter_query: expect.objectContaining({
        groups: [{ all_of: ["software_component"], any_of: ["initialization_failure", "dependency_missing"] }],
      }) }),
    })]);
    expect(task.plan.goal_requirements.map((goal) => goal.result_kind).sort()).toEqual(["collection", "count", "judgement"]);
    expect(connections.send).toHaveBeenCalledTimes(1);

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "logs", step_id: "s1", tool: "logs.query", result: "match", tool_calls: 1,
      summary: bindLogQueryEvidence(task, "Log query result: matches=1; window_minutes=60; scanned_lines=120; sample_count=1; filters=initialization_failure|dependency_missing\nMatched samples:\n[15:20:00] Module Aurora failed to initialize"),
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed", tool_calls: 1 });

    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toHaveLength(3);
    expect(task.goal_statuses.every((goal) => goal.status === "satisfied")).toBe(true);
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("找到 1 条符合条件的日志");
    expect(completion?.answer).toContain("存在需要处理的迹象");
    expect(completion?.answer).not.toMatch(/logs\.query|verification|SourceGoal|Clause|schema|digest|provider|gateway|compiler/i);
  });

  it("treats an authoritative zero-match callback as a successful normal finding", async () => {
    const { service } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Check the logs from the last 40 minutes for permission failures, then tell me if anything looks abnormal.",
      preferredTool: "logs.query", assistantResponse: "正在检查近期记录。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "logs", step_id: "s1", tool: "logs.query", result: "match", tool_calls: 1,
      summary: bindLogQueryEvidence(task, "Log query result: matches=0; window_minutes=40; scanned_lines=68; sample_count=0; filters=permission_failure\nMatched samples: <none>"),
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results.find((goal) => goal.result_kind === "count")?.observed).toBe(0);
    expect(task.goal_results.find((goal) => goal.result_kind === "judgement")?.observed).toBe(false);
    expect((await service.complete(task.id, "tenant-1"))?.answer).toContain("no matching warning signs were found");
  });

  it("does not succeed without a real log callback", async () => {
    const { service } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Inspect recent log crash events and decide if the service is abnormal.",
      preferredTool: "logs.query", assistantResponse: "正在检查近期记录。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed", tool_calls: 1 });
    expect(task.state).not.toBe("SUCCEEDED");
    expect(task.goal_statuses.some((goal) => goal.status === "satisfied")).toBe(false);
  });

  it("fails closed when the callback metadata contradicts its samples", async () => {
    const { service } = serviceFixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Look through recent logs for disconnects and determine whether the connection state is abnormal.",
      preferredTool: "logs.query", assistantResponse: "正在检查近期记录。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({
      task_id: task.id, kind: "logs", step_id: "s1", tool: "logs.query", result: "match", tool_calls: 1,
      summary: bindLogQueryEvidence(task, "Log query result: matches=4; window_minutes=60; scanned_lines=75; sample_count=2; filters=disconnect\nMatched samples:\n[09:10:00] Player disconnected"),
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed", tool_calls: 1 });
    expect(task.state).not.toBe("SUCCEEDED");
    expect(task.goal_statuses.some((goal) => goal.status === "satisfied")).toBe(false);
  });
});

describe("authoritative multi-goal state and policy", () => {
  const modelStub = () => ({
    answer: vi.fn().mockResolvedValue({ status: "answered", answer: "基于真实证据生成回答。" }),
    decideRecovery: vi.fn().mockResolvedValue("保持原授权范围，仅做只读诊断。"),
  } as unknown as ModelGatewayService);

  it("marks an Agent success callback PARTIAL when only one of four required goals has evidence", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, modelStub());
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Show online players, TPS, the plugins folder, and inspect recent warnings",
      assistantResponse: "正在执行只读检查。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "There are 2 of a max of 20 players online: Alice, Bob" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "agent finished" });

    expect(task.state).toBe("PARTIAL");
    expect(task.goal_statuses.filter((goal) => goal.status === "satisfied")).toHaveLength(1);
    expect((await service.complete(task.id, "tenant-1"))?.answer).toContain("无法确认");
  });

  it("accepts SUCCEEDED only after every read goal has its own callback and terminal verification", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, modelStub());
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Show online players, TPS, the plugins folder, and inspect recent warnings",
      assistantResponse: "正在执行只读检查。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "There are 2 of a max of 20 players online: Alice, Bob" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "TPS from last 1m, 5m, 15m: 20.0" });
    await service.recordAgentEvent({ task_id: task.id, kind: "files", summary: "plugins: AuroraChat.jar" });
    await service.recordAgentEvent({ task_id: task.id, kind: "logs", step_id: "s4", tool: "logs.query", summary: bindLogQueryEvidence(task, "Log query result: matches=0; window_minutes=60; scanned_lines=120; sample_count=0; filters=warning\nMatched samples: <none>"), result: "match" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "all readbacks checked" });

    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses.every((goal) => goal.status === "satisfied")).toBe(true);
  });

  it.each([
    "修复那个未说明的问题",
    "Operate the unspecified subsystem",
    "把未知资源处理一下",
  ])("keeps uncovered request %s in WAITING without dispatch", async (intent) => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, modelStub());
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "执行中", modelStatus: "answered" });
    expect(task.state).toBe("WAITING");
    expect(task.assistant_response).toContain("未执行");
    expect(connections.send).not.toHaveBeenCalled();
  });

  it.each([
    ["Install Paper 1.21.4", "high"],
    ["启动当前实例", "medium"],
    ["console command: say scheduled maintenance", "medium"],
  ])("requires approval for intrinsic write policy: %s", async (intent, risk) => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, modelStub());
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "等待审批", modelStatus: "answered" });
    expect(task.risk).toBe(risk);
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(connections.send).not.toHaveBeenCalled();
  });
});

describe("composite completion from source-goal evidence", () => {
  it("does not dispatch a vague derived judgement that lacks an auditable predicate", async () => {
    const { store, connections } = fixture();
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "目录最后一项是 BlueStone.jar。" }),
      decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "只读给出服务端版本、已加载插件数量、最近错误数量，并据此判断是否适合进入维护窗口",
      assistantResponse: "开始检查。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "This server is running Paper version 1.22.0-17" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "Server Plugins (2): BlueStone, HarborMap" });
    await service.recordAgentEvent({ task_id: task.id, kind: "logs", summary: "Recent log excerpt: [WARN] one delayed chunk; [ERROR] database unavailable" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "done" });

    const completion = await service.complete(task.id, "tenant-1");
    expect(task.state).toBe("WAITING");
    expect(connections.send).not.toHaveBeenCalled();
    expect(completion?.answer).not.toContain("综合判断：已满足");
    expect(completion?.answer).not.toBe("目录最后一项是 BlueStone.jar。");
  });

  it("computes a suffix-filtered file count instead of treating directory length as the count", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "列出 /plugins 的内容，并统计其中 .jar 文件数量",
      assistantResponse: "开始读取。", modelStatus: "answered",
    });
    await service.recordAgentEvent({
      task_id: task.id, kind: "files",
      summary: "实例目录 /plugins： 共 6 项：cache、metrics、Aster.jar、Beacon.JAR、notes.txt、worlds",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "done" });

    const completion = await service.complete(task.id, "tenant-1");
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results.find((result) => result.result_kind === "filtered_count")?.observed).toBe(2);
    expect(completion?.answer).toContain("2");
    expect(completion?.answer).not.toContain("6 个 .jar");
  });

  it("uses one real file callback for a filtered filename list and its count", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "统计archives目录里的zip文件数量，并列出文件名",
      assistantResponse: "开始读取。", modelStatus: "answered",
      preferredTool: "files.list",
    });

    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/archives" } })]);
    await service.recordAgentEvent({
      task_id: task.id, kind: "files", step_id: "s1", tool: "files.list", target: "/archives",
      summary: "实例目录 /archives： 共 5 项：north.zip、notes.txt、south.ZIP、cache、west.zip.disabled",
    });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read completed" });

    const completion = await service.complete(task.id, "tenant-1");
    expect(task.state).toBe("SUCCEEDED");
    expect(task.evidence.filter((item) => item.kind === "files")).toHaveLength(1);
    expect(task.goal_results.find((result) => result.result_kind === "collection")?.observed).toEqual(["north.zip", "south.ZIP"]);
    expect(task.goal_results.find((result) => result.result_kind === "filtered_count")?.observed).toBe(2);
    expect(completion?.answer).toContain("north.zip");
    expect(completion?.answer).toContain("south.ZIP");
    expect(completion?.answer).toContain("2");
    expect(completion?.answer).not.toContain("notes.txt");
  });

  it("keeps a proven generic filesystem read off the semantic compiler path", async () => {
    const { store, connections } = fixture();
    const compileIntent = vi.fn().mockResolvedValue({ status: "unavailable", error: "SHOULD_NOT_RUN" });
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(), compileIntent,
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "Inside the config directory, count every TOML file and list each matching filename.",
      assistantResponse: "Reading the directory.", modelStatus: "answered", preferredTool: "files.list",
    });

    expect(compileIntent).not.toHaveBeenCalled();
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/config" }, risk: "read" })]);
    expect(task.state).not.toBe("WAITING_CONFIRMATION");
  });

  it("keeps an untyped derived conclusion waiting instead of claiming partial execution", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "读取服务器版本、TPS和近期崩溃数量，然后判断是否适合迁移玩家",
      assistantResponse: "开始检查。", modelStatus: "answered",
    });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "This server is running Purpur version 1.22.1" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", summary: "TPS from last 1m, 5m, 15m: 20.0, 19.9, 19.8" });
    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "checking" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "done" });
    expect(task.state).toBe("WAITING");
    const completion = await service.complete(task.id, "tenant-1");
    expect(completion?.answer).toContain("未完成");
    expect(completion?.answer).not.toContain("已确认适合迁移");
  });

  it("converges difficulty fact and peaceful judgement from one authoritative callback", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(), compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "核对当前游戏难度，并判断现在是不是和平模式",
      assistantResponse: "正在读取当前难度。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "difficulty" }, risk: "read" }]);
    expect(task.plan.goal_requirements.map((goal) => goal.result_kind).sort()).toEqual(["fact", "judgement"]);
    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "The difficulty is Normal", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results.map((goal) => goal.observed)).toEqual(expect.arrayContaining(["normal", false]));
    const answer = (await service.complete(task.id, "tenant-1"))?.answer ?? "";
    expect(answer).toContain("当前游戏难度为 normal");
    expect(answer).toContain("当前不是和平难度");
  });

  it("converges daytime fact and day-period judgement without generating a setter", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(), compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "读取主世界现有daytime刻数，再据此判断昼间或夜间，禁止改变时间。",
      assistantResponse: "正在读取世界时间。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "time query daytime" }, risk: "read" }]);
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "The time is 18000", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results.map((goal) => goal.observed)).toEqual(expect.arrayContaining([18000, false]));
    const answer = (await service.complete(task.id, "tenant-1"))?.answer ?? "";
    expect(answer).toContain("当前世界时间为 18000 刻");
    expect(answer).toContain("当前是夜晚");
  });

  it("reuses one datapack callback for the enabled roster and count", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(), compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "只列出当前启用的数据包并统计数量，不要启用或停用任何包",
      assistantResponse: "正在读取数据包。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "datapack list enabled" }, risk: "read" }]);
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: "There are 2 data pack(s) enabled: [vanilla], [file/custom]", result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results.find((goal) => goal.result_kind === "collection")?.observed).toEqual(["vanilla", "file/custom"]);
    expect(task.goal_results.find((goal) => goal.result_kind === "count")?.observed).toBe(2);
    const answer = (await service.complete(task.id, "tenant-1"))?.answer ?? "";
    expect(answer).toContain("当前已启用 2 个数据包");
    expect(answer).toContain("file/custom");
  });

  it.each([
    ["请查当前世界种子，不改世界设置", "Seed: [9007199254740997]", "9007199254740997", "当前世界种子为 9007199254740997。"],
    ["请读当前世界边界宽度，不要调整边界", "The world border is currently 42000000 block(s) wide", 42000000, "当前世界边界直径为 42000000 格。"],
  ])("renders a single runtime fact naturally from its typed result: %s", async (intent, callback, observed, answerText) => {
    const { store, connections } = fixture();
    const answer = vi.fn();
    const service = new TasksService(store, connections, {
      answer, decideRecovery: vi.fn(), compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "正在读取。", modelStatus: "answered" });
    await service.recordAgentEvent({ task_id: task.id, kind: "console", step_id: "s1", tool: "console.command", summary: callback, result: "match", tool_calls: 1 });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "read complete", tool_calls: 1 });
    expect(task.goal_results[0]).toMatchObject({ status: "satisfied", observed });
    expect((await service.complete(task.id, "tenant-1"))?.answer).toBe(answerText);
    expect(answer).not.toHaveBeenCalled();
  });

  it("binds datapack roster and count to their own positive clauses while keeping enable/disable negative", async () => {
    const { store, connections } = fixture();
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(), compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(),
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "审计说明：请查看现有已激活的数据包，列出名称并统计个数，不允许启用或停用任何数据包。",
      assistantResponse: "正在读取。", modelStatus: "answered",
    });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "datapack list enabled" }, risk: "read" }]);
    const domainClauses = task.plan.clause_ledger.filter((entry) => entry.role === "domain_goal");
    expect(domainClauses.length).toBeGreaterThanOrEqual(2);
    expect(domainClauses.every((entry) => entry.source_atom_ids.length > 0 && entry.source_goal_ids.length > 0)).toBe(true);
    const constraint = task.plan.clause_ledger.find((entry) => entry.role === "safety_constraint");
    expect(constraint).toMatchObject({ polarity: "negative", source_goal_ids: [] });
    expect(task.plan.constraints.map((item) => item.action)).toContain("write");
  });

  it("creates clear weather confirmation deterministically without invoking the proposal model", async () => {
    const { store, connections } = fixture();
    const proposeConfirmedWrite = vi.fn().mockResolvedValue({ status: "answered", proposal: { schema_version: "confirmed-write-proposal/v1", decision: "clarify", summary: "unclear" } });
    const service = new TasksService(store, connections, {
      answer: vi.fn(), decideRecovery: vi.fn(), compileIntent: vi.fn(), proposeConfirmedWrite,
    } as unknown as ModelGatewayService);
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance",
      intent: "变更单：将这个世界的天气切换到clear，仅改天气且绝不能重启。",
      assistantResponse: "等待确认。", modelStatus: "answered",
    });
    expect(task).toMatchObject({ state: "WAITING_CONFIRMATION", risk: "medium" });
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "weather clear" }, risk: "medium", requires_confirmation: true }]);
    expect(task.plan.operation).toMatchObject({ action: "write", capability: "console.command", risk: "medium", requires_confirmation: true });
    expect(proposeConfirmedWrite).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });
});
