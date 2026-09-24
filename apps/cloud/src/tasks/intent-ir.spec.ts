import { describe, expect, it, vi } from "vitest";
import type { IntentCandidate, IntentCandidateV2, IntentIRProposal, IntentSemanticFrameBatch } from "@mcai/contracts";
import { buildIntentSemanticFramePlan, buildIntentSourceCatalog, compileIntentCandidate, compileIntentCandidateV2, compileIntentIR, mergeIntentSemanticFrames, validateIntentIRProposal } from "./intent-ir";
import { draftPlan } from "./planner";
import { validatePlanCompatibility } from "./plan-compatibility";

const source = "Give a read-only realm build, enumerate one-level entries in '/srv/orchid/artifacts', report total and .bundle count, verify any entry is .bundle and total >= filtered; never alter settings; every finding must cite a callback, then synthesize all findings.";

function span(text: string) {
  const start = [...source.slice(0, source.indexOf(text))].length;
  return { source_text: text, source_start: start, source_end: start + [...text].length };
}
function spanAfter(text: string, after: string) {
  const index = source.indexOf(text, source.indexOf(after));
  const start = [...source.slice(0, index)].length;
  return { source_text: text, source_start: start, source_end: start + [...text].length };
}

function proposal(): IntentIRProposal {
  return {
    schema_version: "intent-ir/v1",
    clauses: [
      { id: "c1", ...span("Give a read-only realm build"), role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered server fact" },
      { id: "c2", ...span("enumerate one-level entries in '/srv/orchid/artifacts'"), role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered filesystem collection" },
      { id: "c3", ...span("report total and .bundle count"), role: "domain_goal", polarity: "positive", status: "mapped", reason: "two explicit result kinds" },
      { id: "c4", ...span("verify any entry is .bundle and total >= filtered"), role: "domain_goal", polarity: "positive", status: "mapped", reason: "quantifier and ordered comparison" },
      { id: "c5", ...span("never alter settings"), role: "safety_constraint", polarity: "negative", status: "mapped", reason: "write forbidden" },
      { id: "c6", ...span("every finding must cite a callback"), role: "evidence_requirement", polarity: "neutral", status: "mapped", reason: "real callback per goal" },
      { id: "c7", ...span("then synthesize all findings"), role: "response_requirement", polarity: "neutral", status: "mapped", reason: "complete synthesis" },
    ],
    goals: [
      { id: "i1", clause_id: "c1", ...span("realm build"), domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true },
      { id: "i2", clause_id: "c2", ...span("'/srv/orchid/artifacts'"), domain: "filesystem", entity: "/srv/orchid/artifacts", capability: "filesystem.list", target: "/srv/orchid/artifacts", parameters: { path: "/srv/orchid/artifacts" }, result_kind: "collection", item_schema: { name: "string" }, required: true },
      { id: "i3", clause_id: "c3", ...span("total"), domain: "filesystem", entity: "/srv/orchid/artifacts", capability: "filesystem.count", target: "/srv/orchid/artifacts", parameters: {}, result_kind: "count", depends_on: ["i2"], required: true },
      { id: "i4", clause_id: "c3", ...span(".bundle count"), domain: "filesystem", entity: "/srv/orchid/artifacts", capability: "filesystem.filtered_count", target: "/srv/orchid/artifacts", parameters: {}, result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".bundle" }, depends_on: ["i2"], required: true },
    ],
    scopes: [{ id: "s1", clause_id: "c2", goal_id: "i2", ...span("one-level"), kind: "depth", value: 1 }],
    constraints: [{ id: "k1", clause_id: "c5", ...span("never alter settings"), action: "write", effect: "forbid" }],
    evidence_requirements: [{ id: "e1", clause_id: "c6", ...span("every finding must cite a callback"), kind: "real_callback_per_goal", goal_ids: ["i1", "i2", "i3", "i4"] }],
    response_requirements: [{ id: "r1", clause_id: "c7", ...span("synthesize all findings"), kind: "synthesis", goal_ids: ["i1", "i2", "i3", "i4"] }],
    predicates: [
      { id: "p1", clause_id: "c4", ...span("any entry is .bundle"), kind: "quantifier", quantifier: "any", collection_goal_id: "i2", filter: { field: "name", operator: "suffix", value: ".bundle" }, expected: true },
      { id: "p2", clause_id: "c4", ...span("total >= filtered"), kind: "binary", operator: "gte", left: { ...spanAfter("total", "total >= filtered"), goal_id: "i3", selector: "count" }, right: { ...spanAfter("filtered", "total >= filtered"), goal_id: "i4", selector: "filtered_count" }, expected: true },
    ],
    unknown_goals: [],
  };
}

describe("typed intent semantic compiler", () => {
  it("builds an immutable Unicode SourceRef catalog and distinguishes repeated text", () => {
    const text = "检查星港😀；不要重启。\n检查星港😀；只汇总。";
    const catalog = buildIntentSourceCatalog(text);
    expect(catalog.schema_version).toBe("intent-source-catalog/v1");
    expect(catalog.refs.map((ref) => ref.text)).toEqual(["检查星港😀；", "不要重启。", "检查星港😀；", "只汇总。"]);
    expect(catalog.refs[0].id).not.toBe(catalog.refs[2].id);
    expect(catalog.refs.every((ref) => [...text].slice(ref.source_start, ref.source_end).join("") === ref.text)).toBe(true);
    expect(catalog.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("expands candidate v2 refs without asking the model to reproduce source text", () => {
    const text = "Inspect aurora build; never restart; cite callbacks.";
    const catalog = buildIntentSourceCatalog(text);
    const candidate: IntentCandidateV2 = {
      schema_version: "intent-candidate/v2",
      clauses: [
        { source_refs: [catalog.refs[0].id], role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered fact" },
        { source_refs: [catalog.refs[1].id], role: "safety_constraint", polarity: "negative", status: "mapped", reason: "forbidden lifecycle action" },
        { source_refs: [catalog.refs[2].id], role: "evidence_requirement", polarity: "neutral", status: "mapped", reason: "callback evidence" },
      ],
      goals: [{ source_refs: [catalog.refs[0].id], clause: 0, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true }],
      scopes: [],
      constraints: [{ source_refs: [catalog.refs[1].id], clause: 1, action: "restart", effect: "forbid" }],
      evidence_requirements: [{ source_refs: [catalog.refs[2].id], clause: 2, kind: "real_callback_per_goal", goals: [0] }],
      response_requirements: [], predicates: [], unknown_goals: [],
    };
    const result = compileIntentCandidateV2(text, catalog, candidate);
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.goals[0].source_ref_ids).toEqual([catalog.refs[0].id]);
    expect(result.proposal.source_catalog?.digest).toBe(catalog.digest);
  });

  it("fails closed for unknown refs, catalog tampering, and model-owned source fields", () => {
    const text = "Read comet build.";
    const catalog = buildIntentSourceCatalog(text);
    const candidate = {
      schema_version: "intent-candidate/v2",
      clauses: [{ source_refs: ["missing"], role: "domain_goal", polarity: "positive", status: "mapped", reason: "fact", quote: "rewritten" }],
      goals: [], scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    } as unknown as IntentCandidateV2;
    const bad = compileIntentCandidateV2(text, catalog, candidate);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["FORBIDDEN_CANDIDATE_FIELD", "UNKNOWN_SOURCE_REF"]));
    const tampered = structuredClone(catalog);
    tampered.refs[0].text = "changed";
    expect(compileIntentCandidateV2(text, tampered, { ...candidate, clauses: [{ source_refs: [catalog.refs[0].id], role: "domain_goal", polarity: "positive", status: "mapped", reason: "fact" }] }).ok).toBe(false);
  });

  it("allows one immutable ref to support a goal and a local safety constraint", () => {
    const text = "Inspect the shard and never write.";
    const catalog = buildIntentSourceCatalog(text);
    const ref = catalog.refs[0].id;
    const result = compileIntentCandidateV2(text, catalog, {
      schema_version: "intent-candidate/v2",
      clauses: [
        { source_refs: [ref], role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered fact" },
        { source_refs: [ref], role: "safety_constraint", polarity: "negative", status: "mapped", reason: "local write prohibition" },
      ],
      goals: [{ source_refs: [ref], clause: 0, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true }],
      scopes: [], constraints: [{ source_refs: [ref], clause: 1, action: "write", effect: "forbid" }], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
  });

  it("turns validated AI Boolean log branches into one bounded query shared by collection and count", () => {
    const text = "Check recent diagnostics and report matching entries plus their count.";
    const catalog = buildIntentSourceCatalog(text);
    const ref = catalog.refs[0].id;
    const parameters = {
      window_minutes: 60,
      max_lines: 480,
      filter_groups: [
        { all_of: ["memory_resource", "out_of_memory"], any_of: [] },
        { all_of: ["server_lag", "cannot_keep_up"], any_of: [] },
      ],
    };
    const expanded = compileIntentCandidateV2(text, catalog, {
      schema_version: "intent-candidate/v2",
      clauses: [{ source_refs: [ref], role: "domain_goal", polarity: "positive", status: "mapped", reason: "two observable log results" }],
      goals: [
        { source_refs: [ref], clause: 0, domain: "diagnosis", entity: "recent-logs", capability: "logs.query", target: "recent-logs", parameters, result_kind: "collection", required: true },
        { source_refs: [ref], clause: 0, domain: "diagnosis", entity: "recent-logs", capability: "logs.query", target: "recent-logs", parameters, result_kind: "count", depends_on: [0], required: true },
      ],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    });
    expect(expanded.ok, expanded.ok ? undefined : JSON.stringify(expanded.errors)).toBe(true);
    if (!expanded.ok) return;
    const compiled = compileIntentIR(text, expanded.proposal, { providerModel: "fixture-compiler", attempt: 1 });
    expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    const plan = draftPlan("mcs:daemon:instance", "rev-ai-log", text, { intentIR: compiled.ir });
    expect(plan.coverage).toBe("full");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      tool: "logs.query",
      args: {
        window_minutes: 60,
        max_lines: 480,
        filters: ["out_of_memory", "cannot_keep_up"],
        filter_query: { groups: parameters.filter_groups },
      },
      risk: "read",
    });
    expect(plan.goal_requirements).toHaveLength(2);
    expect(plan.goal_requirements.every((goal) => goal.execute_step_ids[0] === "s1")).toBe(true);
  });

  it("rejects collapsing explicit independent log OR clauses into one Boolean group", () => {
    const text = "Review recent alerts for proxy handshake rejection, or world snapshot corruption; report the matching total.";
    const catalog = buildIntentSourceCatalog(text);
    const refs = catalog.refs.map((item) => item.id);
    const makeCandidate = (filter_groups: Array<{ all_of: string[]; any_of: string[] }>): IntentCandidateV2 => ({
      schema_version: "intent-candidate/v2",
      clauses: [{ source_refs: refs, role: "domain_goal", polarity: "positive", status: "mapped", reason: "two independent diagnostic alternatives" }],
      goals: [{
        source_refs: refs, clause: 0, domain: "diagnosis", entity: "recent-logs", capability: "logs.query", target: "recent-logs",
        parameters: { window_minutes: 30, max_lines: 240, filter_groups }, result_kind: "collection", required: true,
      }],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    });
    const collapsed = compileIntentCandidateV2(text, catalog, makeCandidate([
      { all_of: ["proxy_service", "authentication_failure", "world_storage", "chunk_corruption"], any_of: [] },
    ]));
    expect(collapsed.ok).toBe(false);
    if (!collapsed.ok) expect(collapsed.errors.map((error) => error.code)).toContain("LOG_FILTER_OR_BRANCH_COLLAPSE");
    const preserved = compileIntentCandidateV2(text, catalog, makeCandidate([
      { all_of: ["proxy_service", "authentication_failure"], any_of: [] },
      { all_of: ["world_storage", "chunk_corruption"], any_of: [] },
    ]));
    expect(preserved.ok, preserved.ok ? undefined : JSON.stringify(preserved.errors)).toBe(true);
  });

  it("turns an AI plugin inventory decomposition into one read-only callback for names and count", () => {
    const text = "Show the loaded plugin names and total count without changing anything.";
    const catalog = buildIntentSourceCatalog(text);
    const ref = catalog.refs[0].id;
    const expanded = compileIntentCandidateV2(text, catalog, {
      schema_version: "intent-candidate/v2",
      clauses: [
        { source_refs: [ref], role: "domain_goal", polarity: "positive", status: "mapped", reason: "observable inventory" },
        { source_refs: [ref], role: "safety_constraint", polarity: "negative", status: "mapped", reason: "write forbidden" },
      ],
      goals: [
        { source_refs: [ref], clause: 0, domain: "plugin", entity: "loaded-plugins", capability: "plugins.loaded", target: "loaded-plugins", parameters: { command: "plugins" }, result_kind: "collection", required: true },
        { source_refs: [ref], clause: 0, domain: "plugin", entity: "loaded-plugins", capability: "plugins.loaded", target: "loaded-plugins", parameters: { command: "plugins" }, result_kind: "count", depends_on: [0], required: true },
      ],
      scopes: [], constraints: [{ source_refs: [ref], clause: 1, action: "write", effect: "forbid" }],
      evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    });
    expect(expanded.ok, expanded.ok ? undefined : JSON.stringify(expanded.errors)).toBe(true);
    if (!expanded.ok) return;
    const compiled = compileIntentIR(text, expanded.proposal, { providerModel: "fixture-compiler", attempt: 1 });
    expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    const plan = draftPlan("mcs:daemon:instance", "rev-ai-plugin", text, { intentIR: compiled.ir });
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "plugins" }, risk: "read" }]);
    expect(plan.goal_requirements).toHaveLength(2);
    expect(plan.goal_requirements.every((goal) => goal.execute_step_ids[0] === "s1")).toBe(true);
  });

  it("matches the fixed TS-Go SourceRef v2 digest vector", () => {
    const text = "Read quartz build.";
    const catalog = buildIntentSourceCatalog(text);
    const expanded = compileIntentCandidateV2(text, catalog, {
      schema_version: "intent-candidate/v2",
      clauses: [{ source_refs: [catalog.refs[0].id], role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered server fact" }],
      goals: [{ source_refs: [catalog.refs[0].id], clause: 0, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true }],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const compiled = compileIntentIR(text, expanded.proposal, { providerModel: "fixture-compiler", attempt: 1 });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.ir.digest).toBe("39e0eb0a62081ac852f1f44577337266ef91aaa96466543fa058b5344364b844");
  });

  it("expands compact quote references into deterministic Unicode spans and full IR ids", () => {
    const text = "核对 星港 build；不要改配置；每项引用真实回调。";
    const candidate: IntentCandidate = {
      schema_version: "intent-candidate/v1",
      clauses: [
        { quote: "核对 星港 build", occurrence: 1, role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered fact" },
        { quote: "不要改配置", occurrence: 1, role: "safety_constraint", polarity: "negative", status: "mapped", reason: "write forbidden" },
        { quote: "每项引用真实回调", occurrence: 1, role: "evidence_requirement", polarity: "neutral", status: "mapped", reason: "callback evidence" },
      ],
      goals: [{ clause: 0, quote: "星港 build", occurrence: 1, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true }],
      scopes: [],
      constraints: [{ clause: 1, quote: "不要改配置", occurrence: 1, action: "write", effect: "forbid" }],
      evidence_requirements: [{ clause: 2, quote: "每项引用真实回调", occurrence: 1, kind: "real_callback_per_goal", goals: [0] }],
      response_requirements: [], predicates: [], unknown_goals: [],
    };
    const expanded = compileIntentCandidate(text, candidate);
    expect(expanded.ok, expanded.ok ? undefined : JSON.stringify(expanded.errors)).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.proposal.goals[0]).toMatchObject({ id: "goal-1", clause_id: "clause-1", source_text: "星港 build" });
    expect(expanded.proposal.constraints[0]).toMatchObject({ id: "constraint-1", clause_id: "clause-2" });
    expect(expanded.proposal.evidence_requirements[0].goal_ids).toEqual(["goal-1"]);
  });

  it("fails closed for missing, ambiguous, or out-of-range quote occurrences", () => {
    const base: IntentCandidate = {
      schema_version: "intent-candidate/v1",
      clauses: [{ quote: "巡检", occurrence: 1, role: "domain_goal", polarity: "positive", status: "mapped", reason: "fact" }],
      goals: [], scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    };
    expect(compileIntentCandidate("巡检，然后再次巡检", { ...base, clauses: [{ ...base.clauses[0], occurrence: 0 }] }).ok).toBe(false);
    expect(compileIntentCandidate("巡检，然后再次巡检", { ...base, clauses: [{ ...base.clauses[0], occurrence: 3 }] }).ok).toBe(false);
    expect(compileIntentCandidate("检查一次", base).ok).toBe(false);
  });

  it("rejects model-owned risk, tool, step, terminal-state fields and omitted safety constraints", () => {
    const text = "Inspect Nebula build; never modify config.";
    const candidate = {
      schema_version: "intent-candidate/v1",
      clauses: [
        { quote: "Inspect Nebula build", occurrence: 1, role: "domain_goal", polarity: "positive", status: "mapped", reason: "fact" },
        { quote: "never modify config", occurrence: 1, role: "discourse", polarity: "neutral", status: "mapped", reason: "ignored", risk: "read" },
      ],
      goals: [{ clause: 0, quote: "Nebula build", occurrence: 1, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true, tool: "console.command", steps: [], terminal_state: "SUCCEEDED" }],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    } as unknown as IntentCandidate;
    const result = compileIntentCandidate(text, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.code)).toContain("FORBIDDEN_CANDIDATE_FIELD");

    const stripped = structuredClone(candidate) as unknown as Record<string, unknown>;
    const clauses = stripped.clauses as Array<Record<string, unknown>>;
    delete clauses[1].risk;
    const goals = stripped.goals as Array<Record<string, unknown>>;
    delete goals[0].tool; delete goals[0].steps; delete goals[0].terminal_state;
    const constraintResult = compileIntentCandidate(text, stripped as unknown as IntentCandidate);
    expect(constraintResult.ok).toBe(false);
    if (!constraintResult.ok) expect(constraintResult.errors.map((error) => error.code)).toContain("MISSING_CONSERVATIVE_CONSTRAINT");
  });

  it("matches the fixed TS-Go canonical digest vector", () => {
    const text = "Read realm build from the active shard.";
    const vector: IntentIRProposal = {
      schema_version: "intent-ir/v1",
      clauses: [{ id: "c-realm", source_text: text, source_start: 0, source_end: [...text].length, role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered server fact" }],
      goals: [{ id: "i-build", clause_id: "c-realm", source_text: "realm build", source_start: 5, source_end: 16, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true }],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    };
    const result = compileIntentIR(text, vector, { providerModel: "fixture-compiler", attempt: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ir.digest).toBe("fb983e9f19dbb3e20c52dc1a1c95b7768195d00dd272a58df581ee378215423b");
  });

  it("matches the TS-Go digest after compact candidate expansion", () => {
    const text = "Read realm build from the active shard.";
    const expanded = compileIntentCandidate(text, {
      schema_version: "intent-candidate/v1",
      clauses: [{ quote: text, occurrence: 1, role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered server fact" }],
      goals: [{ clause: 0, quote: "realm build", occurrence: 1, domain: "server", entity: "build", capability: "server.version", target: "version", parameters: { command: "version" }, result_kind: "fact", required: true }],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const compiled = compileIntentIR(text, expanded.proposal, { providerModel: "fixture-compiler", attempt: 1 });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.ir.digest).toBe("64a0d4eee018edf5b92ab4c02f5108240b9617a96c8d1c6113fe1f71b35219f2");
  });

  it("compiles clauses, scopes, independent counts and ordered predicates without regex reconstruction", () => {
    const compiled = compileIntentIR(source, proposal(), { providerModel: "fixture-model", attempt: 1 });
    expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.ir.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.ir.goals.map((goal) => goal.result_kind)).toEqual(["fact", "collection", "count", "filtered_count"]);
    expect(compiled.ir.predicates[1]).toMatchObject({ kind: "binary", operator: "gte", left: { goal_id: "i3" }, right: { goal_id: "i4" } });
    const plan = draftPlan("mcs:d:i", "rev-1", source, { intentIR: compiled.ir });
    expect(plan.intent_ir_digest).toBe(compiled.ir.digest);
    expect(plan.steps.map((step) => [step.tool, step.args])).toEqual([
      ["console.command", { command: "version" }],
      ["files.list", { path: "/srv/orchid/artifacts", depth: 1 }],
    ]);
    expect(plan.source_goals.map((goal) => goal.result_kind)).toEqual(["fact", "collection", "count", "filtered_count", "judgement", "judgement"]);
    expect(plan.acceptance).toEqual([]);
    expect(validatePlanCompatibility(plan)).toEqual({ ok: true, version: plan.policy_version });
  });

  it.each([
    ["span drift", (value: IntentIRProposal) => { value.goals[0].source_start += 1; }],
    ["scope expansion", (value: IntentIRProposal) => { value.scopes[0].value = 9; }],
    ["constraint deletion", (value: IntentIRProposal) => { value.constraints = []; }],
    ["operand reversal", (value: IntentIRProposal) => { const predicate = value.predicates[1]; if (predicate.kind === "binary") [predicate.left, predicate.right] = [predicate.right, predicate.left]; }],
    ["cross-domain predicate", (value: IntentIRProposal) => { const predicate = value.predicates[1]; if (predicate.kind === "binary") predicate.right.goal_id = "i1"; }],
    ["duplicate goal", (value: IntentIRProposal) => { value.goals.push({ ...value.goals[0] }); }],
  ])("rejects %s tampering", (_name, mutate) => {
    const value = structuredClone(proposal());
    mutate(value);
    expect(validateIntentIRProposal(source, value).ok).toBe(false);
  });

  it("does not let a model constraint erase the conservative write gate", () => {
    const value = proposal();
    value.constraints = [];
    const result = compileIntentIR(source, value, { providerModel: "fixture-model", attempt: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.code === "MISSING_CONSERVATIVE_CONSTRAINT")).toBe(true);
  });

  it("keeps a typed console mutation behind approval and derives only its matching readback", () => {
    const text = "Set difficulty to hard, verify it, and never restart.";
    const at = (value: string) => {
      const start = [...text.slice(0, text.indexOf(value))].length;
      return { source_text: value, source_start: start, source_end: start + [...value].length };
    };
    const value: IntentIRProposal = {
      schema_version: "intent-ir/v1",
      clauses: [
        { id: "c-set", ...at("Set difficulty to hard"), role: "domain_goal", polarity: "positive", status: "mapped", reason: "registered console mutation" },
        { id: "c-verify", ...at("verify it"), role: "evidence_requirement", polarity: "positive", status: "mapped", reason: "explicit independent verification" },
        { id: "c-link", ...at("and"), role: "discourse", polarity: "neutral", status: "ignored", reason: "coordination" },
        { id: "c-guard", ...at("never restart"), role: "safety_constraint", polarity: "negative", status: "mapped", reason: "explicit forbidden action" },
      ],
      goals: [{ id: "i-set", clause_id: "c-set", ...at("difficulty to hard"), domain: "console", entity: "difficulty", capability: "console.command", target: "difficulty", parameters: { command: "difficulty hard" }, result_kind: "fact", required: true }],
      scopes: [],
      constraints: [{ id: "k-restart", clause_id: "c-guard", ...at("never restart"), action: "restart", effect: "forbid" }],
      evidence_requirements: [{ id: "e-verify", clause_id: "c-verify", ...at("verify it"), kind: "independent_verification", goal_ids: ["i-set"] }],
      response_requirements: [], predicates: [], unknown_goals: [],
    };
    const compiled = compileIntentIR(text, value, { providerModel: "fixture-model", attempt: 1 });
    expect(compiled.ok, compiled.ok ? undefined : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    const plan = draftPlan("mcs:d:i", "rev-2", text, { intentIR: compiled.ir });
    expect(plan.steps).toEqual([
      expect.objectContaining({ tool: "console.command", args: { command: "difficulty hard" }, risk: "medium", requires_confirmation: true }),
      expect.objectContaining({ tool: "console.command", args: { command: "difficulty" }, risk: "read", purpose: "verify" }),
    ]);
    expect(plan.operation).toMatchObject({ action: "write", risk: "medium", requires_confirmation: true });
    expect(plan.acceptance).toEqual([]);
    expect(plan.constraints.map((constraint) => constraint.action)).toContain("restart");
    expect(validatePlanCompatibility(plan)).toEqual({ ok: true, version: plan.policy_version });
  });

  it.each([
    ["<", "lt"], ["<=", "lte"], ["==", "equals"], ["!=", "not_equals"], [">=", "gte"], [">", "gt"],
  ] as const)("preserves the directed %s comparison as %s", (symbol, operator) => {
    const text = `Compare total ${symbol} filtered for '/var/lib/quartz'.`;
    const locate = (value: string, from = 0) => {
      const index = text.indexOf(value, from);
      const start = [...text.slice(0, index)].length;
      return { source_text: value, source_start: start, source_end: start + [...value].length };
    };
    const path = locate("'/var/lib/quartz'");
    const left = locate("total");
    const right = locate("filtered", text.indexOf(symbol));
    const vector: IntentIRProposal = {
      schema_version: "intent-ir/v1",
      clauses: [{ id: "c-compare", source_text: text, source_start: 0, source_end: [...text].length, role: "domain_goal", polarity: "positive", status: "mapped", reason: "typed filesystem comparison" }],
      goals: [
        { id: "set", clause_id: "c-compare", ...path, domain: "filesystem", entity: "/var/lib/quartz", capability: "filesystem.list", target: "/var/lib/quartz", parameters: { path: "/var/lib/quartz" }, result_kind: "collection", item_schema: { name: "string" }, required: true },
        { id: "total", clause_id: "c-compare", ...left, domain: "filesystem", entity: "/var/lib/quartz", capability: "filesystem.count", target: "/var/lib/quartz", parameters: {}, result_kind: "count", depends_on: ["set"], required: true },
        { id: "filtered", clause_id: "c-compare", ...right, domain: "filesystem", entity: "/var/lib/quartz", capability: "filesystem.filtered_count", target: "/var/lib/quartz", parameters: {}, result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".pack" }, depends_on: ["set"], required: true },
      ],
      scopes: [], constraints: [], evidence_requirements: [], response_requirements: [],
      predicates: [{ id: "compare", clause_id: "c-compare", source_text: text.slice(text.indexOf("total"), text.indexOf("filtered") + "filtered".length), source_start: left.source_start, source_end: right.source_end, kind: "binary", operator, left: { ...left, goal_id: "total", selector: "count" }, right: { ...right, goal_id: "filtered", selector: "filtered_count" }, expected: true }],
      unknown_goals: [],
    };
    expect(validateIntentIRProposal(text, vector)).toEqual({ ok: true });
    const tampered = structuredClone(vector);
    const predicate = tampered.predicates[0];
    if (predicate.kind === "binary") predicate.operator = operator === "gte" ? "lte" : "gte";
    expect(validateIntentIRProposal(text, tampered).ok).toBe(false);
  });

  it("bounds repair to one retry at the gateway consumer boundary", async () => {
    const compile = vi.fn()
      .mockResolvedValueOnce({ status: "answered", proposal: { ...proposal(), goals: [] }, requestId: "r1" })
      .mockResolvedValueOnce({ status: "answered", proposal: proposal(), requestId: "r2" });
    const first = await compile({ attempt: 1 });
    const invalid = validateIntentIRProposal(source, first.proposal);
    expect(invalid.ok).toBe(false);
    const second = await compile({ attempt: 2, errors: invalid.ok ? [] : invalid.errors });
    const repaired = validateIntentIRProposal(source, second.proposal);
    expect(repaired.ok, repaired.ok ? undefined : JSON.stringify(repaired.errors)).toBe(true);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("plans one compact frame call for simple catalogs and three contiguous shards for structural complexity", () => {
    const simple = buildIntentSemanticFramePlan(buildIntentSourceCatalog("Inspect helios build."));
    expect(simple.complexity).toBe("simple");
    expect(simple.shards).toHaveLength(1);
    expect(simple.total_deadline_ms).toBe(28_000);
    expect(simple.max_provider_calls).toBe(4);
    const complexCatalog = buildIntentSourceCatalog("Read build; list mods; count players; never write; cite callbacks; synthesize findings.");
    const complex = buildIntentSemanticFramePlan(complexCatalog);
    expect(complex.complexity).toBe("complex");
    expect(complex.shards).toHaveLength(3);
    expect(complex.shards.flatMap((shard) => shard.assigned_source_refs)).toEqual(complexCatalog.refs.map((ref) => ref.id));
    expect(complex.shards.every((shard) => shard.max_output_tokens < 2_048)).toBe(true);
  });

  it("merges ordered frame roles into candidate v2 without losing cross-frame scope and directed predicates", () => {
    const text = "List immediate .cfg files; return total; compare total >= 2; never write; cite callbacks.";
    const catalog = buildIntentSourceCatalog(text);
    const plan = buildIntentSemanticFramePlan(catalog);
    const batches: IntentSemanticFrameBatch[] = plan.shards.map((shard) => ({
      schema_version: "intent-semantic-frame/v1",
      assigned_source_refs: shard.assigned_source_refs,
      frames: shard.assigned_source_refs.map((owner) => ({ owner_source_ref: owner, roles: [{ role: "discourse", polarity: "neutral", status: "mapped", reason: "classified" }] })),
    }));
    const byOwner = new Map(batches.flatMap((batch) => batch.frames.map((frame) => [frame.owner_source_ref, frame])));
    byOwner.get(catalog.refs[0].id)!.roles = [{ role: "domain_goal", polarity: "positive", status: "mapped", reason: "filesystem collection", goals: [{ key: "files", domain: "filesystem", entity: "/config", capability: "filesystem.list", target: "/config", parameters: { path: "/config" }, result_kind: "collection", item_schema: { name: "string" }, required: true }], scopes: [{ goal: "files", kind: "depth", value: 1 }] }];
    byOwner.get(catalog.refs[1].id)!.roles = [{ role: "domain_goal", polarity: "positive", status: "mapped", reason: "count", goals: [{ key: "total", domain: "filesystem", entity: "/config", capability: "filesystem.count", target: "/config", parameters: {}, result_kind: "count", depends_on: ["files"], required: true }] }];
    byOwner.get(catalog.refs[2].id)!.roles = [{ role: "domain_goal", polarity: "positive", status: "mapped", reason: "comparison", predicates: [{ kind: "binary", operator: "gte", expected: true, left: { goal: "total", selector: "count" }, right: { value: 2 } }] }];
    byOwner.get(catalog.refs[3].id)!.roles = [{ role: "safety_constraint", polarity: "negative", status: "mapped", reason: "forbidden mutation", constraints: [{ action: "write", effect: "forbid" }] }];
    byOwner.get(catalog.refs[4].id)!.roles = [{ role: "evidence_requirement", polarity: "neutral", status: "mapped", reason: "callback evidence", evidence_requirements: [{ kind: "real_callback_per_goal", goals: ["files", "total"] }] }];
    const merged = mergeIntentSemanticFrames(catalog, plan, batches);
    expect(merged.ok, merged.ok ? undefined : JSON.stringify(merged.errors)).toBe(true);
    if (!merged.ok) return;
    expect(merged.candidate.schema_version).toBe("intent-candidate/v2");
    expect(merged.candidate.goals).toHaveLength(2);
    expect(merged.candidate.goals[1].depends_on).toEqual([0]);
    expect(merged.candidate.scopes[0].goal).toBe(0);
    expect(merged.candidate.predicates[0]).toMatchObject({ kind: "binary", operator: "gte", left: { goal: 1 }, right: { value: 2 } });
    expect(merged.candidate.constraints[0].action).toBe("write");
  });

  it.each(["omitted", "expanded", "duplicate"])("fails closed when frame ownership is %s", (variant) => {
    const catalog = buildIntentSourceCatalog("Read alpha; read beta; read gamma; read delta.");
    const plan = buildIntentSemanticFramePlan(catalog);
    const batches: IntentSemanticFrameBatch[] = plan.shards.map((shard) => ({ schema_version: "intent-semantic-frame/v1", assigned_source_refs: shard.assigned_source_refs, frames: shard.assigned_source_refs.map((owner) => ({ owner_source_ref: owner, roles: [{ role: "discourse", polarity: "neutral", status: "mapped", reason: "classified" }] })) }));
    if (variant === "omitted") batches[0].frames.shift();
    if (variant === "expanded") batches[0].frames[0].owner_source_ref = catalog.refs.at(-1)!.id;
    if (variant === "duplicate") batches[0].frames.push(structuredClone(batches[0].frames[0]));
    const result = mergeIntentSemanticFrames(catalog, plan, batches);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => /OWNERSHIP|OWNER|UNCLASSIFIED/.test(error.code))).toBe(true);
  });
});
