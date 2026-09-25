import operationPolicySource from "./operation-policy.v2.json";
import resourcePressurePolicySource from "./resource-pressure-policy.v1.json";

export const TASK_PLAN_SCHEMA_VERSION = "task-plan/v1" as const;
export const AGENT_MESSAGE_SCHEMA_VERSION = "agent-message/v1" as const;
export const RESOURCE_PRESSURE_POLICY = Object.freeze(resourcePressurePolicySource);

export type RiskLevel = "read" | "low" | "medium" | "high" | "forbidden";

export type TaskState =
  | "DRAFTED"
  | "POLICY_CHECKED"
  | "WAITING_CONFIRMATION"
  | "SNAPSHOTTING"
  | "EXECUTING"
  | "VERIFYING"
  | "ROLLING_BACK"
  | "SUCCEEDED"
  | "PARTIAL"
  | "WAITING"
  | "FAILED"
  | "ROLLED_BACK"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "MANUAL_INTERVENTION";

export interface TaskStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  purpose?: "execute" | "verify";
  requires_confirmation?: boolean;
  rollback?: { tool: string; snapshot: string };
}

export type GoalStatus = "pending" | "satisfied" | "failed" | "unsupported";
export type ResultKind = "fact" | "collection" | "count" | "filtered_count" | "judgement";

export interface GoalPredicateOperand {
  goal_id?: string;
  selector?: "observed" | "count" | "filtered_count";
  filter?: SourceGoal["filter"];
  value?: unknown;
  predicate?: GoalPredicate;
  domain?: string;
  entity?: string;
  result_kind?: ResultKind;
  source_text?: string;
  source_start?: number;
  source_end?: number;
  source_role?: "left" | "right" | "implicit";
}

export interface GoalPredicate {
  schema_version: "goal-predicate/v1" | "goal-predicate/v2";
  operator: "all_match" | "any_match" | "equals" | "not_equals" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "not";
  operands: GoalPredicateOperand[];
  left?: GoalPredicateOperand;
  right?: GoalPredicateOperand;
  quantifier?: "all" | "any";
  filter?: SourceGoal["filter"];
  expected: boolean;
}

export interface SourceAtom {
  id: string;
  source_text: string;
  source_start: number;
  source_end: number;
  polarity: "positive" | "negative";
  role: "fact" | "collection" | "count" | "filtered_count" | "judgement" | "constraint" | "unknown";
  normalized: string;
  required: boolean;
  status: "mapped" | "unmapped" | "clarify";
  source_goal_ids: string[];
  reason: string;
  clause_id: string;
}

export type ClauseRole = "domain_goal" | "safety_constraint" | "evidence_requirement" | "response_requirement" | "discourse" | "unknown_business_goal";

export interface ClauseRoleEntry {
  id: string;
  source_text: string;
  source_start: number;
  source_end: number;
  role: ClauseRole;
  polarity: "positive" | "negative" | "neutral";
  status: "mapped" | "unmapped" | "clarify";
  reason: string;
  source_atom_ids: string[];
  source_goal_ids: string[];
  constraint_actions: PlanConstraint["action"][];
}

export interface EvidencePolicy {
  require_real_callback_per_goal: boolean;
  require_independent_verification: boolean;
  clause_ids: string[];
}

export interface ResponsePolicy {
  cover_all_required_goals: boolean;
  require_synthesis: boolean;
  clause_ids: string[];
}

export const INTENT_IR_SCHEMA_VERSION = "intent-ir/v1" as const;
export const INTENT_CANDIDATE_SCHEMA_VERSION = "intent-candidate/v1" as const;
export const INTENT_CANDIDATE_V2_SCHEMA_VERSION = "intent-candidate/v2" as const;
export const INTENT_SOURCE_CATALOG_SCHEMA_VERSION = "intent-source-catalog/v1" as const;
export const INTENT_SEMANTIC_FRAME_SCHEMA_VERSION = "intent-semantic-frame/v1" as const;
export const INTENT_SEMANTIC_FRAME_PLAN_VERSION = "intent-semantic-frame-plan/v1" as const;

export type IntentIRRole = ClauseRole | "scope_modifier";

export interface IntentIRSpan {
  source_text: string;
  source_start: number;
  source_end: number;
  source_ref_ids?: string[];
}

