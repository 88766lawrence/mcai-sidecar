import { describe, expect, it } from "vitest";
import { computeClauseLedgerDigest, computeSourceGoalDigest, validatePlanCompatibility } from "./plan-compatibility";
import { draftPlan } from "./planner";

describe("clause role ledger, meta requirements, and trace purity", () => {
  const mixed = [
    "Give every requested observation a real tool callback,",
    "report the exact server implementation build,",
    "列出 '/var/observatory/packets-r9' 的条目并统计总数和以 .orb 结尾的数量，",
    "判断总数不等于 .orb 数量；不要修改任何文件；随后读取 TPS；",
    "finish with one complete answer that covers every requested result.",
  ].join(" ");

  it("classifies domain, safety, evidence, response, and discourse before source atoms", () => {
    const plan = draftPlan("instance", "revision", mixed) as any;
    const roles = plan.clause_ledger.map((clause: any) => clause.role);
    expect(roles).toContain("domain_goal");
    expect(roles).toContain("safety_constraint");
    expect(roles).toContain("evidence_requirement");
    expect(roles).toContain("response_requirement");
    expect(roles).toContain("discourse");
    expect(plan.clause_ledger_digest).toBe(computeClauseLedgerDigest(plan));
    expect(plan.source_atoms.every((atom: any) => atom.clause_id)).toBe(true);
    expect(plan.source_atoms.every((atom: any) => atom.role !== "unknown")).toBe(true);
  });

  it("keeps meta requirements out of business goals and makes them enforceable", () => {
    const plan = draftPlan("instance", "revision", mixed) as any;
    expect(plan.source_goals.some((goal: any) => /callback|complete answer/i.test(goal.source_text))).toBe(false);
    expect(plan.evidence_policy).toMatchObject({ require_real_callback_per_goal: true });
    expect(plan.response_policy).toMatchObject({ cover_all_required_goals: true, require_synthesis: true });
    expect(plan.coverage).toBe("full");
  });

  it.each([
    "Report the precise server build, then show TPS.",
    "Show TPS；精确服务端实现版本也要报告；列出 '/srv/aurora/nodes-k3' 条目。",
    "列出 '/opt/meteor/index-p8' 的条目，判断是否存在 .flare 结尾项，最后报告 server implementation build。",
  ])("retains server implementation facts in every source position: %s", (intent) => {
    const plan = draftPlan("instance", "revision", intent) as any;
    const source = plan.source_goals.find((goal: any) => goal.normalized === "server.version");
    expect(source).toBeTruthy();
    const atom = plan.source_atoms.find((item: any) => item.source_goal_ids.includes(source.id));
    expect(atom?.clause_id).toBeTruthy();
    const goal = plan.goal_requirements.find((item: any) => item.source_goal_ids.includes(source.id));
    expect(goal?.execute_step_ids.length).toBeGreaterThan(0);
    expect(plan.steps.some((step: any) => step.tool === "console.command" && step.args.command === "version")).toBe(true);
  });

  it("preserves operand text and Unicode spans in source order", () => {
    const intent = "列出 '/data/nebula/shards-v5' 条目，统计总数和以 .nova 结尾的数量，并判断总数不等于 .nova 数量。";
    const plan = draftPlan("instance", "revision", intent) as any;
    const predicate = plan.source_goals.find((goal: any) => goal.predicate?.operator === "not_equals")?.predicate;
    expect(predicate.left.source_text).toContain("总数");
    expect(predicate.right.source_text).toContain(".nova");
    expect(predicate.left.source_start).toBeLessThan(predicate.right.source_start);
    expect([...intent].slice(predicate.left.source_start, predicate.left.source_end).join("")).toBe(predicate.left.source_text);
    expect([...intent].slice(predicate.right.source_start, predicate.right.source_end).join("")).toBe(predicate.right.source_text);
  });

  it("isolates a local write constraint from the following positive read", () => {
    const intent = "Inspect '/mnt/quasar/change-log' as data only；不要写入文件；之后报告 TPS 和 precise server version。";
    const plan = draftPlan("instance", "revision", intent) as any;
    const constraint = plan.clause_ledger.find((clause: any) => clause.role === "safety_constraint");
    const tps = plan.clause_ledger.find((clause: any) => clause.role === "domain_goal" && /TPS/i.test(clause.source_text));
    expect(constraint.source_text).toBe("不要写入文件");
    expect(constraint.source_end).toBeLessThanOrEqual(tps.source_start);
    expect(plan.constraints[0]).toMatchObject({ source_start: constraint.source_start, source_end: constraint.source_end, clause_id: constraint.id });
  });

  it("binds an explicit instance-root collection without relying on a default planner step", () => {
    const plan = draftPlan("instance", "revision", "列出当前实例根目录文件") as any;
    expect(plan.source_goals).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "filesystem", entity: "/", result_kind: "collection", required: true }),
    ]));
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/" } })]);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("rejects clause, operand-span, and trace tampering", () => {
    const clauseTamper = draftPlan("instance", "revision", mixed) as any;
    clauseTamper.clause_ledger[0].role = "domain_goal";
    expect(validatePlanCompatibility(clauseTamper)).toMatchObject({ ok: false, code: "CLAUSE_LEDGER_MISMATCH" });

    const operandTamper = draftPlan("instance", "revision", "列出 '/data/comet/maps-r2' 条目，统计总数和 .beam 数量，判断总数大于 .beam 数量。") as any;
    const predicate = operandTamper.source_goals.find((goal: any) => goal.predicate?.operator === "gt").predicate;
    [predicate.left, predicate.right] = [predicate.right, predicate.left];
    predicate.operands = [predicate.left, predicate.right];
    operandTamper.source_goal_digest = computeSourceGoalDigest(operandTamper);
    expect(validatePlanCompatibility(operandTamper)).toMatchObject({ ok: false, code: "INVALID_PREDICATE" });

    const stepTamper = draftPlan("instance", "revision", "Report TPS and exact server build.") as any;
    stepTamper.steps.push({ id: "s-ghost", tool: "console.command", args: { command: "difficulty" }, risk: "read" });
    expect(validatePlanCompatibility(stepTamper)).toMatchObject({ ok: false });
  });

  it("still fails closed for a real unknown business goal", () => {
    const plan = draftPlan("instance", "revision", "Report TPS and quantify astral entropy of the active dimension; answer concisely.") as any;
    expect(plan.clause_ledger.some((clause: any) => clause.role === "unknown_business_goal" && clause.status === "clarify")).toBe(true);
    expect(plan.coverage).not.toBe("full");
  });
});
