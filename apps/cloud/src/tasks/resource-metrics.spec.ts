import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { adaptGoalResult } from "./result-adapters";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";

const ref = "mcs:daemon:instance";

describe("resource metrics planning", () => {
  it.each([
    "读取当前CPU占用和内存使用，再判断资源压力",
    "How busy is this process? Report memory and CPU, then assess resource pressure.",
    "先根据实际利用率判断负载高不高，再给出 RAM usage 与 processor usage",
    "进程资源怎么样：内存、CPU以及压力结论都告诉我",
    "给出处理器利用率与运行内存，并按实际容量说明资源负担是否偏高",
  ])("uses one authoritative read for all requested facts: %s", (intent) => {
    const plan = draftPlan(ref, "rev-1", intent);
    expect(plan.coverage).toBe("full");
    expect(plan.steps).toEqual([{
      id: "s1", tool: "instance.metrics", risk: "read",
      args: { schema_version: "instance-metrics/v2", metrics: ["cpu", "memory"], include_capacity: true },
    }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.target).sort())
      .toEqual(["cpu", "memory", "resource-pressure"]);
    expect(plan.goal_requirements.every((goal) => goal.execute_step_ids.length === 1)).toBe(true);
    expect(plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
  });

  it.each([
    ["CPU现在多少", ["cpu"]],
    ["current memory usage", ["memory"]],
    ["memory and processor utilization", ["cpu", "memory"]],
  ])("preserves requested metric set: %s", (intent, metrics) => {
    const plan = draftPlan(ref, "rev-1", intent);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "instance.metrics", args: { metrics } });
    expect(plan.steps.some((step) => ["logs.query", "console.command", "files.list"].includes(step.tool))).toBe(false);
  });
});

describe("resource metrics typed adapter", () => {
  const goal = (target: string): GoalRequirement => ({
    id: `g-${target}`, description: target, domain: "performance", action: "read", target,
    required: true, source_goal_ids: [`sg-${target}`], result_kind: target === "resource-pressure" ? "judgement" : "fact",
    execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
  });
  const evidence = (summary: string): TaskRecord["evidence"] => [{
    kind: "metrics", step_id: "s1", tool: "instance.metrics", summary,
    observed: summary, result: "match", timestamp: new Date().toISOString(),
  }];

  it("derives CPU, memory and pressure from the same complete callback", () => {
    const summary = "Instance metrics v2: cpu_percent=32.5; memory_bytes=1073741824; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1";
    expect(adaptGoalResult(goal("cpu"), evidence(summary)).observed).toBe(32.5);
    expect(adaptGoalResult(goal("memory"), evidence(summary)).observed).toBe(1073741824);
    expect(adaptGoalResult(goal("resource-pressure"), evidence(summary))).toMatchObject({ available: true, observed: false });
  });

  it.each([
    "Instance metrics v2: memory_bytes=100; memory_limit_bytes=200; pressure_policy=resource-pressure/v1",
    "Instance metrics v2: cpu_percent=5; memory_bytes=100; pressure_policy=resource-pressure/v1",
    "Instance metrics v2: cpu_percent=-1; memory_bytes=100; memory_limit_bytes=200; pressure_policy=resource-pressure/v1",
    "Instance metrics v2: cpu_percent=5; memory_bytes=300; memory_limit_bytes=200; pressure_policy=resource-pressure/v1",
  ])("fails closed for incomplete or invalid authoritative fields: %s", (summary) => {
    expect(adaptGoalResult(goal("resource-pressure"), evidence(summary)).available).toBe(false);
  });
});
