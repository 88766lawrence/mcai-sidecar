import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AGENT_MESSAGE_SCHEMA_VERSION, highestRisk, type TaskRecord, type TaskState } from "@mcai/contracts";
import { CloudStore } from "../store/cloud.store";
import { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import { draftPlan } from "./planner";
import { ModelGatewayService } from "../model-gateway/model-gateway.service";

const transitions: Record<TaskState, TaskState[]> = {
  DRAFTED: ["POLICY_CHECKED", "REJECTED"],
  POLICY_CHECKED: ["WAITING_CONFIRMATION", "SNAPSHOTTING"],
  WAITING_CONFIRMATION: ["SNAPSHOTTING", "CANCELLED", "EXPIRED"],
  SNAPSHOTTING: ["EXECUTING", "FAILED"],
  EXECUTING: ["VERIFYING", "FAILED", "CANCELLED"],
  VERIFYING: ["SUCCEEDED", "ROLLING_BACK", "FAILED"],
  ROLLING_BACK: ["ROLLED_BACK", "MANUAL_INTERVENTION"],
  SUCCEEDED: [], FAILED: [], ROLLED_BACK: [], REJECTED: [], CANCELLED: [], EXPIRED: [], MANUAL_INTERVENTION: [],
};

interface ConfirmationSecret {
  hash: string;
  scopeHash: string;
  expiresAt: string;
  used: boolean;
}

@Injectable()
export class TasksService {
  private readonly confirmations = new Map<string, ConfirmationSecret>();
  private readonly completionPromises = new Map<string, Promise<{
    answer: string;
    status: TaskRecord["completion_status"];
    continuation?: TaskRecord["completion_continuation"];
  }>>();

  constructor(
    private readonly store: CloudStore,
    private readonly connections: AgentConnectionRegistry,
    private readonly modelGateway: ModelGatewayService,
  ) {}

  async create(input: {
    tenantId: string;
    instanceRef: string;
    intent: string;
    assistantResponse?: string;
    modelRequestId?: string;
    modelStatus?: TaskRecord["model_status"];
    sessionId?: string;
    parentTaskId?: string;
    chainDepth?: number;
    preferredTool?: string;
  }) {
    const instance = this.store.instances.get(input.instanceRef);
    if (!instance || instance.tenant_id !== input.tenantId) throw new NotFoundException("Instance not found");
    if (!input.intent.trim() || input.intent.length > 2_000) throw new BadRequestException("Intent must contain 1-2000 characters");
    const chainDepth = Math.max(0, Math.min(6, input.chainDepth ?? 0));
    const plan = draftPlan(input.instanceRef, instance.profile_revision, input.intent.trim(), {
      preferredTool: input.preferredTool,
      platform: instance.platform,
      minecraftVersion: instance.minecraft_version,
      loader: instance.loader,
    });
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: plan.task_id,
      tenant_id: input.tenantId,
      instance_ref: input.instanceRef,
      intent: plan.intent,
      risk: highestRisk(plan.steps),
      state: "DRAFTED",
      plan,
      created_at: now,
      updated_at: now,
      evidence: [],
      session_id: input.sessionId,
      parent_task_id: input.parentTaskId,
      chain_depth: chainDepth,
    };
    this.store.tasks.set(task.id, task);
    if (task.risk === "forbidden") {
      this.move(task, "REJECTED", "Policy rejected a forbidden capability");
    } else {
      this.move(task, "POLICY_CHECKED", "Tool registry and policy checks passed");
      if (task.risk === "read" || task.risk === "low") {
        this.move(task, "SNAPSHOTTING", "Read-only task requires no mutable snapshot");
        this.dispatch(task, instance.agent_id);
      } else {
        this.move(task, "WAITING_CONFIRMATION", "Explicit confirmation required");
      }
    }
    if (input.assistantResponse) {
      task.assistant_response = input.assistantResponse;
      task.model_request_id = input.modelRequestId;
      task.model_status = input.modelStatus ?? "answered";
    } else {
      const response = await this.modelGateway.answer(task, instance);
      task.assistant_response = response.answer;
      task.model_request_id = "requestId" in response ? response.requestId : undefined;
      task.model_status = response.status;
    }
    return task;
  }

  list(tenantId: string) {
    return [...this.store.tasks.values()].filter((task) => task.tenant_id === tenantId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(taskId: string, tenantId: string) {
    const task = this.store.tasks.get(taskId);
    if (!task || task.tenant_id !== tenantId) throw new NotFoundException("Task not found");
    return task;
  }

  async complete(taskId: string, tenantId: string) {
    const task = this.get(taskId, tenantId);
    if (!terminal(task.state)) return undefined;
    if (task.completion_response) {
      return { answer: task.completion_response, status: task.completion_status, continuation: task.completion_continuation };
    }
    const pending = this.completionPromises.get(taskId);
    if (pending) return pending;

    const completion = this.buildCompletion(task);
    this.completionPromises.set(taskId, completion);
    try {
      return await completion;
    } finally {
      this.completionPromises.delete(taskId);
    }
  }

  issueConfirmation(taskId: string, tenantId: string) {
    const task = this.get(taskId, tenantId);
    if (task.state !== "WAITING_CONFIRMATION") throw new BadRequestException("Task is not awaiting confirmation");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.confirmations.set(taskId, {
      hash: sha256(token),
      scopeHash: this.scopeHash(task),
      expiresAt,
      used: false,
    });
    task.confirmation_expires_at = expiresAt;
    return { token, expires_at: expiresAt, scope_hash: this.scopeHash(task) };
  }

  confirm(taskId: string, tenantId: string, token: string) {
    const task = this.get(taskId, tenantId);
    const confirmation = this.confirmations.get(taskId);
    if (!confirmation || confirmation.used || confirmation.hash !== sha256(token)) throw new BadRequestException("Invalid confirmation token");
    if (Date.parse(confirmation.expiresAt) < Date.now()) {
      this.move(task, "EXPIRED", "Confirmation token expired");
      throw new BadRequestException("Confirmation token expired");
    }
    if (confirmation.scopeHash !== this.scopeHash(task)) throw new BadRequestException("Task plan changed after confirmation was issued");
    confirmation.used = true;
    this.move(task, "SNAPSHOTTING", "User confirmed the exact plan scope");
    const instance = this.store.instances.get(task.instance_ref)!;
    this.dispatch(task, instance.agent_id);
    return task;
  }

  async recordAgentEvent(payload: Record<string, unknown>) {
    const taskId = String(payload.task_id ?? "");
    const task = this.store.tasks.get(taskId);
    if (!task) return;
    const state = String(payload.state ?? "") as TaskState;
    if (state && transitions[task.state]?.includes(state)) {
      const summary = String(payload.summary ?? state);
      this.move(task, state, summary);
      if (state === "FAILED") {
        const instance = this.store.instances.get(task.instance_ref);
        if (instance) {
          task.evidence.push({
            kind: "decision",
            summary: await this.modelGateway.decideRecovery(task, instance, summary),
            at: new Date().toISOString(),
          });
          task.updated_at = new Date().toISOString();
        }
      }
    }
    else if (payload.summary) task.evidence.push({ kind: String(payload.kind ?? "agent"), summary: String(payload.summary), at: new Date().toISOString() });
  }

  private dispatch(task: TaskRecord, agentId: string) {
    const sent = this.connections.send(agentId, {
      schema_version: AGENT_MESSAGE_SCHEMA_VERSION,
      message_id: randomUUID(),
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
      tenant_id: task.tenant_id,
      agent_id: agentId,
      type: "task.execute",
      payload: task.plan,
    });
    if (!sent) {
      const at = new Date().toISOString();
      task.evidence.push({
        kind: "diagnosis",
        summary: "Cloud 未检测到该实例所属 Agent 的在线连接，任务没有下发到服务器。",
        at,
      });
      this.move(task, "FAILED", "Agent is offline; task was not executed");
      task.evidence.push({
        kind: "decision",
        summary: "先恢复 Agent 服务或网络连接，确认节点重新上线后再重试任务。",
        at: new Date().toISOString(),
      });
      task.updated_at = new Date().toISOString();
    }
  }

  private async buildCompletion(task: TaskRecord) {
    const instance = this.store.instances.get(task.instance_ref);
    const fallback = completionFallback(task);
    if (!instance) {
      task.completion_response = fallback;
      task.completion_status = "unavailable";
      return { answer: fallback, status: task.completion_status };
    }
    const response = await this.modelGateway.answer(task, instance);
    task.completion_response = response.status === "answered" && response.answer.trim() ? response.answer.trim() : fallback;
    task.completion_status = response.status;
    task.completion_continuation = response.continuation ? {
      intent: response.continuation.toolIntent!.trim(),
      preferred_tool: response.continuation.preferredTool,
      answer: response.continuation.answer,
      request_id: response.continuation.requestId,
    } : undefined;
    task.updated_at = new Date().toISOString();
    return { answer: task.completion_response, status: task.completion_status, continuation: task.completion_continuation };
  }

  private move(task: TaskRecord, next: TaskState, summary: string) {
    if (!transitions[task.state].includes(next)) throw new BadRequestException(`Invalid transition ${task.state} -> ${next}`);
    task.state = next;
    task.updated_at = new Date().toISOString();
    task.evidence.push({ kind: "state", summary, at: task.updated_at });
    return task;
  }

  private scopeHash(task: TaskRecord) {
    return sha256(JSON.stringify({ tenant: task.tenant_id, instance: task.instance_ref, plan: task.plan }));
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function terminal(state: TaskState) {
  return ["SUCCEEDED", "FAILED", "ROLLED_BACK", "REJECTED", "CANCELLED", "EXPIRED", "MANUAL_INTERVENTION"].includes(state);
}

function completionFallback(task: TaskRecord) {
  const latest = (kind: string) => [...task.evidence].reverse().find((item) => item.kind === kind)?.summary;
  if (task.state === "SUCCEEDED") {
    return latest("console") || latest("files") || latest("logs") || latest("config") || latest("instance") || "任务已完成，验证已通过。";
  }
  const diagnosis = latest("diagnosis") || latest("state") || "任务未能完成。";
  const next = latest("decision");
  return next ? `${diagnosis}\n\n下一步：${next}` : diagnosis;
}
