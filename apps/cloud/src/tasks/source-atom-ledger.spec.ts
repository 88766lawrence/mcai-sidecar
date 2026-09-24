import { describe, expect, it } from "vitest";
import { computeSourceGoalDigest, validatePlanCompatibility } from "./plan-compatibility";
import { draftPlan } from "./planner";

describe("source atom ledger and directed predicates", () => {
  const intent = [
    "Report TPS, list every entry under '/srv/telemetry/bundles-v7', and report the total count plus the count ending in .car;",
    "determine whether any entry ends in .sig, whether all entries end in .car, whether the .car count is less than the total count, and whether the total count is greater than the .car count.",
  ].join(" ");

  it("accounts for every positive atom before capability mapping", () => {
    const plan = draftPlan("instance", "revision", intent) as any;
    expect(plan.source_atoms.length).toBeGreaterThanOrEqual(8);
    expect(plan.source_atoms.every((atom: any) => ["mapped", "unmapped", "clarify"].includes(atom.status))).toBe(true);
    expect(plan.source_atoms.filter((atom: any) => atom.required && atom.polarity === "positive").every((atom: any) => atom.source_goal_ids.length === 1)).toBe(true);
    expect(plan.coverage).toBe("full");
    expect(plan.steps.map((step: any) => [step.tool, step.args.command ?? step.args.path])).toEqual([
      ["console.command", "tps"], ["files.list", "/srv/telemetry/bundles-v7"],
    ]);
  });

  it.each([
    ["lt", 1, 2, true], ["lte", 2, 2, true], ["gt", 3, 2, true], ["gte", 3, 3, true],
    ["equals", 4, 4, true], ["not_equals", 4, 5, true], ["lt", 2, 1, false], ["gt", 2, 3, false],
  ] as const)("evaluates directed v2 %s without reordering operands", async (operator, left, right, observed) => {
    const { evaluateGoalPredicate } = await import("./result-adapters");
    const leftOperand = { goal_id: "left", selector: "observed" as const };
    const rightOperand = { goal_id: "right", selector: "observed" as const };
    expect(evaluateGoalPredicate({ schema_version: "goal-predicate/v2", operator, left: leftOperand, right: rightOperand, operands: [leftOperand, rightOperand], expected: true }, new Map([["left", left], ["right", right]]))).toMatchObject({ available: true, observed });
  });

  it("keeps collection, total count, filtered count, and each judgement separate", () => {
    const plan = draftPlan("instance", "revision", intent) as any;
    const roles = plan.source_atoms.map((atom: any) => atom.role);
    expect(roles.filter((role: string) => role === "collection")).toHaveLength(1);
    expect(roles.filter((role: string) => role === "count")).toHaveLength(1);
    expect(roles.filter((role: string) => role === "filtered_count")).toHaveLength(1);
    expect(roles.filter((role: string) => role === "judgement")).toHaveLength(4);
  });

  it("preserves quantifier meaning and left/right comparison direction", () => {
    const plan = draftPlan("instance", "revision", intent) as any;
    const judgements = plan.source_goals.filter((goal: any) => goal.result_kind === "judgement");
    const any = judgements.find((goal: any) => goal.predicate?.quantifier === "any");
    const all = judgements.find((goal: any) => goal.predicate?.quantifier === "all");
    const comparisons = judgements.filter((goal: any) => !goal.predicate?.quantifier && ["lt", "gt"].includes(goal.predicate?.operator));
    expect(any.predicate).toMatchObject({ schema_version: "goal-predicate/v2", quantifier: "any", operator: "gt" });
    expect(all.predicate).toMatchObject({ schema_version: "goal-predicate/v2", quantifier: "all", operator: "equals" });
    expect(comparisons.map((goal: any) => [goal.predicate.left.result_kind, goal.predicate.operator, goal.predicate.right.result_kind])).toEqual([
      ["filtered_count", "lt", "count"],
      ["count", "gt", "filtered_count"],
    ]);
  });

  it("rejects atom deletion, swapped operands, and untraced extra steps", () => {
    const deleted = draftPlan("instance", "revision", intent) as any;
    deleted.source_atoms.splice(1, 1);
    deleted.source_goal_digest = computeSourceGoalDigest(deleted);
    expect(validatePlanCompatibility(deleted)).toMatchObject({ ok: false });

    const swapped = draftPlan("instance", "revision", intent) as any;
    const comparison = swapped.source_goals.find((goal: any) => goal.predicate?.operator === "lt");
    [comparison.predicate.left, comparison.predicate.right] = [comparison.predicate.right, comparison.predicate.left];
    swapped.source_goal_digest = computeSourceGoalDigest(swapped);
    expect(validatePlanCompatibility(swapped)).toMatchObject({ ok: false });

    const extra = draftPlan("instance", "revision", intent) as any;
    extra.steps.push({ id: "s-untraced", tool: "console.command", args: { command: "difficulty" }, risk: "read" });
    expect(validatePlanCompatibility(extra)).toMatchObject({ ok: false, code: "OPERATION_DIGEST_MISMATCH" });
  });

  it("does not invent a second observation unless explicitly requested", () => {
    const ordinary = draftPlan("instance", "revision", "Show TPS and list '/opt/runtime/segments' entries.");
    expect(ordinary.steps).toHaveLength(2);
    expect(ordinary.steps.every((step) => step.purpose !== "verify")).toBe(true);
    const rechecked = draftPlan("instance", "revision", "Show TPS and list '/opt/runtime/segments' entries, then independently recheck both observations.");
    expect(rechecked.steps.map((step) => step.purpose ?? "execute")).toEqual(["execute", "verify", "execute", "verify"]);
  });

  it.each([
    "List '/data/relay/tiles-a4' entries; report the total number of entries; count entries ending in .arc; determine whether all names end in .arc; determine whether any name ends in .tmp; determine whether .arc count is less than total count.",
    "列出 '/opt/ledger/chunks-q2' 的全部文件；统计总数；统计以 .seg 结尾的文件数；判断是否存在以 .old 结尾的文件；判断所有文件是否以 .seg 结尾；判断总数是否大于 .seg 数量。",
  ])("keeps atom multiset and trace closure under fresh ordering: %s", (variant) => {
    const plan = draftPlan("instance", "revision", variant) as any;
    const roles = plan.source_atoms.filter((atom: any) => atom.required).map((atom: any) => atom.role);
    expect(roles.filter((role: string) => role === "collection")).toHaveLength(1);
    expect(roles.filter((role: string) => role === "count")).toHaveLength(1);
    expect(roles.filter((role: string) => role === "filtered_count")).toHaveLength(1);
    expect(roles.filter((role: string) => role === "judgement")).toHaveLength(3);
    expect(plan.coverage).toBe("full");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "files.list" });
    expect(plan.goal_requirements.every((goal: any) => goal.execute_step_ids.length > 0 || goal.depends_on_goal_ids?.length > 0)).toBe(true);
  });

  it("fails coverage closed when an unfamiliar coordinated target follows a known fact", () => {
    const plan = draftPlan("instance", "revision", "Report TPS and calculate lunar resonance for the active world.") as any;
    expect(plan.source_atoms.some((atom: any) => atom.role === "unknown" && atom.status === "clarify")).toBe(true);
    expect(plan.coverage).not.toBe("full");
  });
});
