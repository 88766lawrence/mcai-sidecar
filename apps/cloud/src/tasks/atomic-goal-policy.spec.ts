import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { aggregateOperationAction, canonicalOperationPolicy, intrinsicToolPolicy, OPERATION_POLICY_DIGEST } from "@mcai/contracts";
import { extractSourceGoals } from "./goal-requirements";
import { draftPlan } from "./planner";
import { validatePlanCompatibility } from "./plan-compatibility";

describe("atomic goal graph and domain routing", () => {
  it("preserves a filesystem collection, filtered count, and two independent judgements", () => {
    const intent = [
      "只读确认服务端版本；",
      "列出路径 \"/diagnostics/archive\" 的目录条目；",
      "统计其中以 .json 结尾的文件数量；",
      "判断所有目录条目是否都以 .json 结尾；",
      "并判断 .json 文件数量是否小于目录条目总数。",
      "不要修改、安装或重启。",
    ].join("");

    const goals = extractSourceGoals(intent);
    expect(goals.filter((goal) => goal.result_kind === "collection")).toHaveLength(1);
    expect(goals.filter((goal) => goal.result_kind === "filtered_count")).toHaveLength(1);
    expect(goals.filter((goal) => goal.result_kind === "judgement")).toHaveLength(2);
    expect(goals.find((goal) => goal.result_kind === "collection")).toMatchObject({
      domain: "filesystem",
      entity: "/diagnostics/archive",
    });
    expect(goals.filter((goal) => goal.result_kind === "judgement").every((goal) => goal.source_text.length > 8)).toBe(true);
    expect(goals.every((goal) => intent.includes(goal.source_text))).toBe(true);
  });

  it("keeps an English path collection and both predicates separate", () => {
    const intent = "List entries under '/events/plugins-cache'; count files ending in .zip; decide whether any entry ends in .zip; and whether the matching count equals zero.";
    const goals = extractSourceGoals(intent);

    expect(goals.map((goal) => goal.result_kind)).toEqual([
      "collection",
      "filtered_count",
      "judgement",
      "judgement",
    ]);
    expect(goals[0]).toMatchObject({ domain: "filesystem", entity: "/events/plugins-cache" });
    expect(goals[2].predicate?.operands[0]?.goal_id).toBe(goals[0].id);
    expect(goals[3].predicate?.operands[0]?.goal_id).toBe(goals[1].id);
  });

  it.each([
    "/diagnostics/archive",
    "/events/runtime",
    "/plugin/log-cache",
  ])("routes explicit directory semantics for %s to files.list", (path) => {
    const plan = draftPlan("instance", "revision", `列出路径 \"${path}\" 的目录条目，并统计 .json 后缀文件数量`);
    expect(plan.steps.some((step) => step.tool === "files.list" && step.args.path === path)).toBe(true);
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
  });

  it("routes a true runtime-log diagnosis to logs.query with diagnose action", () => {
    const plan = draftPlan("instance", "revision", "读取最近 15 分钟运行日志中的 ERROR 和 WARN，判断是否存在崩溃证据");
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(true);
    expect(plan.operation.action).toBe("diagnose");
  });

  it("aggregates read plus diagnose as diagnose and passes Cloud preflight", () => {
    const plan = draftPlan("instance", "revision", "确认服务端版本；诊断最近 20 分钟运行日志中的错误");
    expect(plan.steps.map((step) => step.tool)).toEqual(["console.command", "logs.query"]);
    expect(plan.operation.action).toBe("diagnose");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    "List '/telemetry/bundles', count .zip files, decide whether every entry ends in .zip, and determine whether the matching count is zero.",
    "列出路径 \"/audit/snapshots\" 的条目；统计 .json 文件数量；判断是否存在 .json 文件；并判断 .json 数量是否小于目录条目总数。",
    "Show files in '/extensions/cache-store'; count .disabled entries; determine whether any item ends in .disabled; and whether that count equals zero.",
  ])("keeps every atom and predicate in a fresh composite request: %s", (intent) => {
    const goals = extractSourceGoals(intent);
    expect(goals.filter((goal) => goal.result_kind === "collection")).toHaveLength(1);
    expect(goals.filter((goal) => goal.result_kind === "filtered_count")).toHaveLength(1);
    expect(goals.filter((goal) => goal.result_kind === "judgement")).toHaveLength(2);
    expect(goals.filter((goal) => goal.result_kind === "judgement").every((goal) => goal.status === "mapped" && goal.predicate)).toBe(true);
  });

  it("rejects cross-domain and result-kind predicate tampering", () => {
    const plan = draftPlan("instance", "revision", "List '/artifacts/releases'; count .zip files; determine whether any entry ends in .zip.");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
    const judgement = plan.source_goals.find((goal) => goal.result_kind === "judgement")!;
    judgement.predicate!.operands[0].domain = "players";
    plan.source_goal_digest = recomputeSourceDigestForTest(plan);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: false, code: "INVALID_PREDICATE" });
  });

  it("rejects an unsupported collection field even when the source digest is recomputed", () => {
    const plan = draftPlan("instance", "revision", "Show '/packages/incoming'; decide whether every entry ends in .tar.");
    const judgement = plan.source_goals.find((goal) => goal.result_kind === "judgement")!;
    judgement.predicate!.operands[0].filter!.field = "playerName";
    plan.source_goal_digest = recomputeSourceDigestForTest(plan);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: false, code: "INVALID_PREDICATE" });
  });
});

function recomputeSourceDigestForTest(plan: ReturnType<typeof draftPlan>) {
  const source_goals = plan.source_goals.map((goal) => ({
    id: goal.id, source_text: goal.source_text, source_start: goal.source_start, source_end: goal.source_end,
    normalized: goal.normalized, domain: goal.domain, entity: goal.entity, result_kind: goal.result_kind,
    filter: goal.filter ?? null, item_schema: goal.item_schema ?? null, predicate: goal.predicate ?? null,
    depends_on: goal.depends_on, required: goal.required, status: goal.status,
  }));
  const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonicalize({ intent: plan.intent, source_atoms: plan.source_atoms, source_goals }))).digest("hex");
}

describe("canonical operation policy", () => {
  it.each(Object.entries(canonicalOperationPolicy.tools))("loads the canonical facts for %s", (tool, expected) => {
    expect(intrinsicToolPolicy(tool)).toMatchObject({
      action: expected.action,
      risk: expected.risk,
      requires_confirmation: expected.requires_confirmation,
      mutates: expected.mutates,
      evidence_kind: expected.evidence_kind,
    });
  });

  it.each(canonicalOperationPolicy.action_vectors)("derives the shared action vector $name", (vector) => {
    expect(aggregateOperationAction(vector.tools.map((tool, index) => ({
      id: `s${index + 1}`, tool, args: tool === "console.command" ? { command: vector.console_command } : {}, risk: "read" as const,
    })))).toBe(vector.expected);
  });

  it("binds the runtime version to the canonical policy digest", () => {
    expect(OPERATION_POLICY_DIGEST).toBe(canonicalOperationPolicy.digest);
  });
});
