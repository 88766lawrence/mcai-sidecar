import { createHash } from "node:crypto";
import {
  aggregateOperationAction,
  intrinsicToolPolicy,
  OPERATION_POLICY_DIGEST,
  OPERATION_POLICY_VERSION,
  RESOURCE_PRESSURE_POLICY,
  policyTarget,
  type GoalPredicate,
  type SourceGoal,
  type TaskPlan,
  type TaskStep,
} from "@mcai/contracts";
import { buildClauseRoleLedger, buildSourceAtomLedger, deriveMetaPolicies, extractPlanConstraints } from "./goal-requirements";
import { compileIntentIR, toolForIntentCapability } from "./intent-ir";
import { canonicalizeLogFilterGroups, logEventFilters, validateLogFilterQuery, type LogFilterQueryV1 } from "./log-filter-query";
import { matchRegisteredCapability, projectRegisteredCapabilityClauses } from "./capability-registry";

export const PLAN_COMPATIBILITY_VERSION = OPERATION_POLICY_VERSION;
export type PlanCompatibilityResult = { ok: true; version: string }
  | { ok: false; version: string; code: string; reason: string };

export function validatePlanCompatibility(plan: TaskPlan): PlanCompatibilityResult {
  const reject = (code: string, reason: string): PlanCompatibilityResult => ({ ok: false, version: PLAN_COMPATIBILITY_VERSION, code, reason });
  if (plan.schema_version !== "task-plan/v1" || !plan.task_id || !plan.instance_ref) return reject("INVALID_PLAN", "task envelope is incomplete");
  if (plan.policy_version !== PLAN_COMPATIBILITY_VERSION || plan.policy_digest !== OPERATION_POLICY_DIGEST) return reject("POLICY_VERSION_MISMATCH", "plan policy version or digest is not supported by this runtime");
  if (plan.execution_mode && plan.execution_mode !== "agent_direct") return reject("INVALID_EXECUTION_MODE", "task plan contains an unsupported execution mode");
  if (!plan.execution_mode && plan.agent_execution) return reject("UNBOUND_AGENT_EXECUTION", "agent execution envelope is not bound to direct execution mode");
  const direct = plan.execution_mode === "agent_direct";
  if (direct) {
    const error = validateAgentDirectExecution(plan);
    if (error) return reject("INVALID_AGENT_EXECUTION", error);
  } else if (plan.operation.schema_version === "operation-objective/v2" && plan.confirmed_write_proposal) {
    const proposal = plan.confirmed_write_proposal;
    if (plan.operation.digest !== computeOperationDigest(plan.steps)) return reject("OPERATION_DIGEST_MISMATCH", "normalized steps do not match the operation digest");
    if (proposal.schema_version !== "confirmed-write-proposal/v1" || proposal.decision !== "propose" || plan.steps.length !== 1) return reject("INVALID_WRITE_PROPOSAL", "compact write proposal must bind exactly one step");
    const step = plan.steps[0];
    if (step.purpose === "verify" || step.tool !== proposal.tool || policyTarget(step) !== proposal.target || JSON.stringify(canonicalize(step.args)) !== JSON.stringify(canonicalize(proposal.parameters))) return reject("WRITE_PROPOSAL_BINDING_MISMATCH", "proposal tool, target, or parameters changed while creating the confirmation preview");
    if (plan.clause_ledger.length || plan.source_atoms.length || plan.source_goals.length || plan.goal_requirements.length || plan.constraints.length || plan.acceptance.length || plan.intent_ir) return reject("WRITE_PROPOSAL_SEMANTIC_GATE_PRESENT", "compact write proposal must not carry a second semantic execution gate");
    if (plan.coverage !== "full") return reject("INCOMPLETE_COVERAGE", "compact write proposal is not ready for confirmation");
  } else if (plan.operation.schema_version === "operation-objective/v2") {
    if (plan.operation.digest !== computeOperationDigest(plan.steps)) return reject("OPERATION_DIGEST_MISMATCH", "normalized steps do not match the operation digest");
    if (plan.clause_ledger_digest !== computeClauseLedgerDigest(plan)) return reject("CLAUSE_LEDGER_MISMATCH", "clause role ledger digest does not match the original source");
    const extractedClauses = plan.intent_ir ? plan.clause_ledger : buildClauseRoleLedger(plan.intent);
    const registeredCapabilityProjection = !plan.intent_ir
      && plan.clause_ledger.some((clause) => clause.reason === "registered_capability_projection");
    const expectedClauses = registeredCapabilityProjection
      ? projectRegisteredCapabilityClauses(plan.intent, extractedClauses, plan.source_goals)
      : extractedClauses;
    const expectedConstraints = plan.intent_ir ? plan.constraints : extractPlanConstraints(plan.intent, expectedClauses);
    const expectedMeta = plan.intent_ir ? { evidence: plan.evidence_policy, response: plan.response_policy } : deriveMetaPolicies(expectedClauses);
    if (plan.intent_ir) {
      if (plan.intent_ir.source !== plan.intent || plan.intent_ir_digest !== plan.intent_ir.digest) return reject("INTENT_IR_SOURCE_MISMATCH", "typed intent IR is not bound to the plan source");
      const rebuilt = compileIntentIR(plan.intent, stripCompiledIntentIR(plan.intent_ir), { providerModel: plan.intent_ir.compiler.provider_model, attempt: plan.intent_ir.compiler.attempt });
      if (!rebuilt.ok || rebuilt.ir.digest !== plan.intent_ir.digest) return reject("INTENT_IR_DIGEST_MISMATCH", "typed intent IR failed deterministic revalidation");
      const projectionError = validateIntentIRProjection(plan);
      if (projectionError) return reject("INTENT_IR_PROJECTION_MISMATCH", projectionError);
    }
    if (plan.source_atom_digest !== computeSourceAtomDigest(plan)) return reject("SOURCE_ATOM_LEDGER_MISMATCH", "source atom ledger digest does not match the original source");
    if (plan.source_goal_digest !== computeSourceGoalDigest(plan)) return reject("SOURCE_GOAL_DIGEST_MISMATCH", "source goals or predicates do not match the original intent digest");
    const runes = [...plan.intent];
    const sourceIds = new Set(plan.source_goals.map((goal) => goal.id));
    const sources = new Map(plan.source_goals.map((goal) => [goal.id, goal]));
    const collectionIdentities = new Set<string>();
    const judgementSpans = new Set<string>();
    const mappedByAtom = new Map<string, number>();
    for (const atom of plan.source_atoms) {
      if (atom.source_start < 0 || atom.source_end <= atom.source_start || runes.slice(atom.source_start, atom.source_end).join("") !== atom.source_text) return reject("SOURCE_ATOM_SPAN_MISMATCH", "a source atom span no longer binds the original intent");
      for (const sourceId of atom.source_goal_ids) mappedByAtom.set(sourceId, (mappedByAtom.get(sourceId) ?? 0) + 1);
      if (atom.required && atom.polarity === "positive" && (atom.status !== "mapped" || atom.source_goal_ids.length !== 1)) return reject("INCOMPLETE_COVERAGE", "a required positive source atom is not mapped exactly once");
    }
    for (const source of plan.source_goals) {
      if (source.source_start < 0 || source.source_end <= source.source_start || runes.slice(source.source_start, source.source_end).join("") !== source.source_text) return reject("SOURCE_GOAL_SPAN_MISMATCH", "a source goal span no longer binds the original intent");
      if (source.result_kind === "filtered_count" && (!source.filter || !source.depends_on.some((id) => sources.get(id)?.result_kind === "collection"))) return reject("INVALID_FILTERED_COUNT", "filtered count lacks a compatible collection dependency");
      if (source.result_kind === "collection") {
        const identity = canonicalCollectionIdentity(source);
        if (collectionIdentities.has(identity)) return reject("DUPLICATE_COLLECTION", "the same canonical collection appears more than once");
        collectionIdentities.add(identity);
      }
      if (source.result_kind === "judgement") {
        const span = `${source.source_start}:${source.source_end}`;
        if (judgementSpans.has(span)) return reject("MERGED_JUDGEMENT", "two judgements reuse the same source span");
        judgementSpans.add(span);
        const error = source.normalized === "performance.pressure"
          ? validateResourcePressureJudgement(source, sources)
          : validatePredicate(source.predicate, source, sources);
        if (error) return reject("INVALID_PREDICATE", error);
      }
      if (source.depends_on.some((id) => !sourceIds.has(id) || id === source.id)) return reject("INVALID_GOAL_DEPENDENCY", "a source goal dependency is absent or self-referential");
    }
    const expectedAtoms = plan.intent_ir ? plan.source_atoms : buildSourceAtomLedger(plan.intent, expectedClauses, plan.source_goals, expectedConstraints);
    if (JSON.stringify(plan.clause_ledger) !== JSON.stringify(expectedClauses)
      || JSON.stringify(plan.constraints) !== JSON.stringify(expectedConstraints)
      || JSON.stringify(plan.evidence_policy) !== JSON.stringify(expectedMeta.evidence)
      || JSON.stringify(plan.response_policy) !== JSON.stringify(expectedMeta.response)) return reject("CLAUSE_LEDGER_MISMATCH", "clause roles, reverse mappings, or meta policies are not derivable from the original source");
    if (plan.coverage !== "full") return reject("INCOMPLETE_COVERAGE", "required goals are not fully covered");
    if (JSON.stringify(plan.source_atoms) !== JSON.stringify(expectedAtoms)) return reject("SOURCE_ATOM_LEDGER_MISMATCH", "source atom ledger is not derivable from the original source goals and constraints");
    const goalBySource = new Map(plan.goal_requirements.flatMap((goal) => goal.source_goal_ids.map((id) => [id, goal] as const)));
    for (const source of plan.source_goals.filter((goal) => goal.required)) {
      if (mappedByAtom.get(source.id) !== 1) return reject("INCOMPLETE_COVERAGE", "a required source goal lacks an exact reverse atom mapping");
      const goal = goalBySource.get(source.id);
      if (!goal || source.status !== "mapped" || goal.result_kind !== source.result_kind || goal.domain !== source.domain || goal.target !== source.entity) return reject("INCOMPLETE_COVERAGE", "a required source goal is absent or bound to a different domain/result");
      if (!goal.execute_step_ids.length && !goal.depends_on_goal_ids?.length) return reject("INCOMPLETE_COVERAGE", "a required goal has neither execution nor deterministic dependencies");
    }
    const sourceIdSet = new Set(plan.source_goals.map((goal) => goal.id));
    for (const goal of plan.goal_requirements) {
      if (goal.supporting) {
        if (goal.required || !goal.support_reason || !goal.supports_source_goal_ids?.length || goal.supports_source_goal_ids.some((id) => !sourceIdSet.has(id))) return reject("INVALID_SUPPORTING_GOAL", "a supporting goal does not trace to a source goal");
        const ownSource = goal.source_goal_ids.length === 1 ? sources.get(goal.source_goal_ids[0]) : undefined;
        const supportedSources = goal.supports_source_goal_ids.map((id) => sources.get(id));
        if (!ownSource || ownSource.required || supportedSources.some((source) => !source || !source.required || source.domain !== ownSource.domain || source.entity !== ownSource.entity || !source.depends_on.includes(ownSource.id))) return reject("INVALID_SUPPORTING_GOAL", "a supporting goal expands scope or is not a required dependency");
        if (goal.target !== ownSource.entity || goal.domain !== ownSource.domain) return reject("INVALID_SUPPORTING_GOAL", "a supporting goal target does not match its exact dependency target");
      }
      if (!goal.supporting && goal.source_goal_ids.length === 0) return reject("UNBOUND_GOAL", "a non-supporting goal does not bind an original source goal");
    }
    const boundSteps = new Set(plan.goal_requirements.flatMap((goal) => [...goal.execute_step_ids, ...goal.verify_step_ids]));
    if (plan.steps.some((step) => !boundSteps.has(step.id))) return reject("UNBOUND_STEP", "a step is not traceable to a user or supporting goal");
    for (const constraint of plan.constraints) {
      const clause = plan.clause_ledger.find((item) => item.id === constraint.clause_id);
      if (!clause || clause.role !== "safety_constraint" || clause.source_start !== constraint.source_start || clause.source_end !== constraint.source_end
        || runes.slice(constraint.source_start, constraint.source_end).join("") !== constraint.source) return reject("CONSTRAINT_SPAN_MISMATCH", "constraint source span or scope is not bound to its safety clause");
      if (plan.clause_ledger.some((item) => item.role === "domain_goal" && item.source_start < constraint.source_end && item.source_end > constraint.source_start)) return reject("CONSTRAINT_SCOPE_OVERLAP", "constraint scope overlaps a positive domain goal");
    }
  }
  const pending: TaskStep[] = [];
  let primary: TaskStep | undefined;
  for (const [index, step] of plan.steps.entries()) {
    if (step.tool === "logs.query") {
      const query = step.args.filter_query as LogFilterQueryV1 | undefined;
      if (!query) return reject("INVALID_LOG_FILTER_QUERY", `step ${index} omitted the structured log filter query`);
      const validation = validateLogFilterQuery(query);
      if (!validation.ok) return reject("INVALID_LOG_FILTER_QUERY", validation.reason);
      if (JSON.stringify(step.args.filters ?? []) !== JSON.stringify(logEventFilters(query))) return reject("LOG_FILTER_BINDING_MISMATCH", `step ${index} legacy filter projection differs from the structured query`);
    }
    const policy = intrinsicToolPolicy(step.tool, step.args);
    if (riskRank(step.risk) < riskRank(policy.risk)) return reject("RISK_UNDERSTATED", `step ${index} understates intrinsic risk`);
    if (step.purpose === "verify") {
      if (policy.mutates || step.risk !== "read" || step.requires_confirmation) return reject("WRITABLE_VERIFICATION", `step ${index} is not read-only`);
      const match = [...pending].reverse().findIndex((execute) => verificationMatches(execute, step));
      if (match < 0) return reject("INCOMPATIBLE_VERIFICATION", `step ${index} has no preceding compatible execute step`);
      pending.splice(pending.length - 1 - match, 1);
    } else {
      primary ??= step;
      if (policy.requires_confirmation && !step.requires_confirmation) return reject("CONFIRMATION_REQUIRED", `step ${index} omitted intrinsic confirmation`);
      pending.push(step);
    }
  }
  if (!primary || plan.operation.capability !== primary.tool) return reject("CAPABILITY_MISMATCH", "operation capability does not match the primary step");
  if (plan.operation.action !== aggregateOperationAction(plan.steps)) return reject("ACTION_MISMATCH", "operation action does not match canonical step aggregation");
  // A supported write may be execution-only when the platform has no reliable,
  // target-specific readback. The confirmed-operation projection still binds
  // the exact mutation; completion must say that it was not independently verified.
  for (const constraint of plan.constraints) {
    if (plan.steps.some((step) => intrinsicToolPolicy(step.tool, step.args).forbidden_actions.includes(constraint.action))) return reject("CONSTRAINT_VIOLATION", `plan violates forbidden ${constraint.action}`);
  }
  return { ok: true, version: PLAN_COMPATIBILITY_VERSION };
}

