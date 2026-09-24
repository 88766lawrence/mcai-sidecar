import { describe, expect, it } from "vitest";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";
import { draftPlan } from "./planner";
import { adaptGoalResult, evaluateGoalPredicate } from "./result-adapters";
import { validatePlanCompatibility } from "./plan-compatibility";
import { compileLogFilterQuery } from "./log-filter-query";
import { extractLogQueryIntent } from "./goal-requirements";

describe("log diagnostic aggregation", () => {
  it("keeps event terms that follow the log noun in the same sentence", () => {
    expect(extractLogQueryIntent("检查过去半小时的日志，找认证失败或断开连接，并判断有没有异常。")?.filter_query.groups)
      .toEqual([{ all_of: [], any_of: ["authentication_failure", "connection_failure", "disconnect"] }]);
  });
  it("keeps the published B5 request as one audited three-goal read plan", () => {
    const intent = "QA0060-B5验收：检查最近日志里有没有插件加载失败或缺少依赖，给出匹配数量并判断是否需要处理。";
    const plan = draftPlan("mcs:daemon:instance", "revision-b5-cross-layer", intent, { preferredTool: "logs.query" });
    expect(plan.steps).toEqual([expect.objectContaining({
      tool: "logs.query", risk: "read", args: expect.objectContaining({
        filter_query: expect.objectContaining({ groups: [{ all_of: ["software_component"], any_of: ["initialization_failure", "dependency_missing"] }] }),
      }),
    })]);
    expect(plan.goal_requirements.map((goal) => goal.result_kind).sort()).toEqual(["collection", "count", "judgement"]);
    expect(plan.goal_requirements.every((goal) => goal.execute_step_ids.includes("s1"))).toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    "检查近期日志中的组件初始化失败或依赖项缺失，给出数量并判断是否需要处理",
    "Review recent logs for module dependency errors or startup failures, count matches, and assess whether action is needed.",
    "判断是否要处理：查最近日志里的数据库连接超时或认证失败并统计数量",
    "Count recent log entries for proxy permission failures or malformed responses and report whether intervention is required.",
  ])("keeps collection, count, and the requested handling judgement: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-log-three-goals", intent, { preferredTool: "logs.query" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "logs.query", risk: "read" });
    expect(plan.goal_requirements.map((goal) => goal.result_kind).sort()).toEqual(["collection", "count", "judgement"]);
    const judgement = plan.goal_requirements.find((goal) => goal.result_kind === "judgement");
    const count = plan.goal_requirements.find((goal) => goal.result_kind === "count");
    expect(judgement).toMatchObject({ depends_on_goal_ids: [count?.id], predicate: expect.objectContaining({ operator: "gt" }) });
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["检查过去半小时的日志，找认证失败或断开连接，并判断有没有异常。", 30],
    ["Look through the last 2 hours for handshake errors or timed out events, then say whether it looks abnormal.", 120],
    ["最近15分钟是否出现资源包下载失败？给出异常结论。", 15],
    ["判断是否异常：读取近期记录并筛选拒绝连接与网络超时。", 60],
  ])("builds one executable read step and evidence-bound diagnostic goals: %s", (intent, windowMinutes) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-logs", intent, { preferredTool: "logs.query" });

    expect(plan.steps).toEqual([expect.objectContaining({
      id: "s1", tool: "logs.query", risk: "read",
      args: expect.objectContaining({ window_minutes: windowMinutes, max_lines: expect.any(Number), filters: expect.any(Array) }),
    })]);
    expect(plan.steps[0].args.filters).not.toHaveLength(0);
    expect(plan.steps.some((step) => ["console.command", "files.list", "config.inspect", "plugin.resolve", "instance.start", "instance.stop", "instance.restart"].includes(step.tool))).toBe(false);
    expect(plan.operation).toMatchObject({ action: "diagnose", risk: "read", requires_confirmation: false });
    expect(plan.goal_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "diagnosis", result_kind: "collection", execute_step_ids: ["s1"], status: "pending" }),
      expect.objectContaining({ domain: "diagnosis", result_kind: "count", execute_step_ids: ["s1"], status: "pending" }),
      expect.objectContaining({ domain: "diagnosis", result_kind: "judgement", execute_step_ids: ["s1"], status: "pending", predicate: expect.any(Object) }),
    ]));
    expect(plan.coverage).toBe("full");
    const compatibility = validatePlanCompatibility(plan);
    expect(compatibility, JSON.stringify(compatibility)).toMatchObject({ ok: true });
  });

  it.each([
    ["Show the most recent warning lines about chunk loading.", false],
    ["读取最近日志中的连接关闭记录。", false],
    ["Review the last day of logs for timeouts and report whether any occurred.", false],
    ["过去45分钟有多少次代理认证失败，并判断是否异常。", true],
  ])("does not invent a judgement when the user only asks for observations: %s", (intent, expectsJudgement) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-logs", intent, { preferredTool: "logs.query" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.goal_requirements.some((goal) => goal.result_kind === "judgement")).toBe(expectsJudgement);
    expect(plan.coverage).toBe("full");
  });

  it("derives collection and count from one structured callback and computes the judgement deterministically", () => {
    const evidence = [{
      kind: "logs", step_id: "s1", tool: "logs.query", at: new Date(0).toISOString(), result: "match" as const,
      summary: "Log query result: matches=2; window_minutes=30; scanned_lines=80; sample_count=2; filters=authentication_failure|timeout\nMatched samples:\n[12:10:00] Login authentication failed\n[12:12:00] Connection timed out",
    }] as TaskRecord["evidence"];
    const collection: GoalRequirement = {
      id: "g-events", description: "匹配的日志事件", domain: "diagnosis", action: "diagnose", target: "recent-logs",
      required: true, source_goal_ids: ["sg-events"], result_kind: "collection", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    };
    const count: GoalRequirement = { ...collection, id: "g-count", source_goal_ids: ["sg-count"], result_kind: "count" };
    const collectionResult = adaptGoalResult(collection, evidence);
    const countResult = adaptGoalResult(count, evidence);
    expect(collectionResult).toMatchObject({ available: true, observed: expect.arrayContaining([expect.stringContaining("authentication failed"), expect.stringContaining("timed out")]) });
    expect(countResult).toMatchObject({ available: true, observed: 2 });
    expect(evaluateGoalPredicate({
      schema_version: "goal-predicate/v2", operator: "gt", expected: true,
      left: { goal_id: "g-count", selector: "observed", domain: "diagnosis", entity: "recent-logs", result_kind: "count" },
      right: { value: 0 },
      operands: [
        { goal_id: "g-count", selector: "observed", domain: "diagnosis", entity: "recent-logs", result_kind: "count" },
        { value: 0 },
      ],
    }, new Map([["g-count", countResult.observed]]))).toMatchObject({ available: true, observed: true });
  });

  it("treats a zero-match callback as a real observation, not missing evidence", () => {
    const goal: GoalRequirement = {
      id: "g-count", description: "异常事件数量", domain: "diagnosis", action: "diagnose", target: "recent-logs",
      required: true, source_goal_ids: ["sg-count"], result_kind: "count", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    };
    const evidence = [{ kind: "logs", step_id: "s1", tool: "logs.query", at: new Date(0).toISOString(), result: "match" as const,
      summary: "Log query result: matches=0; window_minutes=20; scanned_lines=75; sample_count=0; filters=timeout\nMatched samples: <none>" }] as TaskRecord["evidence"];
    expect(adaptGoalResult(goal, evidence)).toMatchObject({ available: true, observed: 0 });
    expect(adaptGoalResult(goal, [])).toMatchObject({ available: false, reason: "missing_fact" });
  });

  it("fails closed when callback metadata conflicts with its sample count", () => {
    const goal: GoalRequirement = {
      id: "g-count", description: "异常事件数量", domain: "diagnosis", action: "diagnose", target: "recent-logs",
      required: true, source_goal_ids: ["sg-count"], result_kind: "count", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    };
    const evidence = [{ kind: "logs", step_id: "s1", tool: "logs.query", at: new Date(0).toISOString(), result: "match" as const,
      summary: "Log query result: matches=3; window_minutes=10; scanned_lines=20; sample_count=2; filters=timeout\nMatched samples:\n[12:00:00] timed out" }] as TaskRecord["evidence"];
    expect(adaptGoalResult(goal, evidence)).toMatchObject({ available: false, reason: "conflicting_authoritative_facts" });
  });

  it("fails closed when callback evidence is bound to a different structured query", () => {
    const goal: GoalRequirement = {
      id: "g-count", description: "matching event count", domain: "diagnosis", action: "diagnose", target: "recent-logs",
      required: true, source_goal_ids: ["sg-count"], result_kind: "count", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    };
    const expected = compileLogFilterQuery("check client connection failures or timeouts");
    const different = compileLogFilterQuery("show any timeout in recent logs");
    const evidence = [{ kind: "logs", step_id: "s1", tool: "logs.query", at: new Date(0).toISOString(), result: "match" as const,
      summary: `Log query result: matches=0; window_minutes=20; scanned_lines=75; sample_count=0; query_digest=${different.digest}; filters=timeout\nMatched samples: <none>` }] as TaskRecord["evidence"];
    expect(adaptGoalResult(goal, evidence, { expectedLogQueryDigest: expected.digest })).toMatchObject({ available: false, reason: "conflicting_authoritative_facts" });
  });
});