export interface IntentSourceRef {
  id: string;
  source_start: number;
  source_end: number;
  text: string;
  order: number;
}

export interface IntentSourceCatalog {
  schema_version: typeof INTENT_SOURCE_CATALOG_SCHEMA_VERSION;
  source_digest: string;
  refs: IntentSourceRef[];
  digest: string;
}

export interface IntentSemanticFrameGoal {
  key: string;
  domain: string;
  entity: string;
  capability: string;
  target: string;
  parameters: Record<string, unknown>;
  result_kind: ResultKind;
  filter?: SourceGoal["filter"];
  item_schema?: Record<string, "string" | "number" | "boolean">;
  depends_on?: string[];
  required: boolean;
}

export interface IntentSemanticFrameRole {
  role: ClauseRole;
  polarity: "positive" | "negative" | "neutral";
  status: "mapped" | "unmapped" | "clarify";
  reason: string;
  goals?: IntentSemanticFrameGoal[];
  scopes?: Array<{ source_refs?: string[]; goal: string; kind: "depth" | "window" | "filter"; value: string | number | boolean }>;
  constraints?: Array<{ action: PlanConstraint["action"]; effect: "forbid" }>;
  evidence_requirements?: Array<{ kind: IntentIREvidenceRequirement["kind"]; goals: string[] }>;
  response_requirements?: Array<{ kind: IntentIRResponseRequirement["kind"]; goals: string[] }>;
  predicates?: Array<({ source_refs?: string[]; expected: boolean } & ({
    kind: "quantifier"; quantifier: "all" | "any"; collection_goal: string; filter: NonNullable<SourceGoal["filter"]>;
  } | {
    kind: "binary"; operator: "equals" | "not_equals" | "lt" | "lte" | "gt" | "gte";
    left: { source_refs?: string[]; goal?: string; selector?: IntentIROperand["selector"]; value?: unknown };
    right: { source_refs?: string[]; goal?: string; selector?: IntentIROperand["selector"]; value?: unknown };
  }))>;
  unknown_goals?: Array<{ reason: string }>;
}

export interface IntentSemanticFrame {
  owner_source_ref: string;
  roles: IntentSemanticFrameRole[];
}

export interface IntentSemanticFrameBatch {
  schema_version: typeof INTENT_SEMANTIC_FRAME_SCHEMA_VERSION;
  assigned_source_refs: string[];
  frames: IntentSemanticFrame[];
}

export interface IntentSemanticFrameShard {
  id: string;
  assigned_source_refs: string[];
  context_source_refs: string[];
  estimated_output_chars: number;
  max_output_tokens: number;
}

export interface IntentSemanticFramePlan {
  schema_version: typeof INTENT_SEMANTIC_FRAME_PLAN_VERSION;
  complexity: "simple" | "complex";
  total_deadline_ms: 28000;
  max_concurrency: 3;
  max_provider_calls: 4;
  shards: IntentSemanticFrameShard[];
}

export interface IntentIRClause extends IntentIRSpan {
  id: string;
  role: ClauseRole;
  polarity: "positive" | "negative" | "neutral";
  status: "mapped" | "unmapped" | "clarify";
  reason: string;
}

export interface IntentIRGoal extends IntentIRSpan {
  id: string;
  clause_id: string;
  domain: string;
  entity: string;
  capability: string;
  target: string;
  parameters: Record<string, unknown>;
  result_kind: ResultKind;
  filter?: SourceGoal["filter"];
  item_schema?: SourceGoal["item_schema"];
  depends_on?: string[];
  required: boolean;
}

export interface IntentIRScope extends IntentIRSpan {
  id: string;
  clause_id: string;
  goal_id: string;
  kind: "depth" | "window" | "filter";
  value: string | number | boolean;
}

export interface IntentIRConstraint extends IntentIRSpan {
  id: string;
  clause_id: string;
  action: PlanConstraint["action"];
  effect: "forbid";
}

export interface IntentIREvidenceRequirement extends IntentIRSpan {
  id: string;
  clause_id: string;
  kind: "real_callback_per_goal" | "independent_verification";
  goal_ids: string[];
}

