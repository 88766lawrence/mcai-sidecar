import { describe, expect, it } from "vitest";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";
import { adaptGoalResult } from "./result-adapters";
import { renderTypedReadCompletion, type TypedCompletionResult } from "./typed-read-completion";

const goals = [
  { id: "up", domain: "performance", target: "uptime", resultKind: "fact", required: true },
  { id: "cpu", domain: "performance", target: "cpu", resultKind: "fact", required: true },
  { id: "ram", domain: "performance", target: "memory", resultKind: "fact", required: true },
  { id: "pressure", domain: "performance", target: "resource-pressure", resultKind: "judgement", required: true },
];

function completion(intent: string, used: number, capacity: unknown) {
  return renderTypedReadCompletion({
    intent, state: "SUCCEEDED", action: "read", goals,
    results: [
      { goalId: "up", status: "satisfied", observed: 7322 },
      { goalId: "cpu", status: "satisfied", observed: 7.25 },
      { goalId: "ram", status: "satisfied", observed: used, capacity },
      { goalId: "pressure", status: "satisfied", observed: false },
    ] as TypedCompletionResult[],
  });
}

describe("authoritative memory capacity completion", () => {
  it("renders used and total memory naturally in Chinese", () => {
    const answer = completion("读取运行时长、CPU、内存并判断资源是否健康。", 1610612736, 3221225472);
    expect(answer).toContain("内存占用为 1.50 GiB / 总容量 3.00 GiB");
    expect(answer).toContain("CPU 占用为 7.25%");
    expect(answer).toContain("未达到高资源压力阈值");
  });

  it("renders used and total memory naturally in English", () => {
    const answer = completion("Report uptime, CPU and RAM, then assess overall resource health.", 536870912, 4294967296);
    expect(answer).toContain("Memory usage is 0.50 GiB out of 4.00 GiB total");
    expect(answer).toContain("CPU usage is 7.25%");
    expect(answer).toContain("resource pressure is below the high threshold");
  });

  it("preserves a legitimate zero usage with a positive capacity", () => {
    expect(completion("报告CPU、内存和资源状态。", 0, 2147483648)).toContain("内存占用为 0.00 GiB / 总容量 2.00 GiB");
  });

  it("preserves zero usage through the authoritative adapter", () => {
    const goal: GoalRequirement = {
      id: "ram", description: "memory", domain: "performance", action: "read", target: "memory",
      required: true, source_goal_ids: ["sg-memory"], result_kind: "fact", execute_step_ids: ["s1"],
      verify_step_ids: [], evidence: [], status: "pending",
    };
    const evidence = [{
      kind: "metrics", step_id: "s1", tool: "instance.metrics",
      summary: "Instance metrics v2: cpu_percent=0; memory_bytes=0; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1",
      at: new Date(0).toISOString(), result: "match",
    }] as TaskRecord["evidence"];
    expect(adaptGoalResult(goal, evidence)).toMatchObject({ available: true, observed: 0, capacity: 2147483648 });
  });

  it("does not invent capacity for a fact-only result that lacks it", () => {
    const answer = renderTypedReadCompletion({
      intent: "Read current memory usage only.", state: "SUCCEEDED", action: "read",
      goals: [{ id: "ram", domain: "performance", target: "memory", resultKind: "fact", required: true }],
      results: [{ goalId: "ram", status: "satisfied", observed: 1073741824 }],
    });
    expect(answer).toBe("Memory usage is 1.00 GiB.");
  });

  it.each([
    [2147483649, 2147483648],
    [1, Number.NaN],
    [1, 0],
    [-1, 2147483648],
  ])("fails closed for invalid used/capacity operands: %s/%s", (used, capacity) => {
    expect(completion("读取CPU、内存并判断资源状态。", used, capacity)).toBeUndefined();
  });

  it("fails closed when authoritative callbacks conflict", () => {
    const goal: GoalRequirement = {
      id: "ram", description: "memory", domain: "performance", action: "read", target: "memory",
      required: true, source_goal_ids: ["sg-memory"], result_kind: "fact", execute_step_ids: ["s1"],
      verify_step_ids: [], evidence: [], status: "pending",
    };
    const evidence = [
      "Instance metrics v2: cpu_percent=5; memory_bytes=1073741824; memory_limit_bytes=2147483648; pressure_policy=resource-pressure/v1",
      "Instance metrics v2: cpu_percent=5; memory_bytes=1073741824; memory_limit_bytes=4294967296; pressure_policy=resource-pressure/v1",
    ].map((summary) => ({ kind: "metrics", step_id: "s1", tool: "instance.metrics", summary, at: new Date(0).toISOString(), result: "match" })) as TaskRecord["evidence"];
    expect(adaptGoalResult(goal, evidence)).toMatchObject({ available: false, reason: "conflicting_authoritative_facts" });
  });
});