function validateAgentDirectExecution(plan: TaskPlan): string | undefined {
  const envelope = plan.agent_execution;
  if (!envelope || envelope.schema_version !== "agent-tool-execution/v1") return "direct execution lacks its versioned agent envelope";
  if (!envelope.tool_call_id || plan.steps.length !== 1) return "direct execution must bind exactly one named tool call";
  const step = plan.steps[0];
  if (step.purpose !== "execute" || envelope.tool !== step.tool
    || JSON.stringify(canonicalize(envelope.arguments)) !== JSON.stringify(canonicalize(step.args))) return "agent tool or canonical arguments changed after model selection";
  if (envelope.instance_ref !== plan.instance_ref || envelope.inventory_revision !== plan.inventory_revision) return "agent instance or inventory revision changed after model selection";
  if (envelope.policy_version !== plan.policy_version || envelope.policy_digest !== plan.policy_digest) return "agent policy binding differs from the task plan";
  const digest = computeOperationDigest(plan.steps);
  if (envelope.operation_digest !== digest || plan.operation.digest !== digest) return "agent operation digest does not match the selected tool call";
  if (plan.operation.schema_version !== "operation-objective/v2" || plan.operation.capability !== step.tool
    || plan.operation.target !== policyTarget(step)
    || JSON.stringify(canonicalize(plan.operation.parameters)) !== JSON.stringify(canonicalize(step.args))) return "operation objective is not bound to the selected tool call";
  if (plan.clause_ledger.length || plan.source_atoms.length || plan.source_goals.length || plan.goal_requirements.length
    || plan.constraints.length || plan.acceptance.length || plan.intent_ir || plan.confirmed_write_proposal) return "direct execution must not carry a legacy semantic gate";
  if (plan.coverage !== "full") return "direct execution is not ready for policy validation";
  return undefined;
}