export interface IntentIRResponseRequirement extends IntentIRSpan {
  id: string;
  clause_id: string;
  kind: "cover_all" | "synthesis" | "source_order";
  goal_ids: string[];
}

export interface IntentIROperand extends IntentIRSpan {
  goal_id?: string;
  selector?: "observed" | "count" | "filtered_count";
  value?: unknown;
}

export type IntentIRPredicate = (IntentIRSpan & {
  id: string;
  clause_id: string;
  expected: boolean;
}) & ({
  kind: "quantifier";
  quantifier: "all" | "any";
  collection_goal_id: string;
  filter: NonNullable<SourceGoal["filter"]>;
} | {
  kind: "binary";
  operator: "equals" | "not_equals" | "lt" | "lte" | "gt" | "gte";
  left: IntentIROperand;
  right: IntentIROperand;
});

export interface IntentIRUnknownGoal extends IntentIRSpan {
  id: string;
  clause_id: string;
  reason: string;
}

export interface IntentIRProposal {
  schema_version: typeof INTENT_IR_SCHEMA_VERSION;
  clauses: IntentIRClause[];
  goals: IntentIRGoal[];
  scopes: IntentIRScope[];
  constraints: IntentIRConstraint[];
  evidence_requirements: IntentIREvidenceRequirement[];
  response_requirements: IntentIRResponseRequirement[];
  predicates: IntentIRPredicate[];
  unknown_goals: IntentIRUnknownGoal[];
  source_catalog?: IntentSourceCatalog;
}

export interface IntentCandidateRef { quote: string; occurrence: number; }
export interface IntentCandidateClause extends IntentCandidateRef {
  role: ClauseRole;
  polarity: "positive" | "negative" | "neutral";
  status: "mapped" | "unmapped" | "clarify";
  reason: string;
}
export interface IntentCandidateGoal extends IntentCandidateRef {
  clause: number;
  domain: string;
  entity: string;
  capability: string;
  target: string;
  parameters: Record<string, unknown>;
  result_kind: ResultKind;
  filter?: SourceGoal["filter"];
  item_schema?: SourceGoal["item_schema"];
  depends_on?: number[];
  required: boolean;
}
export interface IntentCandidateScope extends IntentCandidateRef { clause: number; goal: number; kind: "depth" | "window" | "filter"; value: string | number | boolean; }
export interface IntentCandidateConstraint extends IntentCandidateRef { clause: number; action: PlanConstraint["action"]; effect: "forbid"; }
export interface IntentCandidateEvidenceRequirement extends IntentCandidateRef { clause: number; kind: IntentIREvidenceRequirement["kind"]; goals: number[]; }
export interface IntentCandidateResponseRequirement extends IntentCandidateRef { clause: number; kind: IntentIRResponseRequirement["kind"]; goals: number[]; }
export interface IntentCandidateOperand extends IntentCandidateRef { goal?: number; selector?: IntentIROperand["selector"]; value?: unknown; }
export type IntentCandidatePredicate = (IntentCandidateRef & { clause: number; expected: boolean }) & ({
  kind: "quantifier"; quantifier: "all" | "any"; collection_goal: number; filter: NonNullable<SourceGoal["filter"]>;
} | {
  kind: "binary"; operator: "equals" | "not_equals" | "lt" | "lte" | "gt" | "gte"; left: IntentCandidateOperand; right: IntentCandidateOperand;
});
export interface IntentCandidateUnknownGoal extends IntentCandidateRef { clause: number; reason: string; }
export interface IntentCandidate {
  schema_version: typeof INTENT_CANDIDATE_SCHEMA_VERSION;
  clauses: IntentCandidateClause[];
  goals: IntentCandidateGoal[];
  scopes: IntentCandidateScope[];
  constraints: IntentCandidateConstraint[];
  evidence_requirements: IntentCandidateEvidenceRequirement[];
  response_requirements: IntentCandidateResponseRequirement[];
  predicates: IntentCandidatePredicate[];
  unknown_goals: IntentCandidateUnknownGoal[];
}

