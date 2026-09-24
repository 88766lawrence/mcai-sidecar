import { Injectable, OnModuleInit, Optional } from "@nestjs/common";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AGENT_RUN_SCHEMA_VERSION,
  type AgentEventRecord,
  type AgentEventType,
  type AgentRunCallRecord,
  type AgentRunObservationRecord,
  type AgentRunRecord,
  type AgentRunStatus,
  type PendingAgentApprovalRecord,
} from "@mcai/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface PersistedAgentRuns {
  schema_version: "agent-run-store/v1";
  runs: AgentRunRecord[];
  events: AgentEventRecord[];
  approvals: PendingAgentApprovalRecord[];
}

type CreateRunInput = Pick<AgentRunRecord,
  "tenant_id" | "session_id" | "instance_ref" | "original_user_message" | "system_prompt" |
  "prompt_version" | "tool_catalog_version" | "policy_version"
> & {
  model_name?: string;
  current_task_id?: string;
  initial_call?: AgentRunCallRecord;
};

const emptyStore = (): PersistedAgentRuns => ({ schema_version: "agent-run-store/v1", runs: [], events: [], approvals: [] });

@Injectable()
export class AgentRunStore implements OnModuleInit {
  private readonly path: string;
  private data = emptyStore();
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(@Optional() path?: string) {
    this.path = path ?? join(resolve(process.env.MCAI_CONFIG_DIR ?? join(process.cwd(), ".data", "mcai")), "agent-runs.json");
  }

  async onModuleInit() { await this.initialize(); }