function validateIntentIRProjection(plan: TaskPlan): string | undefined {
  const ir = plan.intent_ir;
  if (!ir) return undefined;
  const sources = new Map(plan.source_goals.map((source) => [source.id, source]));
  const atoms = new Map(plan.source_atoms.map((atom) => [atom.id, atom]));
  const requirements = new Map(plan.goal_requirements.flatMap((goal) => goal.source_goal_ids.map((id) => [id, goal] as const)));
  const steps = new Map(plan.steps.map((step) => [step.id, step]));
  if (plan.source_atoms.length !== ir.goals.length + ir.predicates.length || plan.source_goals.length !== ir.goals.length + ir.predicates.length) return "typed goals or predicates were added or removed during projection";
  for (const goal of ir.goals) {
    const source = sources.get(`sg-${goal.id}`);
    const atom = atoms.get(`atom-${goal.id}`);
    if (!source || !atom || source.source_text !== goal.source_text || source.source_start !== goal.source_start || source.source_end !== goal.source_end || source.normalized !== goal.capability || source.domain !== goal.domain || source.entity !== goal.entity || source.result_kind !== goal.result_kind || atom.source_goal_ids.length !== 1 || atom.source_goal_ids[0] !== source.id) return "typed goal changed while compiling SourceAtom/SourceGoal";
    const capability = toolForIntentCapability(goal.capability);
    if (capability) {
      const requirement = requirements.get(source.id);
      const execute = requirement?.execute_step_ids.map((id) => steps.get(id)).find((step) => step?.tool === capability);
      const expectedArgs: Record<string, unknown> = { ...goal.parameters };
      if (goal.capability === "logs.query" && "filter_groups" in expectedArgs) {
        const canonical = canonicalizeLogFilterGroups(expectedArgs.filter_groups);
        if (!canonical.ok) return "typed log filter groups are invalid";
        expectedArgs.filter_query = canonical.query;
        expectedArgs.filters = logEventFilters(canonical.query);
      }
      if (!execute || Object.entries(expectedArgs).some(([key, value]) => JSON.stringify(execute.args[key]) !== JSON.stringify(value))) return "typed capability or parameters changed while compiling steps";
    }
  }
  for (const predicate of ir.predicates) {
    if (!sources.has(`sg-${predicate.id}`) || !atoms.has(`atom-${predicate.id}`)) return "typed predicate was not projected exactly once";
  }
  return undefined;
}


