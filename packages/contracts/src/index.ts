export const TASK_PLAN_SCHEMA_VERSION = "task-plan/v1" as const;
export const AGENT_MESSAGE_SCHEMA_VERSION = "agent-message/v1" as const;

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
  requires_confirmation?: boolean;
  rollback?: { tool: string; snapshot: string };
}

export interface AcceptanceRule {
  type: "instance_state" | "log_absence" | "plugin_enabled" | "config_semantics" | "server_ready";
  expected?: string;
  pattern?: string;
  name?: string;
}

export interface TaskPlan {
  schema_version: typeof TASK_PLAN_SCHEMA_VERSION;
  task_id: string;
  instance_ref: string;
  intent: string;
  inventory_revision: string;
  steps: TaskStep[];
  acceptance: AcceptanceRule[];
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
  created_at: string;
  updated_at: string;
  evidence: Array<{ kind: string; summary: string; at: string }>;
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
    stage: "routing" | "delegation" | "tool" | "review" | "revision" | "final";
    label: string;
    result: string;
    approved?: boolean;
  }>;
  created_at: string;
}

export type ConversationStreamEvent =
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

export function highestRisk(steps: TaskStep[]): RiskLevel {
  return steps.reduce<RiskLevel>(
    (highest, step) => (riskRank[step.risk] > riskRank[highest] ? step.risk : highest),
    "read",
  );
}
