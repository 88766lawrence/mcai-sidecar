import { describe, expect, it } from "vitest";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";
import { draftPlan } from "./planner";
import { adaptGoalResult } from "./result-adapters";
import { validatePlanCompatibility } from "./plan-compatibility";
import { extractWhitelistReadIntent } from "./whitelist-read-intent";

describe("whitelist roster read", () => {
  it.each([
    ["列一下准入名单成员并统计数量，只读即可", true, true],
    ["How many users are on the allowlist? Show their names and do not change it.", true, true],
    ["白名单是不是空的？只查询", false, true],
    ["Show the current whitelist roster without making changes.", true, false],
  ])("recognises generic read semantics: %s", (intent, roster, count) => {
    expect(extractWhitelistReadIntent(intent)).toMatchObject({ wantsRoster: roster, wantsCount: count });
  });

  it.each([
    "把 CedarOtter 加入白名单",
    "remove RiverQuartz from the allowlist",
    "turn the whitelist off",
    "读取白名单后添加玩家 AmberPine",
  ])("does not downgrade a mutation or read-write composite: %s", (intent) => {
    expect(extractWhitelistReadIntent(intent)).toBeUndefined();
  });

  it.each([
    "列出白名单里的用户，再给出总人数；不要修改任何内容",
    "Do not add or remove anyone; list the allowlist members and count them.",
  ])("builds one evidence-bound read for roster and count: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent, { preferredTool: "console.command" });
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "whitelist list" }, risk: "read" }]);
    expect(plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(plan.goal_requirements.filter((goal) => goal.required)).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "access", target: "whitelist", result_kind: "collection", execute_step_ids: ["s1"], status: "pending" }),
      expect.objectContaining({ domain: "access", target: "whitelist", result_kind: "count", execute_step_ids: ["s1"], status: "pending" }),
    ]));
    expect(plan.coverage).toBe("full");
    expect(plan.constraints).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", effect: "forbid" })]));
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  const goal = (kind: "collection" | "count"): GoalRequirement => ({
    id: `g-whitelist-${kind}`, description: kind === "count" ? "读取白名单人数" : "读取白名单成员",
    domain: "access", action: "read", target: "whitelist", required: true,
    source_goal_ids: [`sg-whitelist-${kind}`], result_kind: kind,
    execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
  });
  const evidence = (summary: string) => [{
    kind: "console", step_id: "s1", tool: "console.command", summary,
    at: new Date(0).toISOString(), result: "match" as const,
  }] as TaskRecord["evidence"];

  it.each([
    ["There are no whitelisted players", [], 0],
    ["There is 1 whitelisted player: NovaBirch", ["NovaBirch"], 1],
    ["There are 3 whitelisted players: NovaBirch, EmberLake, QuartzFox", ["NovaBirch", "EmberLake", "QuartzFox"], 3],
    ["白名单中有 2 名玩家：青岚、星河", ["青岚", "星河"], 2],
  ])("derives roster and count from one callback: %s", (summary, roster, count) => {
    expect(adaptGoalResult(goal("collection"), evidence(summary))).toMatchObject({ available: true, observed: roster });
    expect(adaptGoalResult(goal("count"), evidence(summary))).toMatchObject({ available: true, observed: count });
  });

  it("fails closed when the explicit count conflicts with the roster", () => {
    const conflicting = evidence("There are 2 whitelisted players: OnlyOne");
    expect(adaptGoalResult(goal("collection"), conflicting)).toMatchObject({ available: false, reason: "conflicting_authoritative_facts" });
    expect(adaptGoalResult(goal("count"), conflicting)).toMatchObject({ available: false, reason: "conflicting_authoritative_facts" });
  });

  it("does not invent a roster from an unparseable callback", () => {
    expect(adaptGoalResult(goal("collection"), evidence("Command accepted"))).toMatchObject({ available: false, reason: "missing_fact" });
  });
});
