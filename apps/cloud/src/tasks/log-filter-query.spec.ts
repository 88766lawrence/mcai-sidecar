import { describe, expect, it } from "vitest";
import { canonicalizeLogFilterGroups, compileLogFilterQuery, matchesLogFilterQuery, validateLogFilterQuery } from "./log-filter-query";
import { draftPlan } from "./planner";
import { validatePlanCompatibility } from "./plan-compatibility";

describe("structured log filter query", () => {
  it.each([
    ["检查组件初始化失败或依赖项缺失的近期记录", "software_component", ["initialization_failure", "dependency_missing"]],
    ["Were any module dependencies unavailable or extensions unable to initialize?", "software_component", ["initialization_failure", "dependency_missing"]],
    ["查找数据库认证错误或连接超时", "database_service", ["authentication_failure", "timeout"]],
    ["Review proxy requests for permission failures or malformed responses", "proxy_service", ["permission_failure", "response_failure"]],
  ])("preserves a generic topic AND an OR event set: %s", (intent, topic, events) => {
    const query = compileLogFilterQuery(intent);
    expect(query.groups).toEqual([{ all_of: [topic], any_of: events }]);
    expect(query.groups[0].all_of).not.toContain("all");
    expect(validateLogFilterQuery(query)).toEqual({ ok: true });
  });

  it("requires both the software-component context and one requested event", () => {
    const query = compileLogFilterQuery("Find module startup failures or missing dependencies");
    expect(query.groups).toEqual([{ all_of: ["software_component"], any_of: ["initialization_failure", "dependency_missing"] }]);
    expect(matchesLogFilterQuery("[ModuleLoader] Extension Atlas failed to initialize", query)).toBe(true);
    expect(matchesLogFilterQuery("[DependencyResolver] Module Atlas missing required dependency CoreAPI", query)).toBe(true);
    expect(matchesLogFilterQuery("Player connection timed out during login", query)).toBe(false);
    expect(matchesLogFilterQuery("Plugin Atlas loaded successfully", query)).toBe(false);
  });

  it("normalizes passive permission denial without losing the adjacent response alternative", () => {
    const query = compileLogFilterQuery("查看代理权限被拒或响应无效的近期记录");
    expect(query.groups).toEqual([{ all_of: ["proxy_service"], any_of: ["permission_failure", "response_failure"] }]);
    expect(matchesLogFilterQuery("Gateway access denied for upstream route", query)).toBe(true);
    expect(matchesLogFilterQuery("Proxy returned an invalid response", query)).toBe(true);
  });

  it.each([
    ["查最近的客户端连接失败或者超时", "client_connection", ["connection_failure", "timeout"]],
    ["最近有没有玩家登录失败或超时记录", "client_connection", ["authentication_failure", "timeout"]],
    ["Were there failed or timed-out handshakes for clients?", "client_connection", ["connection_failure", "timeout"]],
    ["Timeout or connection failures involving online users", "client_connection", ["connection_failure", "timeout"]],
  ])("keeps the subject and OR event conditions: %s", (intent, subject, events) => {
    const query = compileLogFilterQuery(intent);
    expect(query.groups).toEqual([{ all_of: [subject], any_of: events }]);
    expect(validateLogFilterQuery(query)).toEqual({ ok: true });
  });

  it("keeps AND between event conditions", () => {
    const query = compileLogFilterQuery("检查客户端连接既失败并且超时的记录");
    expect(query.groups).toEqual([{ all_of: ["client_connection", "connection_failure", "timeout"], any_of: [] }]);
  });

  it.each([
    "[spark-async-sampler-worker-thread/WARN]: [spark] Timed out waiting for world statistics",
    "HTTP provider request timed out after 25 seconds",
    "Backup operation timeout while copying archive",
    "Chunk world save timed out waiting for IO",
  ])("does not match unrelated timeout evidence: %s", (line) => {
    const query = compileLogFilterQuery("check client connection failures or timeouts");
    expect(matchesLogFilterQuery(line, query)).toBe(false);
  });

  it.each([
    "[User Authenticator] Login failed for client QuartzFox",
    "Connection refused for player BlueHarbor",
    "Handshake timed out for client 10.0.0.8",
    "Player join connection timed out",
  ])("matches evidence containing the requested subject and event: %s", (line) => {
    const query = compileLogFilterQuery("check client connection failures or timeouts");
    expect(matchesLogFilterQuery(line, query)).toBe(true);
  });

  it("keeps a pure timeout query intentionally broad", () => {
    const query = compileLogFilterQuery("show any timeout in the recent logs");
    expect(query.groups).toEqual([{ all_of: ["timeout"], any_of: [] }]);
    expect(matchesLogFilterQuery("backup timed out", query)).toBe(true);
  });

  it("preserves server-lag topic with cannot-keep-up OR tick-timeout events", () => {
    const query = compileLogFilterQuery("Check for server lag where it cannot keep up or a single tick times out");
    expect(query.groups).toEqual([{ all_of: ["server_lag"], any_of: ["cannot_keep_up", "tick_timeout"] }]);
    expect(matchesLogFilterQuery("Can't keep up! Is the server overloaded? Running 2400ms or 48 ticks behind", query)).toBe(true);
    expect(matchesLogFilterQuery("A single server tick took 60.00 seconds", query)).toBe(true);
    expect(matchesLogFilterQuery("HTTP provider request timed out while fetching metadata", query)).toBe(false);
  });

  it("canonicalizes model-produced OR branches without collapsing unrelated topics into AND", () => {
    const result = canonicalizeLogFilterGroups([
      { all_of: ["memory_resource", "out_of_memory"], any_of: [] },
      { all_of: ["server_lag", "cannot_keep_up"], any_of: [] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.groups).toEqual([
      { all_of: ["memory_resource", "out_of_memory"], any_of: [] },
      { all_of: ["server_lag", "cannot_keep_up"], any_of: [] },
    ]);
    expect(matchesLogFilterQuery("java.lang.OutOfMemoryError: Java heap space", result.query)).toBe(true);
    expect(matchesLogFilterQuery("Can't keep up! Is the server overloaded?", result.query)).toBe(true);
  });

  it.each([
    [{ all_of: ["unknown_condition"], any_of: [] }],
    [{ all_of: ["all", "memory_resource"], any_of: [] }],
    [{ all_of: ["memory_resource"], any_of: ["memory_resource"] }],
  ])("rejects unsafe or contradictory model-produced filter groups: %j", (groups) => {
    expect(canonicalizeLogFilterGroups(groups)).toMatchObject({ ok: false });
  });

  it.each([
    (query: ReturnType<typeof compileLogFilterQuery>) => { query.groups[0].all_of = ["http_request"]; },
    (query: ReturnType<typeof compileLogFilterQuery>) => { query.groups[0].any_of.reverse(); },
    (query: ReturnType<typeof compileLogFilterQuery>) => { query.groups.push({ all_of: ["backup"], any_of: ["timeout"] }); },
    (query: ReturnType<typeof compileLogFilterQuery>) => { query.groups[0].all_of.push("unknown_condition"); },
  ])("rejects subject, logic, group, or condition tampering", (mutate) => {
    const query = compileLogFilterQuery("check client connection failures or timeouts");
    mutate(query);
    expect(validateLogFilterQuery(query)).toMatchObject({ ok: false });
  });

  it("binds the structured query to the only logs.query plan step", () => {
    const intent = "扫描最近25分钟里客户端握手失败或超时，并判断是否异常";
    const plan = draftPlan("mcs:daemon:instance", "rev-query", intent, { preferredTool: "logs.query" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "logs.query", risk: "read" });
    expect(plan.steps[0].requires_confirmation).not.toBe(true);
    expect(plan.steps[0].args.filter_query).toEqual(compileLogFilterQuery(intent));
    expect(plan.steps[0].args.filters).toEqual(["connection_failure", "timeout"]);
  });

  it("rejects a structured query changed after planning", () => {
    const plan = draftPlan("mcs:daemon:instance", "rev-query", "check recent logs for client connection failures or timeouts", { preferredTool: "logs.query" });
    const changed = structuredClone(plan);
    const query = changed.steps[0].args.filter_query as ReturnType<typeof compileLogFilterQuery>;
    query.groups[0].all_of = ["http_request"];
    const result = validatePlanCompatibility(changed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["OPERATION_DIGEST_MISMATCH", "INVALID_LOG_FILTER_QUERY"]).toContain(result.code);
  });
});
