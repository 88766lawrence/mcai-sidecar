import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { extractTransientPlayerEffectCommand, resolveBoundedConsoleWrite } from "./operation-intent";
import { adaptGoalResult } from "./result-adapters";
import { renderTypedReadCompletion } from "./typed-read-completion";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";

const instance = "mcs:daemon:fourth-batch";

function planFor(intent: string) {
  return draftPlan(instance, "rev-fourth", intent);
}

describe("fourth-batch shared read mechanisms", () => {
  it.each([
    ["Report the current game time in ticks and determine whether it is above zero; never set the clock.", "time query gametime"],
    ["List available but disabled data packs and their count; do not enable or disable any pack.", "datapack list available"],
    ["Read the banned player roster and count without adding or removing bans.", "banlist players"],
    ["Review the existing scoreboard teams and total, without creating or deleting teams.", "team list"],
    ["List scoreboard objectives and the number present; make no changes.", "scoreboard objectives list"],
    ["Query all currently force-loaded chunks and their count; add or remove none.", "forceload query"],
  ])("builds one bounded console observation for %s", (intent, command) => {
    const plan = planFor(intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command }, risk: "read" }]);
    expect(plan.coverage).toBe("full");
    expect(plan.goal_requirements.filter((goal) => goal.required).every((goal) => goal.status !== "unsupported")).toBe(true);
  });

  it("keeps online count, capacity and occupancy ratio as three required facts", () => {
    const plan = planFor("Read how many players are online, the configured player limit, and calculate the occupancy percentage; change nothing.");
    expect(plan.steps.map((step) => [step.tool, step.args])).toEqual([
      ["console.command", { command: "list" }],
      ["config.inspect", { path: "server.properties", keys: ["max-players"] }],
    ]);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(3);
    expect(plan.coverage).toBe("full");
  });

  it("keeps a read-only prefix attached to an online occupancy observation instead of dropping the player read", () => {
    const plan = planFor("只读给出目前连接人数、玩家容量上限和占用百分比，不调整设置。");
    expect(plan.steps.map((step) => [step.tool, step.args])).toEqual([
      ["console.command", { command: "list" }],
      ["config.inspect", { path: "server.properties", keys: ["max-players"] }],
    ]);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(3);
    expect(plan.coverage).toBe("full");
    expect(plan.clause_ledger.some((clause) => clause.role === "domain_goal" && clause.source_goal_ids.length > 0)).toBe(true);
  });

  it("keeps one gamerule fact and its deterministic judgement", () => {
    const plan = planFor("Check randomTickSpeed and decide from its numeric value whether random ticking is disabled; do not change rules.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "gamerule randomTickSpeed" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind).sort()).toEqual(["fact", "judgement"]);
    expect(plan.coverage).toBe("full");
  });

  it("keeps process uptime, cpu, memory and pressure in one metrics step", () => {
    const plan = planFor("Show process uptime, CPU use and RAM consumption, then assess resource pressure from the observed values.");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].tool).toBe("instance.metrics");
    expect(plan.steps[0].args).toMatchObject({ schema_version: "instance-metrics/v2", metrics: ["uptime", "cpu", "memory"], include_capacity: true });
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(4);
    expect(plan.clause_ledger.filter((clause) => clause.source_goal_ids.length > 0).every((clause) => clause.role === "domain_goal" && clause.polarity === "positive")).toBe(true);
    expect(plan.coverage).toBe("full");
  });

  it("merges policy configuration, network binding and process resources into user-language conclusions", () => {
    const bindingPlan = planFor("Read server.properties server-ip and server-port and explain the current binding, without writing the file.");
    expect(bindingPlan.steps).toEqual([{ id: "s1", tool: "config.inspect", args: { path: "server.properties", keys: ["server-ip", "server-port"] }, risk: "read" }]);
    expect(bindingPlan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(bindingPlan.constraints).toEqual([expect.objectContaining({ action: "write", effect: "forbid" })]);

    const policy = renderTypedReadCompletion({
      intent: "只读查看 alpha-mode、feature-switch 和 safe-mode，并概括当前策略。", state: "SUCCEEDED", action: "read",
      goals: ["alpha-mode", "feature-switch", "safe-mode"].map((key) => ({ id: key, domain: "config", target: `service.properties#${key}`, resultKind: "fact", required: true })),
      results: [{ goalId: "alpha-mode", status: "satisfied", observed: false }, { goalId: "feature-switch", status: "satisfied", observed: true }, { goalId: "safe-mode", status: "satisfied", observed: false }],
    });
    expect(policy).toContain("策略概括");
    expect(policy).toContain("alpha-mode 已停用");

    const binding = renderTypedReadCompletion({
      intent: "只读说明服务当前监听地址和端口。", state: "SUCCEEDED", action: "read",
      goals: [
        { id: "ip", domain: "config", target: "server.properties#server-ip", resultKind: "fact", required: true },
        { id: "port", domain: "config", target: "server.properties#server-port", resultKind: "fact", required: true },
      ],
      results: [{ goalId: "ip", status: "satisfied", observed: "" }, { goalId: "port", status: "satisfied", observed: "25570" }],
    });
    expect(binding).toBe("当前未指定固定绑定地址，服务端按默认可用网络接口监听，端口为 25570。");

    const resources = renderTypedReadCompletion({
      intent: "只读报告运行时长、CPU、内存并判断资源压力。", state: "SUCCEEDED", action: "read",
      goals: [
        { id: "up", domain: "performance", target: "uptime", resultKind: "fact", required: true },
        { id: "cpu", domain: "performance", target: "cpu", resultKind: "fact", required: true },
        { id: "ram", domain: "performance", target: "memory", resultKind: "fact", required: true },
        { id: "pressure", domain: "performance", target: "resource-pressure", resultKind: "judgement", required: true },
      ],
      results: [{ goalId: "up", status: "satisfied", observed: 93720 }, { goalId: "cpu", status: "satisfied", observed: 12.5 }, { goalId: "ram", status: "satisfied", observed: 1073741824, capacity: 2147483648 }, { goalId: "pressure", status: "satisfied", observed: false }],
    });
    expect(resources).toContain("进程已运行 1天2小时2分钟");
    expect(resources).toContain("CPU 占用为 12.50%");
    expect(resources).toContain("内存占用为 1.00 GiB / 总容量 2.00 GiB");
    expect(resources).toContain("未达到高资源压力阈值");
  });

  it("routes a crash archive directory to filesystem, never runtime logs", () => {
    const plan = planFor("Inspect crash-reports for .txt files, list their names and count them; read only.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "files.list", args: { path: "/crash-reports" }, risk: "read" }]);
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
  });

  it("treats a safe directory after an English location preposition as filesystem scope", () => {
    const plan = planFor("List the .log file names under backups-archive and give their count; change nothing.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "files.list", args: { path: "/backups-archive" }, risk: "read" }]);
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(plan.coverage).toBe("full");
  });

  it("does not reinterpret a report-file collection as runtime log diagnosis", () => {
    const plan = planFor("Read the .txt report names under crash-reports and their count; do not modify anything.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "files.list", args: { path: "/crash-reports" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(plan.coverage).toBe("full");
  });

  it("recognizes cumulative game-time wording and its numeric judgement", () => {
    const plan = planFor("只读查询世界累计游戏时刻，并依据真实数值判断是否大于零；不要设置时间。");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "time query gametime" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind)).toEqual(["fact", "judgement"]);
    expect(plan.clause_ledger.some((clause) => clause.role === "safety_constraint" && clause.constraint_actions.includes("write"))).toBe(true);
    expect(plan.coverage).toBe("full");
  });

  it("recognizes a banned-player roster noun phrase without requiring passive voice", () => {
    const plan = planFor("只读列出当前封禁玩家名单及人数，不新增也不移除封禁。");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "banlist players" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(plan.coverage).toBe("full");
  });

  it("keeps a multi-word plugin identity before an artifact compatibility clause", () => {
    const plan = planFor("Only inspect metadata: determine whether Sodium Extra has an artifact compatible with Paper 1.21.1 and report the checked trusted source; never download or install it.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "plugin.resolve", args: { project: "sodium-extra", minecraft_version: "1.21.1", platform: "paper", loader: "paper", source: "modrinth" }, risk: "read" }]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["Review recent records for heap exhaustion, out-of-memory failures, or excessive GC overhead, count matches and assess memory trouble.", "memory_resource", ["heap_exhaustion", "out_of_memory", "gc_overhead"]],
    ["Check recent records for corrupt regions, failed world saves, or chunk read errors; give the count and assess storage risk.", "world_storage", ["chunk_corruption", "save_failure", "chunk_read_failure"]],
  ])("preserves a log topic and every OR event in one three-goal diagnosis: %s", (intent, topic, events) => {
    const plan = draftPlan(instance, "rev-fourth", intent, { preferredTool: "logs.query" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "logs.query", risk: "read", args: { filter_query: { groups: [{ all_of: [topic], any_of: expect.arrayContaining(events) }] } } });
    expect((plan.steps[0].args.filter_query as { groups: Array<{ any_of: string[] }> }).groups[0].any_of).toHaveLength(events.length);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind)).toEqual(["collection", "count", "judgement"]);
    expect(plan.clause_ledger.filter((clause) => clause.role === "domain_goal").every((clause) => clause.source_goal_ids.length > 0 && clause.source_atom_ids.length > 0)).toBe(true);
    expect(plan.coverage).toBe("full");
  });

  it("uses one bounded conditional player inspection instead of guessing a player name", () => {
    const plan = planFor("If anyone is online, inspect the first player's current game mode; otherwise just report that nobody is connected.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "players.inspect", args: { schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(1);
    expect(plan.coverage).toBe("full");
  });

  it("keeps connected-member conditional wording on the bounded player inspection path", () => {
    const plan = planFor("When somebody is connected, read only the first connected member's current game mode; when nobody is present, report the empty branch.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "players.inspect", args: { schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] }, risk: "read" }]);
    expect(plan.coverage).toBe("full");
  });

  it("treats zero online players as a complete conditional observation", () => {
    const goal = { id: "g1", description: "conditional", domain: "players", action: "read", target: "conditional-first-online", required: true, result_kind: "fact", source_goal_ids: ["sg1"], execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending" } as GoalRequirement;
    const evidence = [{ kind: "players", step_id: "s1", tool: "players.inspect", summary: "Player inspection v1: online_count=0; selected=<none>; gamemode=<none>; condition=no-online-players", observed: "", result: "match", timestamp: new Date(0).toISOString() }] as TaskRecord["evidence"];
    expect(adaptGoalResult(goal, evidence)).toMatchObject({ available: true, observed: { online_count: 0, selected: null, gamemode: null, skipped: true } });
  });

  it("normalizes the runtime's no-more-data-packs response as an empty available roster", () => {
    const collectionGoal = { id: "g-packs", description: "available data packs", domain: "world", action: "read", target: "world.datapacks-available", required: true, result_kind: "collection", source_goal_ids: ["sg-packs"], execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending" } as GoalRequirement;
    const countGoal = { ...collectionGoal, id: "g-packs-count", result_kind: "count" } as GoalRequirement;
    const evidence = [{ kind: "execution", step_id: "s1", tool: "console.command", summary: "There are no more data packs available", observed: "There are no more data packs available", result: "match", timestamp: new Date(0).toISOString() }] as TaskRecord["evidence"];

    expect(adaptGoalResult(collectionGoal, evidence)).toMatchObject({ available: true, observed: [] });
    expect(adaptGoalResult(countGoal, evidence)).toMatchObject({ available: true, observed: 0 });

    const bannedGoal = { ...collectionGoal, id: "g-bans", target: "world.banned-players" } as GoalRequirement;
    const bannedEvidence = [{ ...evidence[0], summary: "There are no bans", observed: "There are no bans" }] as TaskRecord["evidence"];
    expect(adaptGoalResult(bannedGoal, bannedEvidence)).toMatchObject({ available: true, observed: [] });
  });
});

describe("fourth-batch bounded transient writes", () => {
  it.each([
    ["Ring a bell once for all connected members.", "playsound minecraft:block.note_block.bell master @a ~ ~ ~ 1 1"],
    ["Display five happy villager particles once for each online player.", "execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~ 0.25 0.25 0.25 0 5 force @s"],
  ])("extracts a closed transient envelope for %s", (intent, command) => {
    expect(extractTransientPlayerEffectCommand(intent)).toBe(command);
    expect(resolveBoundedConsoleWrite(intent)).toBe(command);
  });
  it.each([
    ["Play one bell note to every connected player, and do nothing else.", /^playsound minecraft:block\.note_block\.bell master @a/],
    ["Show five happy villager particles once beside each connected player; do not change configuration.", /^execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~/],
  ])("creates one medium confirmed write for %s", (intent, command) => {
    const plan = planFor(intent);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "console.command", risk: "medium", requires_confirmation: true });
    expect(String(plan.steps[0].args.command)).toMatch(command);
    expect(plan.operation.action).toBe("write");
  });

  it("treats connected members as the audience of a transient write, not a roster read", () => {
    const plan = planFor("向所有当前在线成员播放一次钟声音效，仅此一项。");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "console.command", args: { command: "playsound minecraft:block.note_block.bell master @a ~ ~ ~ 1 1" }, risk: "medium", requires_confirmation: true });
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(1);
  });
});