  async initialize() {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as PersistedAgentRuns;
      if (parsed?.schema_version === "agent-run-store/v1" && Array.isArray(parsed.runs) && Array.isArray(parsed.events) && Array.isArray(parsed.approvals)) {
        this.data = parsed;
      }
    } catch {
      this.data = emptyStore();
    }
    this.initialized = true;
  }

  async create(input: CreateRunInput) {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const run: AgentRunRecord = {
        schema_version: AGENT_RUN_SCHEMA_VERSION,
        run_id: `run_${randomUUID()}`,
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        instance_ref: input.instance_ref,
        status: "RUNNING",
        original_user_message: input.original_user_message,
        system_prompt: input.system_prompt,
        model_name: input.model_name,
        prompt_version: input.prompt_version,
        tool_catalog_version: input.tool_catalog_version,
        policy_version: input.policy_version,
        round_count: input.initial_call ? 1 : 0,
        tool_call_count: input.initial_call ? 1 : 0,
        current_task_id: input.current_task_id,
        calls: input.initial_call ? [structuredClone(input.initial_call)] : [],
        observations: [],
        created_at: now,
        updated_at: now,
        version: 1,
      };
      this.data.runs.push(run);
      this.appendEvent(run.run_id, "user_message", { content: input.original_user_message }, `user:${input.session_id}:${input.current_task_id}`, now);
      if (input.initial_call) this.appendEvent(run.run_id, "tool_call", input.initial_call, `call:${input.initial_call.id}`, now);
      return structuredClone(run);
    });
  }

  async start(runId: string, taskId: string, call: AgentRunCallRecord) {
    return this.mutate(() => {
      const run = this.requiredRun(runId);
      if (run.status === "CANCELLED") return structuredClone(run);
      if (run.current_task_id || run.calls.length || run.round_count || run.tool_call_count) throw new Error("AGENT_RUN_ALREADY_STARTED");
      run.current_task_id = taskId;
      run.calls.push(structuredClone(call));
      run.round_count = 1;
      run.tool_call_count = 1;
      this.touch(run);
      this.appendEvent(runId, "tool_call", call, `call:${call.id}`);
      return structuredClone(run);
    });
  }

  async findByCurrentTask(taskId: string, tenantId: string) {
    await this.initialize();
    const run = this.data.runs.find((candidate) => candidate.current_task_id === taskId && candidate.tenant_id === tenantId && candidate.status === "RUNNING");
    return run ? structuredClone(run) : undefined;
  }

  async findByTask(taskId: string, tenantId: string) {
    await this.initialize();
    const run = this.data.runs.find((candidate) => candidate.current_task_id === taskId && candidate.tenant_id === tenantId);
    return run ? structuredClone(run) : undefined;
  }

  async findByCall(callId: string, tenantId: string) {
    await this.initialize();
    const run = this.data.runs.find((candidate) => candidate.tenant_id === tenantId
      && candidate.calls.some((call) => call.id === callId));
    return run ? structuredClone(run) : undefined;
  }

  async recordObservation(runId: string, taskId: string, observation: AgentRunObservationRecord) {
    return this.mutate(() => {
      const run = this.requiredRun(runId);
      if (run.status === "CANCELLED") return structuredClone(run);
      if (run.current_task_id !== taskId || run.observations.some((item) => item.tool_call_id === observation.tool_call_id)) return structuredClone(run);
      run.observations.push(structuredClone(observation));
      this.touch(run);
      this.appendEvent(runId, "tool_observation", observation, `observation:${observation.tool_call_id}`);
      return structuredClone(run);
    });
  }

  async recordDecision(runId: string, round: number, decision: unknown) {
    return this.mutate(() => {
      const run = this.requiredRun(runId);
      if (run.status === "CANCELLED") return structuredClone(run);
      this.appendEvent(runId, "model_decision", decision, `decision:${round}`);
      return structuredClone(run);
    });
  }

  async recordDecisionError(runId: string, round: number, error: Record<string, unknown>) {
    return this.mutate(() => {
      const run = this.requiredRun(runId);
      if (run.status === "CANCELLED") return structuredClone(run);
      this.appendEvent(runId, "run_error", { stage: "model_decision", round, ...error }, `decision-error:${round}`);
      return structuredClone(run);
    });
  }

  async advance(runId: string, previousTaskId: string, nextTaskId: string, call: AgentRunCallRecord) {
    return this.mutate(() => {
      const run = this.requiredRun(runId);
      if (run.status === "CANCELLED") return structuredClone(run);
      if (run.current_task_id !== previousTaskId) throw new Error("AGENT_RUN_TASK_MISMATCH");
      if (run.calls.some((item) => item.id === call.id)) return structuredClone(run);
      run.calls.push(structuredClone(call));
      run.current_task_id = nextTaskId;
      run.round_count += 1;
      run.tool_call_count += 1;
      this.touch(run);
      this.appendEvent(runId, "tool_call", call, `call:${call.id}`);
      return structuredClone(run);
    });
  }

  async finish(runId: string, status: Extract<AgentRunStatus, "SUCCEEDED" | "FAILED" | "CANCELLED">, payload: unknown) {
    return this.mutate(() => {
      const run = this.requiredRun(runId);
      if (run.status !== "RUNNING") return structuredClone(run);
      run.status = status;
      run.current_task_id = undefined;
      run.finished_at = new Date().toISOString();
      this.touch(run);
      this.appendEvent(runId, status === "SUCCEEDED" ? "final_answer" : "run_error", payload, `finish:${runId}`);
      return structuredClone(run);
    });
  }

  async putApproval(approval: PendingAgentApprovalRecord) {
    return this.mutate(() => {
      if (this.data.approvals.some((candidate) => candidate.approval_id === approval.approval_id || candidate.run_id === approval.run_id && candidate.call_id === approval.call_id)) {
        throw new Error("AGENT_APPROVAL_ALREADY_EXISTS");
      }
      const run = this.requiredRun(approval.run_id);
      this.data.approvals.push(structuredClone(approval));
      run.status = "WAITING_APPROVAL";
      this.touch(run);
      this.appendEvent(run.run_id, "approval_requested", approval, `approval:${approval.approval_id}`);
      return structuredClone(approval);
    });
  }

  async getApproval(approvalId: string) {
    await this.initialize();
    const approval = this.data.approvals.find((candidate) => candidate.approval_id === approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  async pendingApprovalForTask(taskId: string, tenantId: string) {
    await this.initialize();
    const runIds = new Set(this.data.runs.filter((run) => run.tenant_id === tenantId).map((run) => run.run_id));
    const approval = this.data.approvals.find((candidate) => candidate.task_id === taskId && candidate.status === "PENDING" && runIds.has(candidate.run_id));
    return approval ? structuredClone(approval) : undefined;
  }

  async pendingApprovals() {
    await this.initialize();
    return this.data.approvals.filter((candidate) => candidate.status === "PENDING").map((candidate) => structuredClone(candidate));
  }

  async removeBySession(sessionId: string, tenantId: string) {
    return this.mutate(() => {
      const matching = this.data.runs.filter((run) => run.session_id === sessionId && run.tenant_id === tenantId);
      const runIds = new Set(matching.map((run) => run.run_id));
      if (!runIds.size) return { removed_runs: 0, removed_events: 0, removed_approvals: 0 };
      const beforeEvents = this.data.events.length;
      const beforeApprovals = this.data.approvals.length;
      this.data.runs = this.data.runs.flatMap((run) => {
        if (!runIds.has(run.run_id)) return [run];
        // A model request may still be in flight after the user deletes the
        // session. Keep a scrubbed cancellation tombstone so its late callback
        // cannot turn a normal deletion into AGENT_RUN_NOT_FOUND or a new task.
        if (run.status !== "RUNNING") return [];
        run.status = "CANCELLED";
        run.original_user_message = "";
        run.system_prompt = "";
        run.model_name = undefined;
        run.current_task_id = undefined;
        run.calls = [];
        run.observations = [];
        run.round_count = 0;
        run.tool_call_count = 0;
        run.finished_at = new Date().toISOString();
        this.touch(run);
        return [run];
      });
      this.data.events = this.data.events.filter((event) => !runIds.has(event.run_id));
      this.data.approvals = this.data.approvals.filter((approval) => !runIds.has(approval.run_id));
      return {
        removed_runs: runIds.size,
        removed_events: beforeEvents - this.data.events.length,
        removed_approvals: beforeApprovals - this.data.approvals.length,
      };
    });
  }

  async issueApprovalToken(taskId: string, tenantId: string, tokenHash: string, scopeHash: string, expiresAt: string) {
    return this.mutate(() => {
      const runIds = new Set(this.data.runs.filter((run) => run.tenant_id === tenantId).map((run) => run.run_id));
      const approval = this.data.approvals.find((candidate) => candidate.task_id === taskId && candidate.status === "PENDING" && runIds.has(candidate.run_id));
      if (!approval) throw new Error("AGENT_APPROVAL_NOT_FOUND");
      if (approval.scope_hash !== scopeHash) throw new Error("AGENT_APPROVAL_SCOPE_MISMATCH");
      approval.token_hash = tokenHash;
      approval.expires_at = expiresAt;
      approval.task_snapshot.confirmation_expires_at = expiresAt;
      this.appendEvent(approval.run_id, "approval_requested", { approval_id: approval.approval_id, expires_at: expiresAt }, `approval-token:${approval.approval_id}`);
      return structuredClone(approval);
    });
  }

  async consumeApproval(taskId: string, tenantId: string, tokenHash: string, scopeHash: string, callHash: string, actor: string, now = Date.now()) {
    return this.mutate(() => {
      const runIds = new Set(this.data.runs.filter((run) => run.tenant_id === tenantId).map((run) => run.run_id));
      const approval = this.data.approvals.find((candidate) => candidate.task_id === taskId && runIds.has(candidate.run_id));
      if (!approval) throw new Error("AGENT_APPROVAL_NOT_FOUND");
      if (approval.status !== "PENDING") throw new Error("AGENT_APPROVAL_ALREADY_RESOLVED");
      if (!approval.token_hash || approval.token_hash !== tokenHash) throw new Error("AGENT_APPROVAL_INVALID_TOKEN");
      if (!approval.expires_at || Date.parse(approval.expires_at) < now) throw new Error("AGENT_APPROVAL_EXPIRED");
      if (approval.scope_hash !== scopeHash) throw new Error("AGENT_APPROVAL_SCOPE_MISMATCH");
      if (approval.call_hash !== callHash) throw new Error("AGENT_APPROVAL_CALL_MISMATCH");
      approval.status = "APPROVED";
      approval.actor = actor;
      approval.resolved_at = new Date(now).toISOString();
      const run = this.requiredRun(approval.run_id);
      run.status = "RUNNING";
      this.touch(run);
      this.appendEvent(run.run_id, "approval_resolved", { approval_id: approval.approval_id, status: "APPROVED", actor }, `approval-resolution:${approval.approval_id}`);
      return structuredClone(approval);
    });
  }

  async resolveApproval(approvalId: string, status: Extract<PendingAgentApprovalRecord["status"], "APPROVED" | "REJECTED" | "EXPIRED">, actor: string) {
    return this.mutate(() => {
      const approval = this.data.approvals.find((candidate) => candidate.approval_id === approvalId);
      if (!approval) throw new Error("AGENT_APPROVAL_NOT_FOUND");
      if (approval.status !== "PENDING") return structuredClone(approval);
      approval.status = status;
      approval.actor = actor;
      approval.resolved_at = new Date().toISOString();
      const run = this.requiredRun(approval.run_id);
      run.status = status === "APPROVED" ? "RUNNING" : status === "REJECTED" ? "CANCELLED" : "FAILED";
      this.touch(run);
      this.appendEvent(run.run_id, "approval_resolved", { approval_id: approvalId, status, actor }, `approval-resolution:${approvalId}`);
      return structuredClone(approval);
    });
  }

  async get(runId: string, tenantId: string) {
    await this.initialize();
    const run = this.data.runs.find((candidate) => candidate.run_id === runId && candidate.tenant_id === tenantId);
    return run ? structuredClone(run) : undefined;
  }

  async events(runId: string) {
    await this.initialize();
    return this.data.events.filter((event) => event.run_id === runId).sort((a, b) => a.sequence - b.sequence).map((event) => structuredClone(event));
  }

  private async mutate<T>(change: () => T): Promise<T> {
    await this.initialize();
    let result!: T;
    const operation = this.writeQueue.then(async () => {
      result = change();
      await this.persist();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private requiredRun(runId: string) {
    const run = this.data.runs.find((candidate) => candidate.run_id === runId);
    if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
    return run;
  }

  private touch(run: AgentRunRecord) {
    run.version += 1;
    run.updated_at = new Date().toISOString();
  }

  private appendEvent(runId: string, type: AgentEventType, payload: unknown, idempotencyKey: string, now = new Date().toISOString()) {
    if (this.data.events.some((event) => event.run_id === runId && event.idempotency_key === idempotencyKey)) return;
    const sequence = this.data.events.filter((event) => event.run_id === runId).length + 1;
    this.data.events.push({
      schema_version: AGENT_EVENT_SCHEMA_VERSION,
      event_id: `event_${randomUUID()}`,
      run_id: runId,
      sequence,
      type,
      payload: structuredClone(payload),
      created_at: now,
      idempotency_key: idempotencyKey,
    });
  }

  private async persist() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
