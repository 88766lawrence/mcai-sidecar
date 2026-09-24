import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { extractSourceGoals } from "./goal-requirements";
import { validatePlanCompatibility } from "./plan-compatibility";

describe("constraint polarity and atomic analytical goals", () => {
  it("keeps positive atoms around local constraints without promoting forbidden actions", () => {
    const intent = [
      "列出路径 \"/extensions/telemetry-cache\" 的条目；",
      "不要写入任何 .cfg 文件，也不要安装插件或重启实例；",
      "统计其中以 .cfg 结尾的条目数和全部条目总数；",
      "确认全部条目都以 .toml 结尾；",
      "确认任意条目以 .zip 结尾；",
      "并确认 .cfg 数量不多于全部条目总数。",
    ].join("");

    const plan = draftPlan("instance", "revision", intent);
    const required = plan.source_goals.filter((goal) => goal.required);

    expect(required.filter((goal) => goal.result_kind === "collection")).toHaveLength(1);
    expect(required.filter((goal) => goal.result_kind === "filtered_count")).toHaveLength(1);
    expect(required.filter((goal) => goal.result_kind === "count")).toHaveLength(1);
    expect(required.filter((goal) => goal.result_kind === "judgement")).toHaveLength(3);
    expect(required.map((goal) => goal.entity)).toEqual(Array(6).fill("/extensions/telemetry-cache"));
    expect(required.every((goal) => !/(?:不要|安装|重启|写入)/.test(goal.source_text))).toBe(true);
    expect(plan.constraints.map((constraint) => constraint.action)).toEqual(expect.arrayContaining(["write", "install", "restart"]));
    expect(plan.steps.filter((step) => step.tool === "files.list")).toHaveLength(1);
    expect(plan.steps.some((step) => ["plugin.install", "instance.restart", "config.patch"].includes(step.tool))).toBe(false);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("creates one exact supporting collection for an explicit filtered count", () => {
    const plan = draftPlan("instance", "revision", "Count how many entries under '/packages/quarantine-bin' end in .cfg; do not install or restart anything.");
    const filtered = plan.source_goals.find((goal) => goal.result_kind === "filtered_count");
    const collection = plan.source_goals.find((goal) => goal.result_kind === "collection");
    const supporting = plan.goal_requirements.find((goal) => goal.supporting);

    expect(filtered).toMatchObject({ entity: "/packages/quarantine-bin", required: true, status: "mapped" });
    expect(collection).toMatchObject({ entity: "/packages/quarantine-bin", required: false, status: "mapped" });
    expect(filtered?.depends_on).toEqual([collection?.id]);
    expect(supporting).toMatchObject({
      target: "/packages/quarantine-bin",
      supports_source_goal_ids: [filtered?.id],
      support_reason: "collection_required_for_filtered_count",
    });
    expect(plan.steps.filter((step) => step.tool === "files.list" && step.args.path === "/packages/quarantine-bin")).toHaveLength(1);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["expands to a parent", (plan: ReturnType<typeof draftPlan>) => { plan.goal_requirements.find((goal) => goal.supporting)!.target = "/packages"; }],
    ["drops its reason", (plan: ReturnType<typeof draftPlan>) => { delete plan.goal_requirements.find((goal) => goal.supporting)!.support_reason; }],
    ["claims an unknown source", (plan: ReturnType<typeof draftPlan>) => { plan.goal_requirements.find((goal) => goal.supporting)!.supports_source_goal_ids = ["sg-unknown"]; }],
  ] as const)("rejects supporting-goal tampering that %s", (_name, mutate) => {
    const plan = draftPlan("instance", "revision", "Count how many entries under '/packages/quarantine-bin' end in .cfg.");
    mutate(plan);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: false, code: "INVALID_SUPPORTING_GOAL" });
  });
});

describe("typed predicates cover every comparison operator", () => {
  it.each([
    ["less than", "lt"],
    ["no more than", "lte"],
    ["equals", "equals"],
    ["does not equal", "not_equals"],
    ["at least", "gte"],
    ["greater than", "gt"],
  ] as const)("maps %s to %s over the same collection", (phrase, operator) => {
    const intent = `List entries under '/runtime/artifact-vault'; count entries ending in .zip and the total number of entries; determine whether the .zip count ${phrase} the total number of entries.`;
    const goals = extractSourceGoals(intent);
    const judgement = goals.find((goal) => goal.result_kind === "judgement");
    const dependencies = judgement?.depends_on.map((id) => goals.find((goal) => goal.id === id));

    expect(judgement?.predicate?.operator).toBe(operator);
    expect(dependencies?.map((goal) => goal?.result_kind)).toEqual(["filtered_count", "count"]);
    expect(dependencies?.every((goal) => goal?.entity === "/runtime/artifact-vault")).toBe(true);
    expect(judgement?.predicate?.operands.every((operand) => operand.entity === "/runtime/artifact-vault")).toBe(true);
  });
});
