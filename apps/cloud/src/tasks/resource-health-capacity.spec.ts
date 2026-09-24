import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { validatePlanCompatibility } from "./plan-compatibility";

const ref = "mcs:daemon:instance";

describe("resource health capacity dependency", () => {
  it.each([
    "请只读汇报进程持续时间、处理器与内存使用，并说明整体资源健康是否正常。",
    "How healthy are this process's resources? Report memory, CPU and uptime.",
    "根据实际 CPU 与内存占用，判断这台进程的资源状况是否健康。",
    "Please read how long the service has been up, its processor and RAM use, and assess whether overall resource health is normal.",
  ])("requests authoritative capacity for a qualitative resource judgement: %s", (intent) => {
    const plan = draftPlan(ref, "rev-health", intent);

    expect(plan.coverage).toBe("full");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "instance.metrics",
      risk: "read",
      args: {
        schema_version: "instance-metrics/v2",
        metrics: expect.arrayContaining(["cpu", "memory"]),
        include_capacity: true,
      },
    });
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.target))
      .toEqual(expect.arrayContaining(["cpu", "memory", "resource-pressure"]));
    expect(plan.source_atoms.filter((atom) => atom.required).every((atom) => Boolean(atom.clause_id))).toBe(true);
    const compatibility = validatePlanCompatibility(plan);
    expect(compatibility, JSON.stringify(compatibility)).toMatchObject({ ok: true });
  });

  it.each([
    "只读给出服务 uptime、CPU 和 memory 使用情况。",
    "Read process uptime, CPU and memory usage only.",
  ])("does not require capacity without a derived health judgement: %s", (intent) => {
    const plan = draftPlan(ref, "rev-facts", intent);

    expect(plan.coverage).toBe("full");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "instance.metrics",
      args: { include_capacity: false },
    });
    expect(plan.goal_requirements.some((goal) => goal.target === "resource-pressure")).toBe(false);
  });
});
