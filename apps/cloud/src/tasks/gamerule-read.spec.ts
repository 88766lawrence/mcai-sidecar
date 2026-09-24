import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { adaptGoalResult } from "./result-adapters";
import { extractGameruleReadIntent } from "./gamerule-read-intent";
import { validatePlanCompatibility } from "./plan-compatibility";
import { renderTypedReadCompletion } from "./typed-read-completion";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";

describe("deterministic gamerule getter", () => {
  it.each([
    ["只查看 doFireTick 这个游戏规则目前是什么，不要调整规则", "doFireTick"],
    ["Please check the current value of gamerule randomTickSpeed; do not change it.", "randomTickSpeed"],
    ["游戏规则 mobGriefing 的当前值是多少？别修改任何游戏规则。", "mobGriefing"],
    ["Read gamerule playersSleepingPercentage only; make no changes.", "playersSleepingPercentage"],
    ["Read the current gamerule doMobLoot value only; do not modify any game rule.", "doMobLoot"],
  ])("extracts one safe getter from %s", (intent, rule) => {
    expect(extractGameruleReadIntent(intent)).toMatchObject({ rule });
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: `gamerule ${rule}` }, risk: "read" }]);
    expect(plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(plan.constraints).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", effect: "forbid" })]));
    expect(plan.goal_requirements.filter((goal) => goal.required)).toEqual([
      expect.objectContaining({ domain: "gamerule", target: rule, result_kind: "fact", execute_step_ids: ["s1"] }),
    ]);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("renders a single typed getter result in the user's language", () => {
    expect(renderTypedReadCompletion({
      intent: "查看 gamerule doMobLoot 当前值",
      state: "SUCCEEDED", action: "read",
      goals: [{ id: "g1", domain: "gamerule", target: "doMobLoot", resultKind: "fact", required: true }],
      results: [{ goalId: "g1", status: "satisfied", observed: false }],
    })).toBe("doMobLoot 当前值为 false。");
  });

  it.each([
    "set gamerule doDaylightCycle to false",
    "把游戏规则 doMobSpawning 设为 true",
    "查询 gamerule keepInventory 和 doFireTick 当前值",
    "查询 gamerule keepInventory; op Alex",
    "gamerule keepInventory true",
  ])("does not downgrade setters, ambiguous or injectable requests: %s", (intent) => {
    expect(extractGameruleReadIntent(intent)).toBeUndefined();
  });

  it("accepts one complete, rule-bound callback and rejects missing, wrong or conflicting facts", () => {
    const goal = {
      id: "g-rule", description: "read rule", domain: "gamerule", action: "read", target: "doMobLoot",
      required: true, source_goal_ids: ["sg-rule"], result_kind: "fact", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    } as GoalRequirement;
    const event = (summary: string) => ({ kind: "console", summary, at: new Date().toISOString(), step_id: "s1", tool: "console.command", result: "match" }) as TaskRecord["evidence"][number];

    expect(adaptGoalResult(goal, [event("Console output:\nGamerule doMobLoot is currently set to: false\nGamerule read result: rule=doMobLoot; value=false")])).toMatchObject({
      available: true, observed: false,
    });
    for (const summary of [
      "Console output:\ngamerule doMobLoot",
      "Console output:\nGamerule keepInventory is currently set to: false\nGamerule read result: rule=keepInventory; value=false",
      "Console output:\nGamerule doMobLoot is currently set to: false\nGamerule read result: rule=doMobLoot; value=true",
    ]) expect(adaptGoalResult(goal, [event(summary)]).available).toBe(false);
  });
});