export interface IntentCandidateV2Ref { source_refs: string[]; }
export interface IntentCandidateV2Clause extends IntentCandidateV2Ref {
  role: ClauseRole;
  polarity: "positive" | "negative" | "neutral";
  status: "mapped" | "unmapped" | "clarify";
  reason: string;
}
export interface IntentCandidateV2Goal extends IntentCandidateV2Ref {
  clause: number;
  domain: string;
  entity: string;
  capability: string;
  target: string;
  parameters: Record<string, unknown>;
  result_kind: ResultKind;
  filter?: SourceGoal["filter"];
  item_schema?: SourceGoal["item_schema"];
  depends_on?: number[];
  required: boolean;
}
export interface IntentCandidateV2Scope extends IntentCandidateV2Ref { clause: number; goal: number; kind: "depth" | "window" | "filter"; value: string | number | boolean; }
export interface IntentCandidateV2Constraint extends IntentCandidateV2Ref { clause: number; action: PlanConstraint["action"]; effect: "forbid"; }
export interface IntentCandidateV2EvidenceRequirement extends IntentCandidateV2Ref { clause: number; kind: IntentIREvidenceRequirement["kind"]; goals: number[]; }
export interface IntentCandidateV2ResponseRequirement extends IntentCandidateV2Ref { clause: number; kind: IntentIRResponseRequirement["kind"]; goals: number[]; }
export interface IntentCandidateV2Operand extends IntentCandidateV2Ref { goal?: number; selector?: IntentIROperand["selector"]; value?: unknown; }
export type IntentCandidateV2Predicate = (IntentCandidateV2Ref & { clause: number; expected: boolean }) & ({
  kind: "quantifier"; quantifier: "all" | "any"; collection_goal: number; filter: NonNullable<SourceGoal["filter"]>;
} | {
  kind: "binary"; operator: "equals" | "not_equals" | "lt" | "lte" | "gt" | "gte"; left: IntentCandidateV2Operand; right: IntentCandidateV2Operand;
});
export interface IntentCandidateV2UnknownGoal extends IntentCandidateV2Ref { clause: number; reason: string; }
export interface IntentCandidateV2 {
  schema_version: typeof INTENT_CANDIDATE_V2_SCHEMA_VERSION;
  clauses: IntentCandidateV2Clause[];
  goals: IntentCandidateV2Goal[];
  scopes: IntentCandidateV2Scope[];
  constraints: IntentCandidateV2Constraint[];
  evidence_requirements: IntentCandidateV2EvidenceRequirement[];
  response_requirements: IntentCandidateV2ResponseRequirement[];
  predicates: IntentCandidateV2Predicate[];
  unknown_goals: IntentCandidateV2UnknownGoal[];
}

export interface ValidatedIntentIR extends IntentIRProposal {
  source: string;
  digest: string;
  compiler: {
    provider_model: string;
    attempt: 1 | 2;
    deterministic_validator: "intent-ir-validator/v1";
  };
}

export interface SourceGoal {
  id: string;
  source_text: string;
  source_start: number;
  source_end: number;
  normalized: string;
  domain: string;
  entity: string;
  result_kind: ResultKind;
  filter?: { field: string; operator: "suffix" | "contains" | "equals"; value: string };
  item_schema?: Record<string, "string" | "number" | "boolean">;
  predicate?: GoalPredicate;
  depends_on: string[];
  required: boolean;
  status: "mapped" | "unmapped";
}

export interface PlanConstraint {
  action: "download" | "install" | "restart" | "start" | "stop" | "write";
  effect: "forbid";
  source: string;
  source_start: number;
  source_end: number;
  clause_id: string;
}

export interface GoalRequirement {
  id: string;
  description: string;
  domain: string;
  action: OperationObjective["action"];
  target: string;
  required: boolean;
  source_goal_ids: string[];
  result_kind: ResultKind;
  filter?: SourceGoal["filter"];
  predicate?: GoalPredicate;
  depends_on_goal_ids?: string[];
  execute_step_ids: string[];
  verify_step_ids: string[];
  evidence: OperationEvidenceRequirement[];
  status?: GoalStatus;
  supporting?: boolean;
  supports_source_goal_ids?: string[];
  support_reason?: "collection_required_for_filtered_count" | "collection_required_for_count" | "dependency_required_for_judgement";
}

export interface OperationEvidenceRequirement {
  kind: string;
  step_id?: string;
  tool?: string;
  target?: string;
  parameters?: Record<string, unknown>;
  order?: number;
  expected?: unknown;
  contains?: string[];
}

