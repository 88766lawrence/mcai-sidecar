import { createHash, randomUUID } from "node:crypto";
import {
  OPERATION_POLICY_DIGEST,
  OPERATION_POLICY_VERSION,
  TASK_PLAN_SCHEMA_VERSION,
  type TaskPlan,
} from "@mcai/contracts";
import type { AgentLoopToolCall } from "../chat/agent-loop";
import { deriveOperationObjective } from "./operation-intent";

type ValidatedAgentCall = AgentLoopToolCall & {
  policy: { risk: TaskPlan["steps"][number]["risk"]; requires_confirmation: boolean };
};

export function buildAgentDirectExecutionPlan(
  instanceRef: string,
  inventoryRevision: string,
  intent: string,
  toolCallId: string,
  call: ValidatedAgentCall,
): TaskPlan {
  const step: TaskPlan["steps"][number] = {
    id: "s1",
    tool: call.tool,
    args: structuredClone(call.arguments),
    risk: call.policy.risk,
    purpose: "execute",
    requires_confirmation: call.policy.requires_confirmation,
  };
  const operation = deriveOperationObjective(intent, [step], []);
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION,
    execution_mode: "agent_direct",
    agent_execution: {
      schema_version: "agent-tool-execution/v1",
      tool_call_id: toolCallId,
      tool: call.tool,
      arguments: structuredClone(call.arguments),
      instance_ref: instanceRef,
      inventory_revision: inventoryRevision,
      policy_version: OPERATION_POLICY_VERSION,
      policy_digest: OPERATION_POLICY_DIGEST,
      operation_digest: operation.digest!,
    },
    policy_version: OPERATION_POLICY_VERSION,
    policy_digest: OPERATION_POLICY_DIGEST,
    task_id: `task_${randomUUID()}`,
    instance_ref: instanceRef,
    intent,
    inventory_revision: inventoryRevision,
    operation,
    clause_ledger: [],
    clause_ledger_digest: emptyDigest(),
    evidence_policy: { require_real_callback_per_goal: true, require_independent_verification: false, clause_ids: [] },
    response_policy: { cover_all_required_goals: false, require_synthesis: false, clause_ids: [] },
    source_atoms: [],
    source_atom_digest: emptyDigest(),
    source_goals: [],
    source_goal_digest: emptyDigest(),
    goal_requirements: [],
    constraints: [],
    coverage: "full",
    steps: [step],
    acceptance: [],
  };
}

function emptyDigest() { return createHash("sha256").update("[]").digest("hex"); }
