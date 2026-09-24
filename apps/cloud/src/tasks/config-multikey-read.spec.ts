import { describe, expect, it } from "vitest";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";
import { draftPlan, extractConfigInspectIntent } from "./planner";
import { adaptGoalResult } from "./result-adapters";
import { validatePlanCompatibility } from "./plan-compatibility";

describe("configuration multi-key read", () => {
  it.each([
    ["只读查看settings/access.properties里的whitelist-enabled和players-limit当前值，不要写回。", "settings/access.properties", ["whitelist-enabled", "players-limit"]],
    ["Inspect memory-threshold and runtime-version in config/process.conf without changing the file.", "config/process.conf", ["memory-threshold", "runtime-version"]],
    ["读取world/rules.yml中的spawn-protection与allow-flight当前配置，只查不改。", "world/rules.yml", ["spawn-protection", "allow-flight"]],
    ["Review online-mode and player-idle-timeout from realms/lobby.properties; leave it untouched.", "realms/lobby.properties", ["online-mode", "player-idle-timeout"]],
  ])("treats explicit config identifiers as opaque to adjacent domain routers: %s", (intent, path, keys) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-opaque-config", intent, { preferredTool: "config.inspect" });
    expect(plan.steps).toEqual([{ id: "s1", tool: "config.inspect", args: { path, keys }, risk: "read" }]);
    expect(plan.source_goals.filter((goal) => goal.required)).toEqual(keys.map((key) => expect.objectContaining({
      domain: "config", entity: `${path}#${key}`, result_kind: "fact",
    })));
    expect(plan.goal_requirements).toHaveLength(keys.length);
    expect(plan.goal_requirements.every((goal) => goal.domain === "config" && goal.execute_step_ids.join() === "s1")).toBe(true);
    expect(plan.steps.some((step) => step.tool === "console.command" || step.tool === "instance.metrics")).toBe(false);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("keeps the public B9 plan auditable without production special-casing", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-public-b9", "只读查看server.properties里的motd和enforce-whitelist当前配置，不要写回文件。", { preferredTool: "config.inspect" });
    expect(plan.steps).toEqual([{ id: "s1", tool: "config.inspect", args: { path: "server.properties", keys: ["motd", "enforce-whitelist"] }, risk: "read" }]);
    expect(plan.source_goals.filter((goal) => goal.required).map((goal) => [goal.domain, goal.entity])).toEqual([
      ["config", "server.properties#motd"],
      ["config", "server.properties#enforce-whitelist"],
    ]);
    expect(plan.goal_requirements).toHaveLength(2);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("still recognises an explicit access-list roster request outside config identifiers", async () => {
    const { extractWhitelistReadIntent } = await import("./whitelist-read-intent");
    expect(extractWhitelistReadIntent("请列出当前白名单成员并统计人数，只读即可")).toMatchObject({ wantsRoster: true, wantsCount: true });
  });

  it("preserves an explicit adjacent access-list goal outside the opaque config identifier span", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-explicit-adjacent-goal",
      "只读查看settings.properties里的whitelist-enabled当前值；另外列出白名单成员和人数，不要修改。",
      { preferredTool: "config.inspect" },
    );
    expect(plan.steps).toEqual([
      { id: "s1", tool: "config.inspect", args: { path: "settings.properties", keys: ["whitelist-enabled"] }, risk: "read" },
      { id: "s2", tool: "console.command", args: { command: "whitelist list" }, risk: "read" },
    ]);
    expect(plan.source_goals.filter((goal) => goal.required).map((goal) => goal.normalized)).toEqual(expect.arrayContaining([
      "config.value:settings.properties:whitelist-enabled",
      "access.whitelist-roster",
      "access.whitelist-count",
    ]));
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["只读查询config/paper-global.yml里的chunk-loading.basic-player-max-chunk-generate-rate和proxies.velocity.enabled，别改", "config/paper-global.yml", ["chunk-loading.basic-player-max-chunk-generate-rate", "proxies.velocity.enabled"]],
    ["Show motd and online-mode from staging/paper.conf without changing anything.", "staging/paper.conf", ["motd", "online-mode"]],
    ["读取 plugins/Harbor/settings.json 中的locale、debug以及storage.type，不要写入", "plugins/Harbor/settings.json", ["locale", "debug", "storage.type"]],
    ["What is max-players in environments/lobby.properties? Read only.", "environments/lobby.properties", ["max-players"]],
    ["Without changing the file, inspect online-mode and max-players in server.properties and report both current values.", "server.properties", ["online-mode", "max-players"]],
    ["保持 proxy.yml 原样，想知道 velocity.enabled 和 query.port 目前怎么配置。", "proxy.yml", ["velocity.enabled", "query.port"]],
  ])("extracts an exact file and ordered keys: %s", (intent, path, keys) => {
    expect(extractConfigInspectIntent(intent)).toEqual({ path, keys });
  });

  it.each([
    "请把 environments/lobby.properties 的 max-players 改成 40",
    "Explain what online-mode means in server.properties",
    "Run cat /path/to/server.properties | grep online-mode",
  ])("does not treat writes, knowledge questions, or shell placeholders as a config read: %s", (intent) => {
    expect(extractConfigInspectIntent(intent)).toBeUndefined();
  });

  it("builds one read-only step and one evidence-bound goal per requested key", () => {
    const intent = "Read alpha-mode and cache.limit from config/engine.properties; do not modify the file.";
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent, { preferredTool: "config.inspect" });

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "config.inspect",
      args: { path: "config/engine.properties", keys: ["alpha-mode", "cache.limit"] },
      risk: "read",
    }]);
    expect(plan.constraints).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", effect: "forbid" })]));
    expect(plan.goal_requirements).toHaveLength(2);
    expect(plan.goal_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "config", target: "config/engine.properties#alpha-mode", result_kind: "fact", execute_step_ids: ["s1"], status: "pending" }),
      expect.objectContaining({ domain: "config", target: "config/engine.properties#cache.limit", result_kind: "fact", execute_step_ids: ["s1"], status: "pending" }),
    ]));
    expect(plan.coverage).toBe("full");
    expect(plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(plan.steps.some((step) => ["console.command", "logs.query", "config.patch"].includes(step.tool))).toBe(false);
    expect(plan.clause_ledger
      .filter((clause) => clause.source_goal_ids.length > 0)
      .every((clause) => clause.role === "domain_goal" && clause.status === "mapped"))
      .toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("keeps an explicitly requested absent key in the same read-only plan", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "不要修改 configs/tuning.conf，只读给出 alpha-mode 与 omega-option 当前值。",
      { preferredTool: "config.inspect" },
    );
    expect(plan.steps).toEqual([expect.objectContaining({
      tool: "config.inspect",
      args: { path: "configs/tuning.conf", keys: ["alpha-mode", "omega-option"] },
      risk: "read",
    })]);
    expect(plan.clause_ledger
      .filter((clause) => clause.source_goal_ids.length > 0)
      .every((clause) => clause.role === "domain_goal" && clause.status === "mapped"))
      .toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["复核一下paper-global.yml中的settings.velocity-support与settings.bungee-online-mode当前值", "paper-global.yml", ["settings.velocity-support", "settings.bungee-online-mode"]],
    ["Review the current values of query.port and enable-query in proxy/runtime.properties.", "proxy/runtime.properties", ["query.port", "enable-query"]],
    ["请确认config/world.yml里spawn.keep-loaded和entities.spawning当前分别是什么值", "config/world.yml", ["spawn.keep-loaded", "entities.spawning"]],
    ["只读核对server.properties中的entity-broadcast-range-percentage和network-compression-threshold，把两个当前值分别说清楚", "server.properties", ["entity-broadcast-range-percentage", "network-compression-threshold"]],
  ])("treats contextual fact review as a positive observation: %s", (intent, path, keys) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-review", intent, { preferredTool: "config.inspect" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "config.inspect", args: { path, keys }, risk: "read" })]);
    expect(plan.goal_requirements).toHaveLength(keys.length);
    expect(plan.clause_ledger
      .filter((clause) => clause.source_goal_ids.length > 0)
      .every((clause) => clause.role === "domain_goal" && clause.polarity === "positive"))
      .toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    "确认重启当前实例",
    "verify the restart before executing it",
    "review and approve changing difficulty to hard",
  ])("does not globally reinterpret lifecycle or write confirmation as a read: %s", (intent) => {
    expect(extractConfigInspectIntent(intent)).toBeUndefined();
  });

  it.each([
    ["核对当前运行的服务端实现和 Minecraft 版本", "console.command", { command: "version" }],
    ["Review the current whitelist roster and count", "console.command", { command: "whitelist list" }],
    ["复核/datapacks目录当前的文件名单", "files.list", { path: "/datapacks" }],
  ])("keeps contextual fact review in the registered read domain: %s", (intent, tool, args) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-adjacent", intent, { preferredTool: tool });
    expect(plan.steps).toEqual([expect.objectContaining({ tool, args, risk: "read" })]);
    expect(plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(plan.clause_ledger
      .filter((clause) => clause.source_goal_ids.length > 0)
      .every((clause) => clause.role === "domain_goal" && clause.polarity === "positive"))
      .toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    "不要改config/network.yml；复核compression-threshold和connection-timeout的当前值",
    "Review motd and max-players in lobby/server.properties, but do not modify either value.",
  ])("keeps contextual observation and explicit write prohibition separate: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-forbid", intent, { preferredTool: "config.inspect" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "config.inspect", risk: "read" });
    expect(plan.constraints).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", effect: "forbid" })]));
    expect(plan.clause_ledger.some((clause) => clause.role === "domain_goal" && clause.polarity === "positive" && clause.source_goal_ids.length > 0)).toBe(true);
    expect(plan.clause_ledger.some((clause) => clause.role === "safety_constraint" && clause.polarity === "negative" && clause.constraint_actions.includes("write"))).toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["只读看看config/runtime.properties里的tick-budget和network-threshold现在各是多少，别改。", "config/runtime.properties", ["tick-budget", "network-threshold"]],
    ["不要修改proxy/relay.yml；只读告诉我forwarding.mode和query.port当前值。", "proxy/relay.yml", ["forwarding.mode", "query.port"]],
    ["Inspect alpha-mode and cache.limit in config/engine.properties; do not change the file.", "config/engine.properties", ["alpha-mode", "cache.limit"]],
    ["Do not alter configs/world.conf. Read spawn-radius and entity-limit as they are now.", "configs/world.conf", ["spawn-radius", "entity-limit"]],
  ])("keeps read goals separate from a negative write constraint: %s", (intent, path, keys) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-constraint", intent, { preferredTool: "config.inspect" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "config.inspect", args: { path, keys }, risk: "read" })]);
    expect(plan.constraints).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", effect: "forbid" })]));
    expect(plan.clause_ledger.filter((clause) => clause.role === "safety_constraint")).toEqual(expect.arrayContaining([
      expect.objectContaining({ polarity: "negative", source_goal_ids: [], source_atom_ids: expect.any(Array), constraint_actions: expect.arrayContaining(["write"]) }),
    ]));
    expect(plan.clause_ledger
      .filter((clause) => clause.source_goal_ids.length > 0)
      .every((clause) => clause.role === "domain_goal" && clause.polarity === "positive"))
      .toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("derives distinct typed values from one real config callback and fails closed for a missing key", () => {
    const evidence = [{
      kind: "config", step_id: "s1", tool: "config.inspect",
      summary: "Read config/engine.properties (91 bytes, sha256:0123456789abcdef)\nalpha-mode=true\ncache.limit=128\nmissing-key=<MISSING>",
      at: new Date(0).toISOString(), result: "match" as const,
    }] as TaskRecord["evidence"];
    const goal = (key: string): GoalRequirement => ({
      id: `g-${key}`, description: `Read ${key}`, domain: "config", action: "read",
      target: `config/engine.properties#${key}`, required: true, source_goal_ids: [`sg-${key}`],
      result_kind: "fact", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    });

    expect(adaptGoalResult(goal("alpha-mode"), evidence)).toMatchObject({ available: true, observed: "true" });
    expect(adaptGoalResult(goal("cache.limit"), evidence)).toMatchObject({ available: true, observed: "128" });
    expect(adaptGoalResult(goal("missing-key"), evidence)).toMatchObject({ available: false, reason: "missing_fact" });
  });
});