export interface OperationObjective {
  schema_version: "operation-objective/v1" | "operation-objective/v2";
  digest?: string;
  capability: string;
  action: "read" | "write" | "install" | "lifecycle" | "diagnose";
  target: string;
  parameters: Record<string, unknown>;
  risk: RiskLevel;
  requires_confirmation: boolean;
  execution_evidence: OperationEvidenceRequirement[];
  verification_evidence: OperationEvidenceRequirement[];
  recovery: "retry-read" | "rollback" | "diagnose";
}

export interface AcceptanceRule {
  type: "instance_state" | "log_absence" | "plugin_enabled" | "config_semantics" | "server_ready";
  expected?: string;
  pattern?: string;
  name?: string;
}

export interface TaskPlan {
  schema_version: typeof TASK_PLAN_SCHEMA_VERSION;
  execution_mode?: "agent_direct";
  agent_execution?: AgentToolExecutionEnvelope;
  policy_version: string;
  policy_digest: string;
  task_id: string;
  instance_ref: string;
  intent: string;
  intent_ir?: ValidatedIntentIR;
  intent_ir_digest?: string;
  inventory_revision: string;
  operation: OperationObjective;
  clause_ledger: ClauseRoleEntry[];
  clause_ledger_digest: string;
  evidence_policy: EvidencePolicy;
  response_policy: ResponsePolicy;
  source_atoms: SourceAtom[];
  source_atom_digest: string;
  source_goals: SourceGoal[];
  source_goal_digest: string;
  goal_requirements: GoalRequirement[];
  constraints: PlanConstraint[];
  coverage: "full" | "partial" | "waiting";
  steps: TaskStep[];
  acceptance: AcceptanceRule[];
  confirmed_operation?: ConfirmedOperation;
  confirmed_write_proposal?: ConfirmedWriteProposal;
}

export interface AgentToolExecutionEnvelope {
  schema_version: "agent-tool-execution/v1";
  tool_call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  instance_ref: string;
  inventory_revision: string;
  policy_version: string;
  policy_digest: string;
  operation_digest: string;
}

export interface ConfirmedOperationStep {
  id: string;
  tool: string;
  target: string;
  parameters: Record<string, unknown>;
  order: number;
  purpose: "execute" | "verify";
  risk: RiskLevel;
  requires_confirmation: boolean;
}

export interface ConfirmedOperation {
  schema_version: "confirmed-operation/v1";
  instance_ref: string;
  operation_digest: string;
  risk: RiskLevel;
  requires_confirmation: true;
  steps: ConfirmedOperationStep[];
  scope_digest: string;
  summary_digest: string;
  confirmed_at: string;
  expires_at: string;
}

export interface ConfirmedWriteProposal {
  schema_version: "confirmed-write-proposal/v1";
  decision: "propose";
  tool: string;
  target: string;
  parameters: Record<string, unknown>;
  summary: string;
}

export interface ServerProfile {
  instance_id: string;
  name: string;
  platform: string;
  minecraft_version: string;
  java?: { major: number; vendor: string };
  state: "running" | "stopped" | "starting" | "unknown";
  loader?: string;
  profile_revision: string;
  provider_type: "mcsmanager" | "pterodactyl";
  collected_at: string;
  memory_bytes?: number;
  cpu_usage?: number;
}

export interface AgentEnvelope<T = unknown> {
  schema_version: typeof AGENT_MESSAGE_SCHEMA_VERSION;
  message_id: string;
  timestamp: string;
  nonce: string;
  tenant_id: string;
  agent_id: string;
  type: string;
  payload: T;
  signature?: string;
}

