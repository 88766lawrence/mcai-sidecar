import { createHash, randomUUID } from "node:crypto";
import {
  OPERATION_POLICY_DIGEST, OPERATION_POLICY_VERSION, TASK_PLAN_SCHEMA_VERSION,
  intrinsicToolPolicy, policyTarget,
  type ConfirmedWriteProposal, type TaskPlan, type TaskStep,
} from "@mcai/contracts";
import { classifyOperationalLanguage, extractActionbarConsoleCommand, extractBroadcastConsoleCommand, extractExplicitConsoleCommand, extractTitleConsoleCommand, extractTransientPlayerEffectCommand } from "./operation-intent";
import { computeOperationDigest } from "./plan-compatibility";

export type ConfirmedWriteProposalDecision = Omit<ConfirmedWriteProposal, "target"> & { target?: string } | {
  schema_version: "confirmed-write-proposal/v1";
  decision: "clarify";
  summary: string;
};

export type ConfirmedWriteProposalResult =
  | { ok: true; proposal: ConfirmedWriteProposal; plan: TaskPlan }
  | { ok: false; code: string; message: string };

const proposalKeys = new Set(["schema_version", "decision", "tool", "target", "parameters", "summary"]);
const clarifyKeys = new Set(["schema_version", "decision", "summary"]);

export function isCompactConfirmedWriteCandidate(intent: string) {
  return classifyOperationalLanguage(intent) === "write";
}

export function validateConfirmedWriteProposal(
  raw: unknown,
  input: { intent: string; instanceRef: string; inventoryRevision: string },
): ConfirmedWriteProposalResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("PROPOSAL_INVALID_JSON", "proposal must be one JSON object");
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== "confirmed-write-proposal/v1") return reject("PROPOSAL_VERSION_MISMATCH", "proposal schema version is unsupported");
  if (value.decision === "clarify") return reject("PROPOSAL_CLARIFICATION_REQUIRED", cleanSummary(value.summary) || "the operation needs clarification");
  if (value.decision !== "propose") return reject("PROPOSAL_INVALID_DECISION", "proposal decision must be propose or clarify");
  if (Object.keys(value).some((key) => !proposalKeys.has(key))) return reject("PROPOSAL_FORBIDDEN_FIELD", "provider supplied a Cloud-owned or unknown field");
  if (!singleOperationIntent(input.intent)) return reject("PROPOSAL_NOT_SINGLE_OPERATION", "request contains multiple, mixed, or ambiguous operations");

  const tool = typeof value.tool === "string" ? value.tool.trim() : "";
  const summary = cleanSummary(value.summary);
  const parameters = plainObject(value.parameters);
  if (!tool || !summary || !parameters) return reject("PROPOSAL_INVALID_SHAPE", "tool, parameters, and summary are required");
  const argsError = validateBasicParameters(tool, parameters);
  if (argsError) return reject(argsError.code, argsError.message);
  const explicitCommand = extractExplicitConsoleCommand(input.intent);
  if (explicitCommand && (tool !== "console.command" || parameters.command !== explicitCommand)) return reject("PROPOSAL_EXPLICIT_COMMAND_MISMATCH", "explicit console command body was changed");
  const step: TaskStep = { id: "s1", tool, args: parameters, risk: "forbidden" };
  const policy = intrinsicToolPolicy(tool, parameters);
  if (!policy.mutates || policy.risk === "read" || policy.risk === "forbidden" || !policy.requires_confirmation) {
    return reject("PROPOSAL_UNSUPPORTED_TOOL", "proposal is not a registered confirmable write operation");
  }
  const target = policyTarget(step);
  step.risk = policy.risk;
  step.requires_confirmation = true;
  const proposal: ConfirmedWriteProposal = { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool, target, parameters, summary };
  return { ok: true, proposal, plan: compactPlan(input, proposal, step) };
}

export function buildConfirmedWriteWaitingPlan(input: { intent: string; instanceRef: string; inventoryRevision: string }): TaskPlan {
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION, policy_version: OPERATION_POLICY_VERSION, policy_digest: OPERATION_POLICY_DIGEST,
    task_id: `task_${randomUUID()}`, instance_ref: input.instanceRef, intent: input.intent, inventory_revision: input.inventoryRevision,
    operation: { schema_version: "operation-objective/v1", capability: "unknown", action: "write", target: "unknown", parameters: {}, risk: "medium", requires_confirmation: true, execution_evidence: [], verification_evidence: [], recovery: "diagnose" },
    clause_ledger: [], clause_ledger_digest: emptyDigest(), evidence_policy: { require_real_callback_per_goal: true, require_independent_verification: false, clause_ids: [] },
    response_policy: { cover_all_required_goals: true, require_synthesis: true, clause_ids: [] }, source_atoms: [], source_atom_digest: emptyDigest(), source_goals: [], source_goal_digest: emptyDigest(),
    goal_requirements: [], constraints: [], coverage: "waiting", steps: [], acceptance: [],
  };
}

