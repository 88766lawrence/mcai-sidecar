import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { adaptGoalResult } from "./result-adapters";
import { extractRuntimeConsoleRead } from "./runtime-console-read";

const instance = "mcs:daemon:runtime-facts";

describe("runtime console observations", () => {
  it("recognizes enabled datapack inventory without treating state words as mutations", () => {
    expect(extractRuntimeConsoleRead("List the enabled data packs and give their count; do not enable or disable anything.")?.command).toBe("datapack list enabled");
  });
  it.each([
    ["Read the active world's seed without changing world settings.", "seed", ["world.seed"]],
    ["Report the current difficulty and determine whether it is peaceful; do not alter it.", "difficulty", ["world.difficulty", "world.difficulty-peaceful"]],
    ["Tell me the current daytime tick and whether that means day or night, without setting the clock.", "time query daytime", ["world.daytime", "world.day-period"]],
    ["读取主世界现有daytime刻数，再据此判断昼间或夜间，禁止改变时间。", "time query daytime", ["world.daytime", "world.day-period"]],
    ["Check the world's present border diameter without resizing it.", "worldborder get", ["world.border-diameter"]],
    ["Check the current world border width and keep its configuration unchanged.", "worldborder get", ["world.border-diameter"]],
    ["List the enabled data packs and give their count; do not enable or disable anything.", "datapack list enabled", ["world.datapacks-enabled", "world.datapacks-enabled-count"]],
  ])("creates one auditable read for %s", (intent, command, normalizedGoals) => {
    const plan = draftPlan(instance, "rev-runtime", intent);
    expect(plan.operation.action).toBe("read");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command }, risk: "read" }]);
    expect(plan.source_goals.filter((goal) => goal.required).map((goal) => goal.normalized)).toEqual(normalizedGoals);
    expect(plan.goal_requirements.filter((goal) => goal.required).every((goal) => goal.status !== "unsupported")).toBe(true);
    expect(plan.coverage).toBe("full");
  });

  it("keeps a requested clear-weather mutation while excluding unrelated writes", () => {
    const plan = draftPlan(instance, "rev-weather", "Set the overworld weather to clear; do not change anything else and do not restart the server.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "weather clear" }, risk: "medium", requires_confirmation: true }]);
    expect(plan.operation.action).toBe("write");
    expect(plan.constraints.map((constraint) => constraint.action)).toContain("restart");
  });

  it.each([
    ["world.seed", "Seed: [827364]", "827364"],
    ["world.seed", "Seed: [9007199254740993]", "9007199254740993"],
    ["world.seed", "Seed: [-9007199254740995]", "-9007199254740995"],
    ["world.difficulty", "The difficulty is Normal", "normal"],
    ["world.daytime", "The time is 13650", 13650],
    ["world.border-diameter", "The world border is currently 5.9999968E7 blocks wide", 59999968],
    ["world.border-diameter", "The world border is currently 59999968 block(s) wide", 59999968],
  ])("adapts %s only from a parseable callback", (target, summary, expected) => {
    const result = adaptGoalResult({
      id: `g-${target}`, description: target, domain: "world", action: "read", target,
      required: true, source_goal_ids: [], result_kind: "fact", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    }, [{ kind: "console", summary, step_id: "s1", tool: "console.command" } as never]);
    expect(result.available).toBe(true);
    expect(result.observed).toEqual(expected);
  });

  it.each([
    "Seed: [9x07199254740993]",
    "Seed: [9007199254740993]\nSeed: [9007199254740995]",
  ])("fails closed for invalid or conflicting long integer facts: %s", (summary) => {
    const result = adaptGoalResult({
      id: "g-seed", description: "seed", domain: "world", action: "read", target: "world.seed",
      required: true, source_goal_ids: [], result_kind: "fact", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    }, [{ kind: "console", summary, step_id: "s1", tool: "console.command" } as never]);
    expect(result.available).toBe(false);
  });
});