export interface TaskRecord {
  id: string;
  tenant_id: string;
  instance_ref: string;
  intent: string;
  risk: RiskLevel;
  state: TaskState;
  plan: TaskPlan;
  goal_statuses: Array<{
    goal_id: string;
    status: GoalStatus;
    summary: string;
  }>;
  goal_results: Array<{
    goal_id: string;
    source_goal_ids: string[];
    result_kind: ResultKind;
    status: GoalStatus;
    observed?: unknown;
    capacity?: number;
    summary: string;
    evidence_ids?: string[];
    diagnostics?: string[];
    judgement?: { predicate: GoalPredicate; operands: unknown[]; result?: boolean; reason?: string };
  }>;
  created_at: string;
  updated_at: string;
  evidence: Array<{
    kind: string;
    summary: string;
    at: string;
    step_id?: string;
    tool?: string;
    target?: string;
    parameters?: Record<string, unknown>;
    operation_digest?: string;
    confirmation_digest?: string;
    expected?: unknown;
    observed?: unknown;
    result?: "match" | "contradiction" | "insufficient";
    code?: string;
    stage?: string;
    provider_calls?: number;
    tool_calls?: number;
    command_outcome?: ConsoleCommandOutcome & { output_sha256: string };
  }>;
  assistant_response?: string;
  model_request_id?: string;
  model_status?: "answered" | "unconfigured" | "unavailable";
  completion_response?: string;
  completion_status?: "answered" | "unconfigured" | "unavailable";
  confirmation_expires_at?: string;
  session_id?: string;
  parent_task_id?: string;
  chain_depth?: number;
  completion_continuation?: {
    intent: string;
    preferred_tool?: string;
    answer: string;
    request_id?: string;
  };
}

export type ChatRoute = "direct" | "clarify" | "delegate" | "tool";

export interface ConversationSession {
  id: string;
  tenant_id: string;
  instance_ref: string;
  title: string;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  session_id: string;
  request_id?: string;
  role: "user" | "assistant";
  content: string;
  route?: ChatRoute;
  delegate?: string;
  task_id?: string;
  task_phase?: "request" | "completion";
  trace?: Array<{
    stage: "routing" | "planning" | "delegation" | "tool" | "review" | "revision" | "final";
    label: string;
    result: string;
    approved?: boolean;
  }>;
  created_at: string;
}

export const AGENT_RUN_SCHEMA_VERSION = "agent-run/v1" as const;
export const AGENT_EVENT_SCHEMA_VERSION = "agent-event/v1" as const;

export type AgentRunStatus = "RUNNING" | "WAITING_APPROVAL" | "WAITING_USER" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface AgentRunCallRecord {
  id: string;
  key: string;
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface AgentRunObservationRecord {
  tool_call_id: string;
  tool: string;
  status: "succeeded" | "failed" | "indeterminate";
  data?: unknown;
  error?: { code: string; message: string };
  retryable: boolean;
  side_effect: "none" | "possible" | "applied";
  evidence: { ids: string[]; summaries: string[] };
}

export interface AgentRunRecord {
  schema_version: typeof AGENT_RUN_SCHEMA_VERSION;
  run_id: string;
  tenant_id: string;
  session_id: string;
  instance_ref: string;
  status: AgentRunStatus;
  original_user_message: string;
  system_prompt: string;
  model_name?: string;
  prompt_version: string;
  tool_catalog_version: string;
  policy_version: string;
  round_count: number;
  tool_call_count: number;
  current_task_id?: string;
  calls: AgentRunCallRecord[];
  observations: AgentRunObservationRecord[];
  created_at: string;
  updated_at: string;
  finished_at?: string;
  version: number;
}

export type AgentEventType = "user_message" | "model_decision" | "tool_call" | "approval_requested" | "approval_resolved" | "tool_observation" | "final_answer" | "run_error";

export interface AgentEventRecord {
  schema_version: typeof AGENT_EVENT_SCHEMA_VERSION;
  event_id: string;
  run_id: string;
  sequence: number;
  type: AgentEventType;
  payload: unknown;
  created_at: string;
  idempotency_key: string;
}

export interface PendingAgentApprovalRecord {
  approval_id: string;
  run_id: string;
  task_id: string;
  call_id: string;
  tool: string;
  canonical_arguments: Record<string, unknown>;
  risk: RiskLevel;
  summary: string;
  call_hash: string;
  scope_hash: string;
  task_snapshot: TaskRecord;
  token_hash?: string;
  expires_at?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  created_at: string;
  resolved_at?: string;
  actor?: string;
}

export type ConversationStreamEvent =
  | { type: "status"; stage: "understanding" | "routing" | "planning"; text: string }
  | { type: "route"; route: ChatRoute }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; result: { message: ConversationMessage; task?: TaskRecord } }
  | { type: "error"; message: string };