export function buildDeterministicLifecyclePlan(
  input: { intent: string; instanceRef: string; inventoryRevision: string },
  tool: "instance.start" | "instance.stop" | "instance.restart",
): TaskPlan {
  const parameters = { target: input.instanceRef, timeout_seconds: 120 };
  const policy = intrinsicToolPolicy(tool, parameters);
  const step: TaskStep = {
    id: "s1", tool, args: parameters, risk: policy.risk, requires_confirmation: policy.requires_confirmation,
  };
  const action = tool.split(".")[1];
  const proposal: ConfirmedWriteProposal = {
    schema_version: "confirmed-write-proposal/v1", decision: "propose", tool,
    target: input.instanceRef, parameters,
    summary: `${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}计划已准备，等待确认后执行。`,
  };
  return compactPlan(input, proposal, step);
}

export function validateConfirmedWriteWireShape(raw: unknown): { ok: true; value: ConfirmedWriteProposalDecision } | { ok: false; code: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "PROPOSAL_INVALID_JSON" };
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== "confirmed-write-proposal/v1" || !["propose", "clarify"].includes(String(value.decision))) return { ok: false, code: "PROPOSAL_INVALID_SHAPE" };
  const allowed = value.decision === "clarify" ? clarifyKeys : proposalKeys;
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false, code: "PROPOSAL_FORBIDDEN_FIELD" };
  if (!cleanSummary(value.summary)) return { ok: false, code: "PROPOSAL_INVALID_SUMMARY" };
  if (value.decision === "propose" && (typeof value.tool !== "string" || !plainObject(value.parameters))) return { ok: false, code: "PROPOSAL_INVALID_SHAPE" };
  return { ok: true, value: value as unknown as ConfirmedWriteProposalDecision };
}

function compactPlan(input: { intent: string; instanceRef: string; inventoryRevision: string }, proposal: ConfirmedWriteProposal, step: TaskStep): TaskPlan {
  const policy = intrinsicToolPolicy(step.tool, step.args);
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION, policy_version: OPERATION_POLICY_VERSION, policy_digest: OPERATION_POLICY_DIGEST,
    task_id: `task_${randomUUID()}`, instance_ref: input.instanceRef, intent: input.intent, inventory_revision: input.inventoryRevision,
    operation: {
      schema_version: "operation-objective/v2", digest: computeOperationDigest([step]), capability: step.tool,
      action: policy.action, target: proposal.target, parameters: step.args, risk: step.risk, requires_confirmation: true,
      execution_evidence: [{ kind: policy.evidence_kind, step_id: step.id, tool: step.tool, target: proposal.target, parameters: step.args, order: 0 }],
      verification_evidence: [], recovery: "diagnose",
    },
    clause_ledger: [], clause_ledger_digest: emptyDigest(),
    evidence_policy: { require_real_callback_per_goal: true, require_independent_verification: false, clause_ids: [] },
    response_policy: { cover_all_required_goals: true, require_synthesis: true, clause_ids: [] },
    source_atoms: [], source_atom_digest: emptyDigest(), source_goals: [], source_goal_digest: emptyDigest(),
    goal_requirements: [], constraints: [], coverage: "full", steps: [step], acceptance: [], confirmed_write_proposal: proposal,
  };
}

function validateBasicParameters(tool: string, parameters: Record<string, unknown>) {
  if (tool !== "console.command") return { code: "PROPOSAL_UNSUPPORTED_TOOL", message: "compact proposals currently accept registered console writes only" };
  if (Object.keys(parameters).length !== 1 || typeof parameters.command !== "string") return { code: "PROPOSAL_INVALID_PARAMETERS", message: "console.command requires only a command string" };
  const command = parameters.command.trim().replace(/^\//, "");
  if (!command || command.length > 256 || /[\r\n\0]/.test(command)) return { code: "PROPOSAL_INVALID_PARAMETERS", message: "console command is empty or unsafe" };
  parameters.command = command;
  return undefined;
}

function singleOperationIntent(intent: string) {
  if (extractTitleConsoleCommand(intent)) return true;
  if (extractActionbarConsoleCommand(intent)) return true;
  if (extractBroadcastConsoleCommand(intent)) return true;
  if (extractTransientPlayerEffectCommand(intent)) return true;
  const clauses = intent.split(/(?:[。；;！？!?\r\n]+|\b(?:and\s+then|then|and)\b|(?:然后|随后|并且|同时|再)|并(?=(?:把|将|读取|查看|检查|设置|修改)))/i).map((item) => item.trim()).filter(Boolean);
  const positive = clauses.map((item) => classifyOperationalLanguage(item)).filter((item) => item !== "none");
  return positive.length === 1 && positive[0] === "write";
}
function plainObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : undefined; }
function cleanSummary(value: unknown) { return typeof value === "string" ? value.trim().slice(0, 240) : ""; }
function emptyDigest() { return createHash("sha256").update("[]").digest("hex"); }
function reject(code: string, message: string): ConfirmedWriteProposalResult { return { ok: false, code, message }; }