function stripCompiledIntentIR(ir: NonNullable<TaskPlan["intent_ir"]>) {
  const { source: _source, digest: _digest, compiler: _compiler, ...proposal } = ir;
  return proposal;
}

function verificationMatches(execute: TaskStep, verify: TaskStep) {
  const executePolicy = intrinsicToolPolicy(execute.tool, execute.args);
  const verifyPolicy = intrinsicToolPolicy(verify.tool, verify.args);
  if (!executePolicy.mutates && !verifyPolicy.mutates && execute.tool === verify.tool) {
    return policyTarget(execute) === policyTarget(verify) && sameObservationArgs(execute.args, verify.args);
  }
  const mode = executePolicy.verification[verify.tool];
  if (mode === "same_path") return stringArg(execute, "path") !== "" && stringArg(execute, "path") === stringArg(verify, "path");
  if (mode === "plugins_directory") return stringArg(verify, "path").replace(/^\//, "") === "plugins";
  if (mode === "any") return true;
  if (mode === "whitelist_config") return /^whitelist\s+(?:on|off)$/i.test(stringArg(execute, "command")) && stringArg(verify, "path") === "server.properties";
  if (mode === "console_readback") {
    const command = stringArg(execute, "command").toLowerCase().split(/\s+/);
    const readback = stringArg(verify, "command").toLowerCase();
    if (command[0] === "difficulty") return readback === "difficulty";
    if (command[0] === "time") return /^time query /.test(readback);
    if (command[0] === "gamerule") return readback === `gamerule ${command[1]}`;
    if (command[0] === "whitelist") return readback === "whitelist list";
    if (command[0] === "gamemode" && command[2]) return readback === `data get entity ${command[2]} playergametype`;
  }
  return false;
}
function sameObservationArgs(left: Record<string, unknown>, right: Record<string, unknown>) {
  const clean = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "expect"));
  return JSON.stringify(canonicalize(clean(left))) === JSON.stringify(canonicalize(clean(right)));
}
function canonicalCollectionIdentity(source: SourceGoal) {
  const schema = Object.entries(source.item_schema ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([source.domain, source.entity.replace(/\/$/, "") || "/", schema]);
}
function stringArg(step: TaskStep, key: string) { return String(step.args[key] ?? "").trim(); }
function riskRank(risk: string) { return ({ read: 0, low: 1, medium: 2, high: 3, forbidden: 4 } as Record<string, number>)[risk] ?? 99; }
export function computeOperationDigest(steps: TaskStep[]) {
  const normalized = steps.map((step, order) => ({ id: step.id, tool: step.tool, target: stepTarget(step), parameters: step.args, order, purpose: step.purpose ?? "execute" }));
  return createHash("sha256").update(JSON.stringify(canonicalize(normalized))).digest("hex");
}
export function computeSourceGoalDigest(plan: TaskPlan) {
  const source_goals = plan.source_goals.map((goal) => ({
    id: goal.id, source_text: goal.source_text, source_start: goal.source_start, source_end: goal.source_end,
    normalized: goal.normalized, domain: goal.domain, entity: goal.entity, result_kind: goal.result_kind,
    filter: goal.filter ?? null, item_schema: goal.item_schema ?? null, predicate: goal.predicate ?? null, depends_on: goal.depends_on, required: goal.required, status: goal.status,
  }));
  return createHash("sha256").update(JSON.stringify(canonicalize({ intent: plan.intent, source_atoms: plan.source_atoms, source_goals }))).digest("hex");
}
export function computeSourceAtomDigest(plan: TaskPlan) {
  return createHash("sha256").update(JSON.stringify(canonicalize({ intent: plan.intent, source_atoms: plan.source_atoms }))).digest("hex");
}
export function computeClauseLedgerDigest(plan: TaskPlan) {
  return createHash("sha256").update(JSON.stringify(canonicalize({ intent: plan.intent, clause_ledger: plan.clause_ledger }))).digest("hex");
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}
const stepTarget = policyTarget;

function validatePredicate(predicate: GoalPredicate | undefined, owner: SourceGoal, sources: Map<string, SourceGoal>): string | undefined {
  if (!predicate || !["goal-predicate/v1", "goal-predicate/v2"].includes(predicate.schema_version)) return "judgement lacks a versioned auditable predicate";
  if (predicate.schema_version === "goal-predicate/v2") {
    if (!predicate.left || !predicate.right || predicate.operands.length !== 2 || JSON.stringify(predicate.operands[0]) !== JSON.stringify(predicate.left) || JSON.stringify(predicate.operands[1]) !== JSON.stringify(predicate.right)) return "directed predicate operands are missing or reordered";
    if (predicate.quantifier === "any" && (predicate.operator !== "gt" || predicate.right.value !== 0 || predicate.left.selector !== "filtered_count")) return "any quantifier must mean filtered_count > 0";
    if (predicate.quantifier === "all" && (predicate.operator !== "equals" || predicate.left.selector !== "filtered_count" || predicate.right.selector !== "count")) return "all quantifier must mean filtered_count == total_count";
    if (predicate.quantifier) {
      const collection = predicate.left.goal_id ? sources.get(predicate.left.goal_id) : undefined;
      if (!collection || collection.result_kind !== "collection" || !predicate.left.filter || !predicate.filter || JSON.stringify(predicate.left.filter) !== JSON.stringify(predicate.filter) || collection.item_schema?.[predicate.left.filter.field] !== "string") return "quantified predicate filter is not bound to a compatible collection field";
    }
    for (const operand of [predicate.left, predicate.right]) {
      if (!operand.source_text || operand.source_start === undefined || operand.source_end === undefined
        || operand.source_start < owner.source_start || operand.source_end > owner.source_end || operand.source_end <= operand.source_start
        || [...owner.source_text].slice(operand.source_start - owner.source_start, operand.source_end - owner.source_start).join("") !== operand.source_text) return "directed predicate operand span does not bind its source judgement";
    }
    if (!predicate.quantifier && predicate.left.source_start! > predicate.right.source_start!) return "directed predicate operands were reordered from the original source";
  }
  const booleanOperators = new Set(["and", "or", "not"]);
  if (booleanOperators.has(predicate.operator)) {
    if (predicate.operator === "not" && predicate.operands.length !== 1 || predicate.operator !== "not" && predicate.operands.length < 2) return "boolean predicate has an invalid arity";
    for (const operand of predicate.operands) {
      if (!operand.predicate || operand.goal_id) return "boolean predicate operands must be nested judgements";
      const nestedError = validatePredicate(operand.predicate, owner, sources);
      if (nestedError) return nestedError;
    }
    return undefined;
  }
  if (predicate.operands.length < 1) return "predicate has no operands";
  for (const operand of predicate.operands.filter((item) => item.goal_id)) {
    const referenced = sources.get(operand.goal_id!);
    if (!referenced) return "predicate references an unknown source goal";
    if (operand.domain !== referenced.domain || operand.entity !== referenced.entity || operand.result_kind !== referenced.result_kind) return "predicate operand type/domain binding drifted";
    if (owner.domain !== referenced.domain || owner.entity !== referenced.entity) return "predicate crosses an unrelated goal domain or entity";
  }
  if (predicate.operator === "all_match" || predicate.operator === "any_match") {
    if (predicate.operands.length !== 1) return "collection predicate has an invalid arity";
    const operand = predicate.operands[0];
    const collection = operand.goal_id ? sources.get(operand.goal_id) : undefined;
    if (!collection || collection.result_kind !== "collection" || !operand.filter) return "collection predicate lacks a collection and filter";
    if (collection.item_schema?.[operand.filter.field] !== "string") return "predicate filter field is absent or not a string";
  }
  if (["lt", "lte", "gt", "gte", "equals", "not_equals"].includes(predicate.operator)) {
    if (predicate.operands.length !== 2) return "comparison predicate has an invalid arity";
    for (const operand of predicate.operands.filter((item) => item.goal_id)) {
      const kind = sources.get(operand.goal_id!)?.result_kind;
      if (kind !== "fact" && kind !== "count" && kind !== "filtered_count" && !(kind === "collection" && (operand.selector === "count" || operand.selector === "filtered_count"))) return "comparison references an incompatible result";
    }
  }
  return undefined;
}

function validateResourcePressureJudgement(owner: SourceGoal, sources: Map<string, SourceGoal>): string | undefined {
  if (RESOURCE_PRESSURE_POLICY.schema_version !== "resource-pressure/v1") return "resource pressure policy version is unavailable";
  if (owner.domain !== "performance" || owner.entity !== "resource-pressure" || owner.result_kind !== "judgement" || owner.predicate) return "resource pressure judgement shape is invalid";
  if (owner.depends_on.length !== 2 || new Set(owner.depends_on).size !== 2) return "resource pressure judgement must bind exactly CPU and memory facts";
  const dependencies = owner.depends_on.map((id) => sources.get(id));
  if (dependencies.some((source) => !source || !source.required || source.status !== "mapped" || source.domain !== "performance" || source.result_kind !== "fact")) return "resource pressure dependencies are absent or incompatible";
  const normalized = dependencies.map((source) => source!.normalized).sort();
  if (JSON.stringify(normalized) !== JSON.stringify(["performance.cpu", "performance.memory"])) return "resource pressure judgement dependencies drifted";
}