export const riskRank: Record<RiskLevel, number> = {
  read: 0,
  low: 1,
  medium: 2,
  high: 3,
  forbidden: 4,
};

export interface ToolPolicy {
  action: OperationObjective["action"];
  risk: RiskLevel;
  requires_confirmation: boolean;
  mutates: boolean;
  producer_verified: boolean;
  forbidden_actions: PlanConstraint["action"][];
  evidence_kind: string;
  verification: Record<string, "same_path" | "plugins_directory" | "console_readback" | "whitelist_config" | "any">;
}

export interface ConsoleCommandOutcome {
  schema_version: "console-command-outcome/v1";
  status: "applied" | "accepted_unverified" | "rejected" | "indeterminate";
  code: "EXPLICIT_SUCCESS" | "CALLBACK_ACCEPTED" | "EMPTY_CALLBACK" | "INCOMPLETE_CALLBACK" | "OUTCOME_CONFLICT" | "NO_TARGETS" | "INVALID_COMMAND" | "PERMISSION_DENIED" | "EXECUTION_ERROR";
  user_message: string;
}

type CanonicalPolicySource = {
  schema_version: string;
  digest: string;
  action_order: OperationObjective["action"][];
  risk_order: RiskLevel[];
  target_keys: string[];
  tools: Record<string, {
    action: OperationObjective["action"];
    risk: RiskLevel;
    requires_confirmation: boolean;
    mutates: boolean;
    producer_verified?: boolean;
    evidence_kind: string;
    forbidden_actions: PlanConstraint["action"][];
    verification: ToolPolicy["verification"];
  }>;
  action_vectors: Array<{
    name: string;
    tools: string[];
    console_command?: string;
    expected: OperationObjective["action"];
  }>;
  console: {
    evidence_kind: string;
    verification: ToolPolicy["verification"];
    read_verbs: string[];
    read_exact: string[];
    read_patterns: string[];
    medium_verbs: string[];
    medium_patterns: string[];
    outcome: {
      schema_version: ConsoleCommandOutcome["schema_version"];
      completeness: {
        schema_version: "console-callback-frame/v1";
        minimum_visible_runes: number;
        user_message: string;
      };
      failure_patterns: Array<{ code: ConsoleCommandOutcome["code"]; patterns: string[]; user_message: string }>;
      success_patterns: string[];
      accepted_patterns: string[];
    };
    write_forbidden_actions: PlanConstraint["action"][];
  };
};

export const canonicalOperationPolicy = operationPolicySource as CanonicalPolicySource;
export const OPERATION_POLICY_SCHEMA = canonicalOperationPolicy.schema_version;
export const OPERATION_POLICY_DIGEST = canonicalOperationPolicy.digest;
export const OPERATION_POLICY_VERSION = `${OPERATION_POLICY_SCHEMA}:${OPERATION_POLICY_DIGEST}`;

const actionRank = Object.fromEntries(canonicalOperationPolicy.action_order.map((action, index) => [action, index])) as Record<OperationObjective["action"], number>;

export function intrinsicConsolePolicy(command: string): ToolPolicy {
  const normalized = command.trim().replace(/^minecraft:/i, "").toLowerCase();
  const verb = normalized.split(/\s+/, 1)[0] ?? "";
  const console = canonicalOperationPolicy.console;
  const read = console.read_verbs.includes(verb) || console.read_exact.includes(normalized)
    || console.read_patterns.some((pattern) => new RegExp(pattern).test(normalized));
  if (read) return { action: "read", risk: "read", requires_confirmation: false, mutates: false, producer_verified: false, forbidden_actions: [], evidence_kind: console.evidence_kind, verification: console.verification };
  const medium = console.medium_verbs.includes(verb)
    || console.medium_patterns.some((pattern) => new RegExp(pattern).test(normalized));
  const high = !medium;
  return { action: "write", risk: high ? "high" : "medium", requires_confirmation: true, mutates: true, producer_verified: false, forbidden_actions: console.write_forbidden_actions, evidence_kind: console.evidence_kind, verification: console.verification };
}

