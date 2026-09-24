import { describe, expect, it } from "vitest";
import { OPERATION_POLICY_VERSION, type GoalRequirement, type TaskRecord } from "@mcai/contracts";
import { adaptGoalResult, evaluateGoalPredicate } from "./result-adapters";
import { validatePlanCompatibility } from "./plan-compatibility";
import { draftPlan } from "./planner";

const goal = (overrides: Partial<GoalRequirement> = {}): GoalRequirement => ({
  id: "g1", description: "runtime fact", domain: "server", action: "read", target: "version",
  required: true, source_goal_ids: ["sg1"], result_kind: "fact", execute_step_ids: ["s1"],
  verify_step_ids: [], evidence: [{ kind: "console", step_id: "s1" }], status: "pending", ...overrides,
});

const evidence = (summary: string, kind = "console"): TaskRecord["evidence"][number] => ({
  kind, summary, at: "2026-08-04T00:00:00.000Z", step_id: "s1", tool: "console.command",
});

describe("capability typed result adapters", () => {
  it("keeps an authoritative local server fact separate from updater diagnostics", () => {
    const result = adaptGoalResult(goal(), [evidence([
      "This server is running Purpur version 1.21.4-2287 (MC: 1.21.4)",
      "[WARN] Cannot contact build metadata service",
      "java.net.SocketTimeoutException: read timed out",
    ].join("\n"))]);
    expect(result).toMatchObject({ available: true, observed: { platform: "purpur", minecraft_version: "1.21.4" } });
    expect(result.diagnostics.join("\n")).toContain("SocketTimeoutException");
  });

  it("refuses conflicting authoritative version candidates", () => {
    const result = adaptGoalResult(goal(), [
      evidence("This server is running Fabric Loader 0.16.10 for Minecraft 1.20.6"),
      evidence("This server is running Paper version 1.21.3-91 (MC: 1.21.3)"),
    ]);
    expect(result.available).toBe(false);
    expect(result.reason).toBe("conflicting_authoritative_facts");
  });

  it("does not promote a stack trace containing the word version into a fact", () => {
    const result = adaptGoalResult(goal(), [evidence("java.lang.IllegalStateException: version manifest unavailable\n at updater.Client.fetch(Client.java:44)")]);
    expect(result.available).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("adapts file collections and suffix-filtered counts deterministically", () => {
    const files = [evidence("Directory /extensions: Alpha.JAR, beta.jar.disabled, Gamma.jar, cache, README.md", "files")];
    const collection = adaptGoalResult(goal({ domain: "plugin", target: "/extensions", result_kind: "collection", evidence: [{ kind: "files", step_id: "s1" }] }), files);
    const count = adaptGoalResult(goal({ domain: "plugin", target: "/extensions", result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".jar" }, evidence: [{ kind: "files", step_id: "s1" }] }), files);
    expect(collection.observed).toEqual(["Alpha.JAR", "beta.jar.disabled", "Gamma.jar", "cache", "README.md"]);
    expect(count.observed).toBe(2);
  });
});

describe("auditable judgement evaluation", () => {
  it("returns false when all dependencies exist but not every collection item matches", () => {
    const result = evaluateGoalPredicate({
      schema_version: "goal-predicate/v1", operator: "all_match", expected: true,
      operands: [{ goal_id: "files", selector: "observed", filter: { field: "name", operator: "suffix", value: ".jar" } }],
    }, new Map([["files", ["One.jar", "notes.yml", "Two.JAR"]]]));
    expect(result).toMatchObject({ available: true, observed: false, satisfied: false });
  });

  it("supports any-match negation and numeric comparisons without model prose", () => {
    const any = evaluateGoalPredicate({
      schema_version: "goal-predicate/v1", operator: "not", expected: true,
      operands: [{ predicate: { schema_version: "goal-predicate/v1", operator: "any_match", expected: true,
        operands: [{ goal_id: "mods", selector: "observed", filter: { field: "name", operator: "suffix", value: ".disabled" } }] } }],
    }, new Map([["mods", ["Atlas.jar", "Beacon.jar"]]]));
    const compare = evaluateGoalPredicate({
      schema_version: "goal-predicate/v1", operator: "lt", expected: true,
      operands: [{ goal_id: "errors", selector: "observed" }, { value: 3 }],
    }, new Map([["errors", 2]]));
    expect(any).toMatchObject({ observed: true, satisfied: true });
    expect(compare).toMatchObject({ observed: true, satisfied: true });
  });

  it("rejects missing or type-mismatched operands as insufficient", () => {
    const result = evaluateGoalPredicate({
      schema_version: "goal-predicate/v1", operator: "gte", expected: true,
      operands: [{ goal_id: "latency", selector: "observed" }, { value: 12 }],
    }, new Map([["latency", "unknown"]]));
    expect(result.available).toBe(false);
  });

  it.each([
    ["lt", 2, 3, true], ["lt", 3, 2, false],
    ["lte", 3, 3, true], ["lte", 4, 3, false],
    ["equals", 5, 5, true], ["equals", 5, 6, false],
    ["not_equals", 5, 6, true], ["not_equals", 5, 5, false],
    ["gte", 7, 7, true], ["gte", 6, 7, false],
    ["gt", 8, 7, true], ["gt", 7, 8, false],
  ] as const)("evaluates %s(%s, %s) to %s as an available boolean", (operator, left, right, expected) => {
    const result = evaluateGoalPredicate({
      schema_version: "goal-predicate/v1", operator, expected: true,
      operands: [{ goal_id: "filtered", selector: "observed" }, { goal_id: "total", selector: "observed" }],
    }, new Map([["filtered", left], ["total", right]]));
    expect(result).toMatchObject({ available: true, observed: expected, satisfied: expected });
  });
});

describe("Cloud pre-dispatch plan compatibility", () => {
  it("accepts representative Cloud plans and rejects an unrelated verifier", () => {
    const valid = draftPlan("mcs:d:i", "rev", "Command: gamerule doPatrolSpawning false");
    expect(validatePlanCompatibility(valid)).toEqual({ ok: true, version: OPERATION_POLICY_VERSION });
    const invalid = structuredClone(valid);
    invalid.operation.schema_version = "operation-objective/v1";
    invalid.steps[1] = { id: "s2", tool: "files.list", args: { path: "/world" }, risk: "read", purpose: "verify" };
    expect(validatePlanCompatibility(invalid)).toMatchObject({ ok: false, code: "INCOMPATIBLE_VERIFICATION" });
  });

  it("rejects predicate and Unicode source-span tampering before dispatch", () => {
    const plan = draftPlan("mcs:d:i", "rev", "List plugin directory files, then judge whether all entries have suffix .jar");
    expect(validatePlanCompatibility(plan)).toEqual({ ok: true, version: OPERATION_POLICY_VERSION });
    const predicateTamper = structuredClone(plan);
    predicateTamper.source_goals.find((goal) => goal.result_kind === "judgement")!.predicate!.expected = false;
    expect(validatePlanCompatibility(predicateTamper)).toMatchObject({ ok: false, code: "SOURCE_GOAL_DIGEST_MISMATCH" });
    const spanTamper = structuredClone(plan);
    spanTamper.source_goals[0].source_start += 1;
    expect(validatePlanCompatibility(spanTamper)).toMatchObject({ ok: false, code: "SOURCE_GOAL_DIGEST_MISMATCH" });
  });
});