export function classifyConsoleCommandOutcome(output: string, requireExplicit = false, command = ""): ConsoleCommandOutcome {
  const policy = canonicalOperationPolicy.console.outcome;
  const normalized = output.replace(/^\s*控制台返回：\s*/u, "").trim().toLowerCase();
  if (!normalized) return {
    schema_version: policy.schema_version,
    status: "indeterminate",
    code: "EMPTY_CALLBACK",
    user_message: "服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效。",
  };
  const visibleRunes = Array.from(normalized).length;
  if (normalized.includes("\uFFFD") || (requireExplicit && visibleRunes < policy.completeness.minimum_visible_runes)) return {
    schema_version: policy.schema_version,
    status: "indeterminate",
    code: "INCOMPLETE_CALLBACK",
    user_message: policy.completeness.user_message,
  };
  const normalizedCommand = command.trim().replace(/^\//, "").toLowerCase();
  if (requireExplicit
    && /^execute\s+if\s+entity\s+@a\s+run\s+execute\s+as\s+@a\b/.test(normalizedCommand)
    && /^(?:test failed|conditional check failed)[.!]?$/i.test(normalized)) return {
    schema_version: policy.schema_version,
    status: "rejected",
    code: "NO_TARGETS",
    user_message: "没有找到符合条件的目标，因此没有对象收到或应用这次操作。",
  };
  for (const failure of policy.failure_patterns) {
    if (failure.patterns.some((pattern) => new RegExp(pattern, "u").test(normalized))) return {
      schema_version: policy.schema_version,
      status: "rejected",
      code: failure.code,
      user_message: failure.user_message,
    };
  }
  if (policy.success_patterns.some((pattern) => new RegExp(pattern, "u").test(normalized))) return {
    schema_version: policy.schema_version,
    status: "applied",
    code: "EXPLICIT_SUCCESS",
    user_message: "服务器返回了明确的成功结果。",
  };
  if (policy.accepted_patterns.some((pattern) => new RegExp(pattern, "u").test(normalized))) return {
    schema_version: policy.schema_version,
    status: "accepted_unverified",
    code: "CALLBACK_ACCEPTED",
    user_message: "服务器明确接受了命令，但没有可用的独立效果复核。",
  };
  if (requireExplicit) return {
    schema_version: policy.schema_version,
    status: "indeterminate",
    code: "INCOMPLETE_CALLBACK",
    user_message: policy.completeness.user_message,
  };
  return {
    schema_version: policy.schema_version,
    status: "accepted_unverified",
    code: "CALLBACK_ACCEPTED",
    user_message: "服务器返回了命令结果，但没有可用的独立效果复核。",
  };
}

export function intrinsicToolPolicy(tool: string, args: Record<string, unknown> = {}): ToolPolicy {
  if (tool === "console.command") return intrinsicConsolePolicy(String(args.command ?? ""));
  const policy = canonicalOperationPolicy.tools[tool];
  return policy ? { ...policy, risk: policy.risk, producer_verified: policy.producer_verified === true, forbidden_actions: [...policy.forbidden_actions], verification: { ...policy.verification } }
    : { action: "write", risk: "forbidden", requires_confirmation: true, mutates: true, producer_verified: false, forbidden_actions: ["write"], evidence_kind: "forbidden", verification: {} };
}

export function aggregateOperationAction(steps: TaskStep[]): OperationObjective["action"] {
  return steps.filter((step) => step.purpose !== "verify").reduce<OperationObjective["action"]>((result, step) => {
    const action = intrinsicToolPolicy(step.tool, step.args).action;
    return actionRank[action] > actionRank[result] ? action : result;
  }, "read");
}

export function policyTarget(step: Pick<TaskStep, "tool" | "args">) {
  for (const key of canonicalOperationPolicy.target_keys) {
    const value = step.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return step.tool;
}

export function normalizeStepPolicy(step: TaskStep): TaskStep {
  const policy = intrinsicToolPolicy(step.tool, step.args);
  const normalized: TaskStep = {
    ...step,
    risk: policy.risk,
  };
  if (policy.requires_confirmation) normalized.requires_confirmation = true;
  else delete normalized.requires_confirmation;
  return normalized;
}

export function highestRisk(steps: TaskStep[]): RiskLevel {
  return steps.reduce<RiskLevel>(
    (highest, step) => (riskRank[step.risk] > riskRank[highest] ? step.risk : highest),
    "read",
  );
}
