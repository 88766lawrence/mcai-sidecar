import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AGENT_MESSAGE_SCHEMA_VERSION, classifyConsoleCommandOutcome, highestRisk, intrinsicToolPolicy, policyTarget, type ConsoleCommandOutcome, type PendingAgentApprovalRecord, type ServerProfile, type TaskPlan, type TaskRecord, type TaskState } from "@mcai/contracts";
import { CloudStore } from "../store/cloud.store";
import { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import { draftPlan, extractConfigInspectIntent, extractFilesListIntent, extractPluginResolveIntent } from "./planner";
import { buildAgentDirectExecutionPlan } from "./agent-execution-plan";
import { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { adaptGoalResult, evaluateGoalPredicate, parsePluginResolveResult } from "./result-adapters";
import { validatePlanCompatibility } from "./plan-compatibility";
import { buildIntentSourceCatalog, compileIntentCandidateV2, compileIntentIR, type IntentIRValidationError } from "./intent-ir";
import { buildConfirmedWriteWaitingPlan, buildDeterministicLifecyclePlan, isCompactConfirmedWriteCandidate, validateConfirmedWriteProposal } from "./confirmed-write-proposal";
import { extractActionbarConsoleCommand, extractBroadcastConsoleCommand, extractTitleConsoleCommand, extractTransientPlayerEffectCommand, hasInstanceLifecycleLanguage, isOnlinePlayerReadIntent, isRuntimeVersionReadIntent, performanceReadMetrics, resolveBoundedConsoleWrite, resolveInstanceLifecycleIntent } from "./operation-intent";
import { explicitPluginInstallProject } from "./planner";
import { safeTaskAnswer, safeUserText } from "../chat/user-safe-response";
import { conditionalFirstPlayerGamemodeIntent, extractLogQueryIntent } from "./goal-requirements";
import { extractWhitelistReadIntent } from "./whitelist-read-intent";
import { renderTypedReadCompletion } from "./typed-read-completion";
import { extractGameruleReadIntent } from "./gamerule-read-intent";
import { extractRuntimeConsoleRead } from "./runtime-console-read";
import { matchRegisteredCapability } from "./capability-registry";
import { validateAgentToolCall, type AgentLoopObservation, type AgentLoopToolCall } from "../chat/agent-loop";
import { AgentRunStore } from "../agents/agent-run.store";
import { projectQa0144ReadResult } from "./qa0144-read-observation";

const transitions: Record<TaskState, TaskState[]> = {
  DRAFTED: ["POLICY_CHECKED", "REJECTED", "WAITING"],
  POLICY_CHECKED: ["WAITING_CONFIRMATION", "SNAPSHOTTING"],
  WAITING_CONFIRMATION: ["SNAPSHOTTING", "CANCELLED", "EXPIRED"],
  SNAPSHOTTING: ["EXECUTING", "VERIFYING", "SUCCEEDED", "PARTIAL", "FAILED", "REJECTED"],
  EXECUTING: ["VERIFYING", "SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "REJECTED"],
  VERIFYING: ["SUCCEEDED", "PARTIAL", "ROLLING_BACK", "FAILED", "REJECTED"],
  ROLLING_BACK: ["ROLLED_BACK", "MANUAL_INTERVENTION"],
  SUCCEEDED: [], PARTIAL: [], WAITING: [], FAILED: [], ROLLED_BACK: [], REJECTED: [], CANCELLED: [], EXPIRED: [], MANUAL_INTERVENTION: [],
};

interface ConfirmationSecret {
  hash: string;
  scopeHash: string;
  expiresAt: string;
  used: boolean;
}

export interface TaskRuntimePolicy {
  now?: () => number;
  stageTimeoutMs?: Partial<Record<"SNAPSHOTTING" | "EXECUTING" | "VERIFYING", number>>;
  watchdogIntervalMs?: number;
}

@Injectable()
export class TasksService {
  private readonly confirmations = new Map<string, ConfirmationSecret>();
  private readonly completionPromises = new Map<string, Promise<{
    answer: string;
    status: TaskRecord["completion_status"];
    continuation?: TaskRecord["completion_continuation"];
  }>>();
  private readonly deadlines = new Map<string, number>();
  private readonly agentToolCalls = new Map<string, { id: string; call: AgentLoopToolCall }>();
  private watchdog?: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: CloudStore,
    private readonly connections: AgentConnectionRegistry,
    private readonly modelGateway: ModelGatewayService,
    @Optional() private readonly runtimePolicy: TaskRuntimePolicy = {},
    @Optional() private readonly agentRuns?: AgentRunStore,
  ) {}

  async onModuleInit() {
    if (this.agentRuns) {
      for (const approval of await this.agentRuns.pendingApprovals()) {
        if (!this.store.tasks.has(approval.task_id)) this.store.tasks.set(approval.task_id, structuredClone(approval.task_snapshot));
      }
    }
    const interval = this.runtimePolicy.watchdogIntervalMs ?? Number(process.env.MCAI_TASK_WATCHDOG_INTERVAL_MS ?? 5_000);
    if (interval <= 0) return;
    this.watchdog = setInterval(() => this.sweepExpiredTasks(), interval);
    this.watchdog.unref?.();
  }

  onModuleDestroy() { if (this.watchdog) clearInterval(this.watchdog); }

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
    agentToolCall?: AgentLoopToolCall & { toolCallId: string };
  }) {
    const instance = this.store.instances.get(input.instanceRef);
    if (!instance || instance.tenant_id !== input.tenantId) throw new NotFoundException("Instance not found");
    if (!input.intent.trim() || input.intent.length > 2_000) throw new BadRequestException("Intent must contain 1-2000 characters");
    const chainDepth = Math.max(0, Math.min(6, input.chainDepth ?? 0));
    const intent = input.intent.trim();
    let intentIR;
    let compilerErrors: IntentIRValidationError[] = [];
    let compactProposalError: { code: string; message: string } | undefined;
    let compactProposalResponse: { summary: string; requestId?: string } | undefined;
    let plan: TaskPlan | undefined;
    let semanticFallback: TaskPlan | undefined;
    if (input.agentToolCall) {
      const checked = validateAgentToolCall(input.agentToolCall, input.instanceRef, instance.profile_revision);
      if (!checked.ok) throw new BadRequestException(`${checked.code}: ${checked.message}`);
      plan = buildAgentDirectExecutionPlan(input.instanceRef, instance.profile_revision, intent, input.agentToolCall.toolCallId, checked.value);
    }
    const playerMessageCommand = extractTitleConsoleCommand(intent) ?? extractActionbarConsoleCommand(intent) ?? extractBroadcastConsoleCommand(intent) ?? extractTransientPlayerEffectCommand(intent);
    const lifecycle = playerMessageCommand ? undefined : resolveInstanceLifecycleIntent(intent);
    const lifecycleLanguage = playerMessageCommand ? false : hasInstanceLifecycleLanguage(intent);
    if (!plan && lifecycle && input.preferredTool !== "plugin.install") {
      plan = buildDeterministicLifecyclePlan({ intent, instanceRef: input.instanceRef, inventoryRevision: instance.profile_revision }, lifecycle.tool);
    }
    if (!plan && !lifecycle && lifecycleLanguage) {
      plan = buildConfirmedWriteWaitingPlan({ intent, instanceRef: input.instanceRef, inventoryRevision: instance.profile_revision });
    }
    if (!plan && input.preferredTool === "plugin.install" && explicitPluginInstallProject(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "plugin.install", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    // An explicit bounded configuration read owns its path and key identifiers.
    // Route it before adjacent lexical domains so key names cannot manufacture
    // player, access, performance, runtime, or gamerule operations.
    if (!plan && input.preferredTool === "config.inspect" && extractConfigInspectIntent(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "config.inspect", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    // The registry is the authoritative deterministic compiler for its
    // parameter-free read capabilities. Run it before adjacent lexical
    // domains (notably plugin metadata and generic runtime reads) can claim
    // the same words with a different capability.
    const registeredCapability = !plan ? matchRegisteredCapability(intent) : undefined;
    if (!plan && registeredCapability) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        registeredCapability, platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    // Registered, parameter-free, read-only observations must not wait on the
    // semantic compiler. The deterministic domain router already proved this
    // is a player-presence read and draftPlan binds it to the canonical list
    // command with intrinsic read risk.
    if (!plan && (isOnlinePlayerReadIntent(intent) || conditionalFirstPlayerGamemodeIntent(intent))) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && extractWhitelistReadIntent(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "console.command", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && extractGameruleReadIntent(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "console.command", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && extractRuntimeConsoleRead(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "console.command", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && performanceReadMetrics(intent).length > 0) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && isRuntimeVersionReadIntent(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && extractFilesListIntent(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "files.list", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    if (!plan && extractPluginResolveIntent(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "plugin.resolve", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    const deterministicLogQuery = !plan ? extractLogQueryIntent(intent) : undefined;
    if (!plan && deterministicLogQuery && deterministicLogQuery.filter_query.groups.length >= explicitTopLevelOrBranchCount(intent)) {
      plan = draftPlan(input.instanceRef, instance.profile_revision, intent, {
        preferredTool: "logs.query", platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
      });
    }
    // Deterministic recognizers remain the fast path only when they cover every
    // required goal and produce a complete auditable reverse mapping. Partial
    // or structurally incomplete read plans are handed to the bounded semantic
    // compiler instead of guessing or dispatching a knowingly incomplete tool.
    if (plan && !input.agentToolCall && !registeredCapability && requiresSemanticCompletion(plan)) {
      semanticFallback = { ...plan, coverage: "waiting" };
      plan = undefined;
    }
    const boundedConsoleWrite = !plan ? resolveBoundedConsoleWrite(intent) : undefined;
    if (!plan && boundedConsoleWrite) {
      const checked = validateConfirmedWriteProposal({
        schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command",
        parameters: { command: boundedConsoleWrite }, summary: "已准备一个受控控制台操作，确认后执行。",
      }, { intent, instanceRef: input.instanceRef, inventoryRevision: instance.profile_revision });
      if (checked.ok) {
        plan = checked.plan;
        compactProposalResponse = { summary: checked.proposal.summary };
      } else compactProposalError = { code: checked.code, message: checked.message };
    }
    if (!plan && playerMessageCommand) {
      const checked = validateConfirmedWriteProposal({
        schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command",
        parameters: { command: playerMessageCommand }, summary: "玩家消息命令已准备，等待确认后执行。",
      }, { intent, instanceRef: input.instanceRef, inventoryRevision: instance.profile_revision });
      if (checked.ok) {
        plan = checked.plan;
        compactProposalResponse = { summary: checked.proposal.summary };
      } else compactProposalError = { code: checked.code, message: checked.message };
    }
    const proposer = (this.modelGateway as ModelGatewayService & { proposeConfirmedWrite?: ModelGatewayService["proposeConfirmedWrite"] }).proposeConfirmedWrite;
    const compactCandidate = isCompactConfirmedWriteCandidate(intent) && typeof proposer === "function";
    if (!plan && compactCandidate) {
      const proposed = await proposer.call(this.modelGateway, { intent, instance });
      if (proposed.status === "answered") {
        const checked = validateConfirmedWriteProposal(proposed.proposal, { intent, instanceRef: input.instanceRef, inventoryRevision: instance.profile_revision });
        if (checked.ok) {
          plan = checked.plan;
          compactProposalResponse = { summary: checked.proposal.summary, requestId: proposed.requestId };
        } else compactProposalError = { code: checked.code, message: checked.message };
      } else compactProposalError = { code: proposed.error, message: "紧凑写操作提案暂时不可用" };
      if (!plan) plan = buildConfirmedWriteWaitingPlan({ intent, instanceRef: input.instanceRef, inventoryRevision: instance.profile_revision });
    }
    const sourceCatalog = compactCandidate ? undefined : buildIntentSourceCatalog(intent);
    const compiler = (this.modelGateway as ModelGatewayService & { compileIntent?: ModelGatewayService["compileIntent"] }).compileIntent;
    if (!plan && sourceCatalog && typeof compiler === "function") {
      const first = await compiler.call(this.modelGateway, { sourceCatalog, instance, attempt: 1 });
      if (first.status === "answered") {
        let expanded = compileIntentCandidateV2(intent, sourceCatalog, first.candidate);
        let compiled = expanded.ok ? compileIntentIR(intent, expanded.proposal, { providerModel: first.providerModel, attempt: 1 }) : expanded;
        if (!compiled.ok) {
          compilerErrors = compiled.errors;
          this.modelGateway.recordIntentCompilerTerminal({ requestId: first.requestId, providerModel: first.providerModel, compilerMetrics: first.compilerMetrics, code: compiled.errors[0]?.code ?? "INTENT_COMPILER_VALIDATION_ERROR", repairUsed: Boolean(first.repairUsed), candidateCount: first.candidate.goals.length });
          // The model-cloud endpoint owns the one global bounded frame repair.
          // A second Cloud compile would restart the 28-second root budget and
          // could exceed the fixed four-call provider cap, so deterministic
          // expansion failures are terminal and fail closed here.
        }
        if (compiled.ok) intentIR = compiled.ir;
      } else if (first.status === "unavailable") {
        compilerErrors = [{ code: first.error, path: "gateway", message: "typed intent compiler is unavailable" }];
      }
    }
    if (!plan) {
      plan = intentIR
        ? draftPlan(input.instanceRef, instance.profile_revision, intent, {
          preferredTool: input.preferredTool, platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader, intentIR,
        })
        : semanticFallback ?? draftPlan(input.instanceRef, instance.profile_revision, intent, {
          preferredTool: input.preferredTool, platform: instance.platform, minecraftVersion: instance.minecraft_version, loader: instance.loader,
        });
    }
    if (compilerErrors.length && !intentIR) {
      plan.steps = [];
      plan.acceptance = [];
      plan.coverage = "waiting";
      plan.goal_requirements = plan.goal_requirements.map((goal) => ({ ...goal, execute_step_ids: [], verify_step_ids: [], status: "unsupported" }));
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: plan.task_id,
      tenant_id: input.tenantId,
      instance_ref: input.instanceRef,
      intent: plan.intent,
      risk: plan.confirmed_write_proposal ? plan.operation.risk : highestRisk(plan.steps),
      state: "DRAFTED",
      plan,
      goal_statuses: plan.goal_requirements.map((goal) => ({
        goal_id: goal.id,
        status: goal.status ?? "pending",
        summary: goal.status === "unsupported" ? "当前计划尚未覆盖此目标" : "等待真实工具证据",
      })),
      goal_results: [],
      created_at: now,
      updated_at: now,
      evidence: [],
      session_id: input.sessionId,
      parent_task_id: input.parentTaskId,
      chain_depth: chainDepth,
    };
    this.store.tasks.set(task.id, task);
    if (input.agentToolCall) this.agentToolCalls.set(task.id, { id: input.agentToolCall.toolCallId, call: input.agentToolCall });
    const compatibility = plan.coverage === "full" ? validatePlanCompatibility(plan) : undefined;
    if (compatibility && !compatibility.ok) {
      this.move(task, "REJECTED", `Plan compatibility rejected before dispatch (${compatibility.code}): ${compatibility.reason}`);
      task.evidence.push({ kind: "validation", summary: compatibility.reason, at: new Date(this.now()).toISOString(), result: "contradiction" });
    } else if (plan.coverage !== "full") {
      this.move(task, "WAITING", plan.coverage === "partial"
        ? "计划仅覆盖了部分必需目标；等待用户澄清或生成完整计划"
        : "当前请求尚未形成覆盖全部目标的安全计划");
    } else if (task.risk === "forbidden") {
      this.move(task, "REJECTED", "Policy rejected a forbidden capability");
    } else {
      this.move(task, "POLICY_CHECKED", "Tool registry and policy checks passed");
      if (!task.plan.operation.requires_confirmation) {
        this.move(task, "SNAPSHOTTING", task.risk === "read"
          ? "Read-only task requires no mutable snapshot"
          : "Create-only staged download requires no approval or mutable pre-snapshot");
        this.dispatch(task, instance.agent_id);
      } else {
        this.move(task, "WAITING_CONFIRMATION", "Explicit confirmation required");
      }
    }
    if (task.state === "WAITING") {
      const unsupported = task.plan.goal_requirements.filter((goal) => goal.status === "unsupported").map((goal) => goal.description);
      task.assistant_response = compactProposalError
        ? "需要先澄清后才能创建确认操作；目前没有执行任何操作。"
        : compilerErrors.length
        ? "我暂时没能理解这条请求，因此没有执行任何操作。请把要做的事说完整一些。"
        : unsupported.length
        ? `计划尚未覆盖全部目标，未执行。需要先明确或补全：${unsupported.join("；")}`
        : "当前请求尚未形成可安全执行的完整计划，因此没有执行。";
      task.model_status = "answered";
    } else if (compactProposalResponse) {
      task.assistant_response = compactProposalResponse.summary;
      task.model_request_id = compactProposalResponse.requestId;
      task.model_status = "answered";
    } else if (input.assistantResponse) {
      task.assistant_response = input.assistantResponse;
      task.model_request_id = input.modelRequestId;
      task.model_status = input.modelStatus ?? "answered";
    } else {
      const response = await this.modelGateway.answer(task, instance);
      task.assistant_response = response.answer;
      task.model_request_id = "requestId" in response ? response.requestId : undefined;
      task.model_status = response.status;
    }
    task.assistant_response = safeTaskAnswer(task.assistant_response, task.state, task.evidence.length > 0);
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

  agentLoopObservation(taskId: string, tenantId: string): AgentLoopObservation | undefined {
    const task = this.get(taskId, tenantId);
    const direct = task.plan.agent_execution;
    const bound = this.agentToolCalls.get(taskId) ?? (direct ? {
      id: direct.tool_call_id,
      call: { action: "tool_call" as const, tool: direct.tool as AgentLoopToolCall["tool"], arguments: direct.arguments, reason: "Restored persisted agent call" },
    } : undefined);
    if (!bound || !terminal(task.state)) return undefined;
    const evidence = task.evidence.filter((item) => !["state", "decision"].includes(item.kind));
    const summaries = evidence.map((item) => item.summary);
    const ids = evidence.map((item, index) => createHash("sha256")
      .update(`${task.id}:${index}:${item.kind}:${item.at}:${item.summary}`)
      .digest("hex"));
    const goalsComplete = task.goal_statuses.length > 0 && task.goal_statuses.every((goal) => goal.status === "satisfied")
      && task.goal_results.length > 0 && task.goal_results.every((result) => result.status === "satisfied");
    const directComplete = isAgentDirectTask(task) && directExecutionEvidenceComplete(task);
    const status: AgentLoopObservation["status"] = task.state === "SUCCEEDED" && (directComplete || goalsComplete) && evidence.length > 0
      ? "succeeded"
      : ["FAILED", "REJECTED", "ROLLED_BACK", "CANCELLED", "EXPIRED", "MANUAL_INTERVENTION"].includes(task.state)
        ? "failed"
        : "indeterminate";
    const errorCode = evidence.find((item) => item.code)?.code ?? `TASK_${task.state}`;
    const retryable = status !== "succeeded" && /(?:TIMEOUT|UNAVAILABLE|DISCONNECTED|HTTP_5\d\d|PROVIDER)/iu.test(errorCode);
    const sideEffect: AgentLoopObservation["side_effect"] = task.risk === "read" ? "none" : status === "succeeded" ? "applied" : "possible";
    const qa0144ReadResult = status === "succeeded" ? projectQa0144ReadResult({
      tool: bound.call.tool,
      arguments: bound.call.arguments,
      observedValues: evidence.map((item) => item.observed).filter((item) => item !== undefined),
    }) : undefined;
    return {
      tool_call_id: bound.id,
      tool: bound.call.tool,
      status,
      retryable,
      side_effect: sideEffect,
      data: {
        task_id: task.id,
        task_state: task.state,
        goal_results: task.goal_results.map((result) => ({
          result_kind: result.result_kind,
          status: result.status,
          observed: result.observed,
          capacity: result.capacity,
          summary: result.summary,
          judgement: result.judgement,
        })),
        ...(isAgentDirectTask(task) ? {
          observations: evidence.map((item) => ({
            kind: item.kind,
            step_id: item.step_id,
            tool: item.tool,
            code: item.code,
            observed: item.observed ?? (bound.call.tool === "plugin.resolve" ? parsePluginResolveResult(item.summary) : undefined),
            result: item.result,
            display_text: item.summary,
          })),
        } : {}),
        ...(qa0144ReadResult ? { qa0144_read_result: qa0144ReadResult } : {}),
      },
      ...(status === "succeeded" ? {} : {
        error: {
          code: errorCode,
          message: safeUserText(task.completion_response ?? task.assistant_response, "工具未能提供可确认的结果。"),
        },
      }),
      evidence: { ids, summaries },
    };
  }

  async complete(taskId: string, tenantId: string) {
    const task = this.get(taskId, tenantId);
    if (!terminal(task.state)) return undefined;
    if (task.completion_response) {
      return { answer: safeUserText(task.completion_response, "任务已结束，但目前无法用可靠证据确认结果。"), status: task.completion_status, continuation: task.completion_continuation };
    }
    const pending = this.completionPromises.get(taskId);
    if (pending) return pending;

    const completion = this.buildCompletion(task);
    this.completionPromises.set(taskId, completion);
    try {
      const result = await completion;
      result.answer = safeUserText(result.answer, "任务已结束，但目前无法用可靠证据确认结果。");
      task.completion_response = result.answer;
      return result;
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

  async bindAgentApproval(runId: string, taskId: string, callId: string) {
    if (!this.agentRuns) return;
    const task = this.store.tasks.get(taskId);
    if (!task || task.state !== "WAITING_CONFIRMATION" || task.plan.execution_mode !== "agent_direct" || !task.plan.agent_execution) return;
    const envelope = task.plan.agent_execution;
    const scopeHash = this.scopeHash(task);
    const approval: PendingAgentApprovalRecord = {
      approval_id: `approval_${randomUUID()}`,
      run_id: runId,
      task_id: task.id,
      call_id: callId,
      tool: envelope.tool,
      canonical_arguments: structuredClone(envelope.arguments),
      risk: task.risk,
      summary: task.assistant_response ?? `Approve ${envelope.tool}`,
      call_hash: sha256(JSON.stringify({ call_id: callId, tool: envelope.tool, arguments: envelope.arguments, operation_digest: envelope.operation_digest })),
      scope_hash: scopeHash,
      task_snapshot: structuredClone(task),
      status: "PENDING",
      created_at: new Date(this.now()).toISOString(),
    };
    await this.agentRuns.putApproval(approval);
  }

  async issueConfirmationForRequest(taskId: string, tenantId: string) {
    const task = this.get(taskId, tenantId);
    if (task.plan.execution_mode !== "agent_direct" || !this.agentRuns) return this.issueConfirmation(taskId, tenantId);
    if (task.state !== "WAITING_CONFIRMATION") throw new BadRequestException("Task is not awaiting confirmation");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + 5 * 60_000).toISOString();
    const scopeHash = this.scopeHash(task);
    try {
      await this.agentRuns.issueApprovalToken(taskId, tenantId, sha256(token), scopeHash, expiresAt);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Unable to issue approval");
    }
    task.confirmation_expires_at = expiresAt;
    return { token, expires_at: expiresAt, scope_hash: scopeHash };
  }

  async confirmForRequest(taskId: string, tenantId: string, token: string) {
    const task = this.get(taskId, tenantId);
    if (task.plan.execution_mode !== "agent_direct" || !this.agentRuns) return this.confirm(taskId, tenantId, token);
    const scopeHash = this.scopeHash(task);
    const callHash = sha256(JSON.stringify({
      call_id: task.plan.agent_execution!.tool_call_id,
      tool: task.plan.agent_execution!.tool,
      arguments: task.plan.agent_execution!.arguments,
      operation_digest: task.plan.agent_execution!.operation_digest,
    }));
    let approval: PendingAgentApprovalRecord;
    try {
      approval = await this.agentRuns.consumeApproval(taskId, tenantId, sha256(token), scopeHash, callHash, tenantId, this.now());
    } catch (error) {
      if (error instanceof Error && error.message === "AGENT_APPROVAL_EXPIRED" && task.state === "WAITING_CONFIRMATION") {
        const pending = await this.agentRuns.pendingApprovalForTask(taskId, tenantId);
        if (pending) await this.agentRuns.resolveApproval(pending.approval_id, "EXPIRED", tenantId);
        this.move(task, "EXPIRED", "Confirmation token expired");
      }
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid confirmation token");
    }
    task.plan.confirmed_operation = confirmedOperationProjection(task, scopeHash, new Date(this.now()).toISOString(), approval.expires_at!);
    initializeConfirmedOutcome(task);
    this.move(task, "SNAPSHOTTING", "User confirmed the exact persisted agent call");
    const instance = this.store.instances.get(task.instance_ref);
    if (!instance) throw new BadRequestException("Instance not found");
    this.dispatch(task, instance.agent_id);
    return task;
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
    task.plan.confirmed_operation = confirmedOperationProjection(task, confirmation.scopeHash, new Date(this.now()).toISOString(), confirmation.expiresAt);
    initializeConfirmedOutcome(task);
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
    if (terminal(task.state)) return;
    if (state === "REJECTED") {
      const summary = String(payload.summary ?? "Agent rejected the plan during validation");
      task.evidence.push({ ...normalizeAgentEvidence(task, payload, "validation", summary), result: "contradiction" });
      this.move(task, "REJECTED", summary);
      updateAuthoritativeGoalStatuses(task, true, summary);
      return;
    }
    if (state === "SUCCEEDED" && transitions[task.state]?.some((candidate) => ["SUCCEEDED", "PARTIAL", "FAILED"].includes(candidate))) {
      const summary = String(payload.summary ?? state);
      const kind = terminalEvidenceKind(task, payload);
      if (kind !== "state") task.evidence.push(normalizeAgentEvidence(task, payload, kind, summary));
      if (isMinimalConfirmedOutcome(task)) {
        if (!hasConfirmedExecutionEvidence(task)) {
          projectConfirmedOutcome(task, "failed", "没有收到与已确认步骤完全匹配的成功工具回调");
          this.move(task, "FAILED", "没有收到与已确认步骤完全匹配的成功工具回调，无法确认操作已执行");
          return;
        }
        if (confirmedLifecycleExpectation(task)) {
          projectConfirmedOutcome(task, "pending", "执行回调已收到，正在等待实例状态复核");
          if (task.state !== "VERIFYING") this.move(task, "VERIFYING", "执行请求已被接受，正在等待同一实例的状态复核");
          return;
        }
        projectConfirmedOutcome(task, "satisfied", "真实工具回调已确认执行；当前操作没有可靠的独立复核通道", confirmedExecutionEvidence(task)?.observed);
        this.move(task, "SUCCEEDED", "操作已执行，但未独立验证效果");
        return;
      }
      if (isAgentDirectTask(task)) {
        if (!directExecutionEvidenceComplete(task)) {
          this.move(task, "FAILED", "工具结束事件缺少与当前调用绑定的真实回调");
          return;
        }
        this.move(task, "SUCCEEDED", summary);
        return;
      }
      const goals = updateGoalStatuses(task);
      const next: TaskState = goals.everySatisfied ? "SUCCEEDED" : goals.someSatisfied ? "PARTIAL" : "FAILED";
      this.move(task, next, next === "SUCCEEDED"
        ? summary
        : next === "PARTIAL"
          ? "Agent 已结束，但仅有部分必需目标具备真实证据"
          : "Agent 已结束，但必需目标缺少真实执行与复验证据");
      return;
    }
    if (state && transitions[task.state]?.includes(state)) {
      const summary = String(payload.summary ?? state);
      this.move(task, state, summary);
      const kind = String(payload.kind ?? "state");
      if (kind !== "state") {
        task.evidence.push(normalizeAgentEvidence(task, payload, kind, summary));
      }
      if (state === "FAILED") {
        updateAuthoritativeGoalStatuses(task, true, summary);
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
    else if (payload.summary) {
      const kind = String(payload.kind ?? "agent");
      const evidence = normalizeAgentEvidence(task, payload, kind, String(payload.summary));
      task.evidence.push(evidence);
      if (kind === "console" && (evidence.result === "contradiction"
        || ["rejected", "indeterminate"].includes(evidence.command_outcome?.status ?? ""))) {
        const summary = commandOutcomeUserMessage(task, evidence.command_outcome);
        updateAuthoritativeGoalStatuses(task, true, summary);
        if (transitions[task.state]?.includes("FAILED")) this.move(task, "FAILED", summary);
        return;
      }
      updateAuthoritativeGoalStatuses(task);
      this.armDeadline(task);
    }
  }

  recordInventoryProfiles(profiles: Array<Pick<ServerProfile, "instance_id" | "state" | "profile_revision">>) {
    for (const profile of profiles) {
      for (const task of this.store.tasks.values()) {
        if (task.state !== "VERIFYING" || task.instance_ref !== profile.instance_id || !isMinimalConfirmedOutcome(task)) continue;
        const expectation = confirmedLifecycleExpectation(task);
        const confirmed = task.plan.confirmed_operation;
        if (!confirmed || !expectation || profile.state !== expectation.expected) continue;
        if (task.evidence.some((item) => item.kind === "verification.instance_state" && item.step_id === expectation.step.id && item.result === "match")) continue;
        task.evidence.push({
          kind: "verification.instance_state", summary: `实例状态已复核为 ${profile.state}`, at: new Date(this.now()).toISOString(),
          step_id: expectation.step.id, tool: expectation.step.tool, target: expectation.step.target,
          parameters: expectation.step.parameters, operation_digest: confirmed.operation_digest,
          confirmation_digest: confirmed.summary_digest,
          expected: expectation.expected, observed: profile.state, result: "match",
        });
        projectConfirmedOutcome(task, "satisfied", `执行完成，并已独立复核实例状态为 ${profile.state}`, profile.state);
        this.move(task, "SUCCEEDED", `执行完成，并已独立复核实例状态为 ${profile.state}`);
      }
    }
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
    } else {
      this.armDeadline(task);
    }
  }

  sweepExpiredTasks(now = this.now()) {
    for (const [taskId, deadline] of this.deadlines) {
      if (deadline > now) continue;
      const task = this.store.tasks.get(taskId);
      this.deadlines.delete(taskId);
      if (!task || terminal(task.state)) continue;
      const stage = task.state;
      const at = new Date(now).toISOString();
      task.evidence.push({ kind: "timeout", summary: `Task exceeded the configured ${stage} deadline without task-specific progress`, at, result: "insufficient" });
      const acceptedLifecycle = task.state === "VERIFYING" && isMinimalConfirmedOutcome(task) && Boolean(confirmedLifecycleExpectation(task)) && hasConfirmedExecutionEvidence(task);
      if (acceptedLifecycle) {
        projectConfirmedOutcome(task, "failed", "请求已接受但未能确认最终状态");
        if (transitions[task.state].includes("FAILED")) this.move(task, "FAILED", "请求已接受但未能确认最终状态");
      } else {
        if (transitions[task.state].includes("FAILED")) this.move(task, "FAILED", `Task watchdog timed out in ${stage}`);
        updateAuthoritativeGoalStatuses(task, true);
      }
    }
  }

  private async buildCompletion(task: TaskRecord) {
    const instance = this.store.instances.get(task.instance_ref);
    const fallback = completionFallback(task);
    const evidence = completionEvidence(task);
    if (task.state !== "SUCCEEDED") {
      const failedConsoleOutcome = [...task.evidence].reverse().find((item) => item.command_outcome
        && ["rejected", "indeterminate"].includes(item.command_outcome.status))?.command_outcome;
      if (failedConsoleOutcome) {
        task.completion_response = commandOutcomeUserMessage(task, failedConsoleOutcome);
        task.completion_status = "unavailable";
        task.completion_continuation = undefined;
        task.updated_at = new Date().toISOString();
        return { answer: task.completion_response, status: task.completion_status };
      }
      if (isMinimalConfirmedOutcome(task)) {
        task.completion_response = confirmedFailureUserMessage(task);
        task.completion_status = "unavailable";
        task.completion_continuation = undefined;
        task.updated_at = new Date().toISOString();
        return { answer: task.completion_response, status: task.completion_status };
      }
      const continuation = evidence.missingExecution.length === 0 ? verificationContinuation(task) : undefined;
      task.completion_response = evidence.missing.length > 0
        ? continuation
          ? `任务未完成，缺少${evidence.missing.join("、")}，正在通过只读工具重新复验；目前无法确认操作已经完成。`
          : `${fallback}\n\n证据门禁：缺少${evidence.missing.join("、")}，因此无法确认操作已经完成。`
        : fallback;
      task.completion_status = "unavailable";
      task.completion_continuation = continuation;
      task.updated_at = new Date().toISOString();
      return { answer: task.completion_response, status: task.completion_status, continuation };
    }
    if (!evidence.sufficient) {
      const continuation = evidence.missingExecution.length === 0 ? verificationContinuation(task) : undefined;
      task.completion_response = continuation
        ? `任务已结束，但缺少${evidence.missing.join("、")}，正在通过只读工具重新复验；目前无法确认操作已经完成。`
        : `任务已结束，但缺少${evidence.missing.join("、")}，因此无法确认操作已经完成。`;
      task.completion_status = "unavailable";
      task.completion_continuation = continuation;
      task.updated_at = new Date().toISOString();
      return { answer: task.completion_response, status: task.completion_status, continuation };
    }
    if (!instance) {
      task.completion_response = fallback;
      task.completion_status = "unavailable";
      return { answer: fallback, status: task.completion_status };
    }
    const requiredReadGoals = task.plan.goal_requirements.filter((goal) => goal.required);
    const typedReadAnswer = (requiredReadGoals.length > 1 || requiredReadGoals.some((goal) => ["plugin", "gamerule", "world"].includes(goal.domain)))
      ? renderTypedReadCompletion({
      intent: task.intent,
      state: task.state,
      action: task.plan.operation.action,
      goals: task.plan.goal_requirements.map((goal) => ({
        id: goal.id,
        domain: goal.domain,
        target: goal.target,
          resultKind: goal.result_kind,
          filter: goal.filter,
          required: goal.required,
          semanticKey: goal.source_goal_ids.length === 1
            ? task.plan.source_goals.find((source) => source.id === goal.source_goal_ids[0])?.normalized
            : undefined,
      })),
      results: task.goal_results.map((result) => ({
        goalId: result.goal_id,
        status: result.status,
        observed: result.observed,
        capacity: result.capacity,
      })),
    })
      : undefined;
    if (typedReadAnswer) {
      task.completion_response = typedReadAnswer;
      task.completion_status = "answered";
      task.updated_at = new Date().toISOString();
      return { answer: typedReadAnswer, status: task.completion_status };
    }
    const hasAuditedRuntimeIdentity = task.plan.goal_requirements.some((goal) => goal.domain === "server" && goal.target === "version")
      && task.goal_results.some((result) => result.status === "satisfied" && result.observed && typeof result.observed === "object"
        && "platform" in result.observed && "minecraft_version" in result.observed);
    if (hasAuditedRuntimeIdentity
      || task.plan.source_goals.length > 1
      || task.plan.response_policy.cover_all_required_goals
      || task.plan.response_policy.require_synthesis) {
      task.completion_response = fallback;
      task.completion_status = "answered";
      task.updated_at = new Date().toISOString();
      return { answer: fallback, status: task.completion_status };
    }
    const response = await this.modelGateway.answer(task, instance);
    const modelAnswer = response.answer.trim();
    const safeModelAnswer = response.status === "answered"
      && modelAnswer
      && (task.state === "SUCCEEDED" || !claimsSuccess(modelAnswer));
    task.completion_response = safeModelAnswer ? modelAnswer : fallback;
    task.completion_status = response.status;
    task.completion_continuation = response.continuation && safeRecoveryContinuation(task, response.continuation.toolIntent!.trim(), response.continuation.preferredTool, instance) ? {
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
    task.updated_at = new Date(this.now()).toISOString();
    task.evidence.push({ kind: "state", summary, at: task.updated_at });
    if (terminal(next)) this.deadlines.delete(task.id);
    else if (["SNAPSHOTTING", "EXECUTING", "VERIFYING"].includes(next)) this.armDeadline(task);
    return task;
  }

  private now() { return this.runtimePolicy.now?.() ?? Date.now(); }
  private armDeadline(task: TaskRecord) {
    if (!["SNAPSHOTTING", "EXECUTING", "VERIFYING"].includes(task.state)) return;
    const configured = this.runtimePolicy.stageTimeoutMs?.[task.state as "SNAPSHOTTING" | "EXECUTING" | "VERIFYING"];
    const fallback = Number(process.env[`MCAI_TASK_${task.state}_TIMEOUT_MS`] ?? (task.state === "SNAPSHOTTING" ? 60_000 : task.state === "EXECUTING" ? 15 * 60_000 : 5 * 60_000));
    this.deadlines.set(task.id, this.now() + Math.max(1, configured ?? fallback));
  }

  private scopeHash(task: TaskRecord) {
    return sha256(JSON.stringify({ tenant: task.tenant_id, instance: task.instance_ref, plan: task.plan }));
  }
}

function explicitTopLevelOrBranchCount(intent: string) {
  const marked = intent.replace(/\beither\s+/giu, "");
  const parts = marked.split(/\s*(?:[,，;；]\s*)?(?:alternatively\b|or\b|或者|或是|要么|或)(?=\s|[\u3400-\u9fff])\s*/giu)
    .map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return 1;
  const substantial = (part: string) => (part.match(/[A-Za-z0-9_]+/gu)?.length ?? 0) >= 2 || (part.match(/[\u3400-\u9fff]/gu)?.length ?? 0) >= 4;
  const localEnumeration = /[,，][^,，;；]{0,40}(?:or\b|或者|或是|或)(?=\s|[\u3400-\u9fff])/iu.test(marked);
  const localAlternative = /\b(?:(?:player|client)\s+(?:connection|login)|authentication)[^,;，；]{0,48}\bor\b/iu.test(marked)
    || /(?:玩家|客户端)(?:连接|登录)[^,;，；]{0,20}(?:或者|或是|或)/u.test(marked);
  return parts.every(substantial) && !localEnumeration && !localAlternative ? parts.length : 1;
}

function confirmedOperationProjection(task: TaskRecord, scopeDigest: string, confirmedAt: string, expiresAt: string): NonNullable<TaskRecord["plan"]["confirmed_operation"]> {
  const steps = task.plan.steps.map((step, order) => ({
    id: step.id,
    tool: step.tool,
    target: policyTarget(step),
    parameters: step.args,
    order,
    purpose: step.purpose === "verify" ? "verify" as const : "execute" as const,
    risk: step.risk,
    requires_confirmation: Boolean(step.requires_confirmation),
  }));
  const summary = {
    schema_version: "confirmed-operation/v1" as const,
    instance_ref: task.instance_ref,
    operation_digest: task.plan.operation.digest ?? "",
    risk: task.plan.operation.risk,
    requires_confirmation: true as const,
    steps,
    scope_digest: scopeDigest,
  };
  return {
    ...summary,
    summary_digest: sha256(JSON.stringify(canonicalizeConfirmation(summary))),
    confirmed_at: confirmedAt,
    expires_at: expiresAt,
  };
}

function canonicalizeConfirmation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeConfirmation);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeConfirmation(item)]));
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function terminal(state: TaskState) {
  return ["SUCCEEDED", "PARTIAL", "WAITING", "FAILED", "ROLLED_BACK", "REJECTED", "CANCELLED", "EXPIRED", "MANUAL_INTERVENTION"].includes(state);
}

function completionFallback(task: TaskRecord) {
  if (task.state === "SUCCEEDED" && isMinimalConfirmedOutcome(task)) {
    const expectation = confirmedLifecycleExpectation(task);
    if (expectation) return `操作已执行，并已独立确认实例状态为 ${expectation.expected}。`;
    return "操作已执行；当前工具没有可靠的独立读取通道，因此未独立验证效果。";
  }
  const runtimeIdentity = task.goal_results.find((result) => result.status === "satisfied"
    && result.observed && typeof result.observed === "object"
    && "platform" in result.observed && "minecraft_version" in result.observed);
  if (task.state === "SUCCEEDED" && runtimeIdentity) return runtimeIdentity.summary;
  if (task.plan.source_goals.length > 1 || task.goal_results.length > 1) {
    const goals = sourceGoalCompletion(task);
    const failure = task.state === "SUCCEEDED" ? undefined : terminalFailureSummary(task);
    return failure ? `${goals}\n\n失败原因：${failure}` : goals;
  }
  const latest = (kind: string) => [...task.evidence].reverse().find((item) => item.kind === kind)?.summary;
  if (task.state === "SUCCEEDED") {
    return latest("verification.console") || latest("verification.files") || latest("verification.logs")
      || latest("verification.config") || latest("console") || latest("files") || latest("logs")
      || latest("config") || latest("instance") || "任务已结束，但没有足够的工具证据，无法确认完成。";
  }
  if (task.state === "PARTIAL") {
    const satisfied = task.goal_statuses.filter((goal) => goal.status === "satisfied").length;
    return `任务只完成了 ${satisfied}/${task.goal_statuses.length} 个必需目标；缺少的目标没有足够证据，不能宣称全部完成。`;
  }
  if (task.state === "WAITING") return task.assistant_response ?? "任务正在等待完整、安全且覆盖全部目标的计划，尚未执行。";
  const failedConsoleOutcome = [...task.evidence].reverse().find((item) => item.command_outcome
    && ["rejected", "indeterminate"].includes(item.command_outcome.status))?.command_outcome;
  if (failedConsoleOutcome) return commandOutcomeUserMessage(task, failedConsoleOutcome);
  const diagnosis = latest("diagnosis") || latest("state") || "任务未能完成。";
  const next = latest("decision");
  return next ? `${diagnosis}\n\n下一步：${next}` : diagnosis;
}

function confirmedFailureUserMessage(task: TaskRecord) {
  const text = task.evidence.slice(-5).map((item) => String(item.summary ?? "")).join("\n");
  if (/(?:没有返回可判断|无法确认.*生效|indeterminate|no (?:readable|complete) (?:result|output))/i.test(text)) {
    return "服务器没有返回可判断的命令结果，因此无法确认这次操作是否生效。";
  }
  if (/(?:没有找到|no (?:player|target|entity))/i.test(text)) {
    return "没有找到符合条件的目标，因此没有对象收到或应用这次操作。";
  }
  return "操作未能完成；服务器返回的结果不足以确认是否生效。";
}

function terminalFailureSummary(task: TaskRecord) {
  const reversed = [...task.evidence].reverse();
  return reversed.find((item) => !["state", "decision"].includes(item.kind))?.summary
    ?? reversed.find((item) => item.kind === "state")?.summary;
}

function requiresSemanticCompletion(plan: TaskPlan) {
  if (!["read", "diagnose"].includes(plan.operation.action)) return false;
  if (plan.coverage !== "full") return true;
  if (plan.goal_requirements.some((goal) => goal.required
    && goal.execute_step_ids.length === 0
    && !(goal.depends_on_goal_ids?.length))) return true;
  return plan.clause_ledger.some((clause) => clause.role === "domain_goal"
    && clause.polarity === "positive"
    && clause.status === "mapped"
    && (clause.source_atom_ids.length === 0 || clause.source_goal_ids.length === 0));
}

function completionEvidence(task: TaskRecord) {
  if (isMinimalConfirmedOutcome(task)) {
    const executionMatched = hasConfirmedExecutionEvidence(task);
    const expectation = confirmedLifecycleExpectation(task);
    const verificationMatched = !expectation || task.evidence.some((item) => item.kind === "verification.instance_state"
      && item.step_id === expectation.step.id && item.expected === expectation.expected && item.observed === expectation.expected && item.result === "match");
    const missingExecution = executionMatched ? [] : ["与确认内容完全匹配的执行回调"];
    const missingVerification = verificationMatched ? [] : ["同一实例的最终状态复核"];
    const missing = [...missingExecution, ...missingVerification];
    return { sufficient: task.state === "SUCCEEDED" && missing.length === 0, missing, missingExecution, missingVerification, contradictions: [] };
  }
  const operation = task.plan.operation;
  const execution = operation?.execution_evidence ?? legacyExecutionRequirements(task);
  const verification = operation?.verification_evidence ?? [{ kind: "verification" }];
  const executionResults = execution.map((requirement) => ({ requirement, result: evaluateRequirement(task, requirement) }));
  const verificationResults = verification.map((requirement) => ({ requirement, result: evaluateRequirement(task, requirement) }));
  const missingExecution = [...new Set(executionResults
    .filter((item) => item.result !== "match")
    .map(() => "真实执行结果"))];
  const contradictions = [...new Set(verificationResults
    .filter((item) => item.result === "contradiction")
    .map(() => "结果复核与预期矛盾"))];
  const missingVerification = [...new Set(verificationResults
    .filter((item) => item.result !== "match")
    .map((item) => item.result === "contradiction" ? "结果复核与预期矛盾" : "结果复核"))];
  const missing = [...missingExecution, ...missingVerification];
  return { sufficient: task.state === "SUCCEEDED" && missing.length === 0 && contradictions.length === 0, missing, missingExecution, missingVerification, contradictions };
}

function updateGoalStatuses(task: TaskRecord, failed = false) {
  const aggregates = new Map<string, ReturnType<typeof adaptGoalResult>>();
  const preliminary = task.plan.goal_requirements.map((goal) => {
    if (goal.status === "unsupported" || goal.execute_step_ids.length === 0) {
      return { goal_id: goal.id, status: "unsupported" as const, summary: "当前计划未覆盖此必需目标" };
    }
    if (goal.result_kind === "judgement") return { goal_id: goal.id, status: "pending" as const, summary: "等待全部事实依赖" };
    const results = goal.evidence.map((requirement) => evaluateRequirement(task, requirement));
    const contradiction = results.includes("contradiction");
    const aggregate = aggregateGoalResult(task, goal);
    aggregates.set(goal.id, aggregate);
    const matched = results.length > 0 && results.every((result) => result === "match") && aggregate.available;
    return {
      goal_id: goal.id,
      status: contradiction || failed ? "failed" as const : matched ? "satisfied" as const : "pending" as const,
      summary: contradiction ? "复验证据与目标矛盾" : matched ? "真实执行与复验证据已满足" : failed ? "工具失败，目标未完成" : "仍缺少目标绑定证据",
    };
  });
  task.goal_statuses = preliminary.map((status) => {
    const goal = task.plan.goal_requirements.find((candidate) => candidate.id === status.goal_id)!;
    if (goal.result_kind !== "judgement") return status;
    const dependencies = goal.depends_on_goal_ids ?? [];
    const ready = dependencies.length > 0 && dependencies.every((id) => preliminary.find((candidate) => candidate.goal_id === id)?.status === "satisfied");
    if (ready && goal.domain === "performance" && goal.target === "resource-pressure") {
      const computed = aggregateGoalResult(task, goal);
      aggregates.set(goal.id, computed);
      return { goal_id: goal.id, status: failed || !computed.available ? "failed" as const : "satisfied" as const,
        summary: computed.available ? computed.summary : "缺少足够的真实数据，暂时无法判断资源压力" };
    }
    if (ready && goal.domain === "diagnosis" && goal.target === "recent-logs") {
      const count = dependencies.map((id) => aggregates.get(id)?.observed).find((value) => typeof value === "number");
      const available = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
      aggregates.set(goal.id, {
        available, observed: available ? count > 0 : undefined, diagnostics: [],
        reason: available ? undefined : "invalid_operands",
        summary: available ? (count > 0 ? "发现需要关注的相关事件" : "未发现相应异常迹象") : "缺少可核对的匹配数量",
      });
      return { goal_id: goal.id, status: failed || !available ? "failed" as const : "satisfied" as const,
        summary: available ? (count > 0 ? "发现需要关注的相关事件" : "未发现相应异常迹象") : "缺少可核对的匹配数量" };
    }
    if (ready && goal.predicate) {
      const evaluation = evaluateGoalPredicate(goal.predicate, new Map(dependencies.map((id) => [id, aggregates.get(id)?.observed])));
      aggregates.set(goal.id, {
        available: evaluation.available, observed: evaluation.observed, diagnostics: [],
        reason: evaluation.available ? undefined : "invalid_operands",
        summary: evaluation.available ? judgementSummary(goal, evaluation.observed) : `${goal.description}：缺少足够的真实数据，暂时无法判断`,
      });
      return { goal_id: goal.id, status: failed || !evaluation.available ? "failed" as const : "satisfied" as const,
        summary: evaluation.available ? judgementSummary(goal, evaluation.observed) : "缺少足够的真实数据，暂时无法判断" };
    }
    return { goal_id: goal.id, status: failed ? "failed" as const : "pending" as const,
      summary: ready ? "全部事实依赖均有真实回调" : "派生结论缺少必要事实" };
  });
  task.goal_results = task.plan.goal_requirements.map((goal) => {
    const status = task.goal_statuses.find((candidate) => candidate.goal_id === goal.id)!;
    if (goal.result_kind === "judgement" && !goal.predicate && !(goal.domain === "performance" && goal.target === "resource-pressure") && !(goal.domain === "diagnosis" && goal.target === "recent-logs")) return {
      goal_id: goal.id, source_goal_ids: goal.source_goal_ids, result_kind: goal.result_kind,
      status: status.status, observed: undefined, summary: `${goal.description}: no auditable predicate is available`, diagnostics: [],
    };
    const computed = aggregates.get(goal.id) ?? aggregateGoalResult(task, goal);
    return {
      goal_id: goal.id, source_goal_ids: goal.source_goal_ids, result_kind: goal.result_kind,
      status: status.status, observed: computed.observed, summary: computed.summary, diagnostics: computed.diagnostics,
      ...(computed.capacity !== undefined ? { capacity: computed.capacity } : {}),
      ...(goal.predicate ? { judgement: { predicate: goal.predicate, operands: (goal.depends_on_goal_ids ?? []).map((id) => aggregates.get(id)?.observed), result: typeof computed.observed === "boolean" ? computed.observed : undefined, reason: computed.reason } } : {}),
    };
  });
  const required = task.goal_statuses;
  return {
    everySatisfied: required.length > 0 && required.every((goal) => goal.status === "satisfied"),
    someSatisfied: required.some((goal) => goal.status === "satisfied"),
  };
}

function judgementSummary(goal: TaskRecord["plan"]["goal_requirements"][number], observed: unknown) {
  if (goal.domain === "diagnosis" && goal.target === "recent-logs" && typeof observed === "boolean") {
    return observed ? "综合判断：发现相应异常迹象" : "综合判断：未发现相应异常迹象";
  }
  return `${goal.description}：${String(observed)}`;
}

function updateAuthoritativeGoalStatuses(task: TaskRecord, failed = false, summary?: string) {
  if (isMinimalConfirmedOutcome(task)) {
    projectConfirmedOutcome(task, failed ? "failed" : "pending", summary ?? (failed ? "工具失败，目标未完成" : "等待真实执行与复核证据"));
    return {
      everySatisfied: task.goal_statuses.length > 0 && task.goal_statuses.every((goal) => goal.status === "satisfied"),
      someSatisfied: task.goal_statuses.some((goal) => goal.status === "satisfied"),
    };
  }
  return updateGoalStatuses(task, failed);
}

function confirmedExecuteStep(task: TaskRecord) {
  const confirmed = task.plan.confirmed_operation;
  if (!confirmed) return undefined;
  const steps = confirmed.steps.filter((step) => step.purpose === "execute");
  return steps.length === 1 ? steps[0] : undefined;
}

function confirmedGoalId(task: TaskRecord) {
  return `confirmed:${confirmedExecuteStep(task)?.id ?? "operation"}`;
}

function initializeConfirmedOutcome(task: TaskRecord) {
  if (task.plan.goal_requirements.length > 0 || !confirmedExecuteStep(task)) return;
  projectConfirmedOutcome(task, "pending", "等待与确认内容完全匹配的真实工具回调");
}

function isMinimalConfirmedOutcome(task: TaskRecord) {
  return Boolean(task.plan.confirmed_operation)
    && task.plan.goal_requirements.length === 0
    && task.goal_statuses.length === 1
    && task.goal_statuses[0].goal_id === confirmedGoalId(task);
}

function projectConfirmedOutcome(task: TaskRecord, status: "pending" | "satisfied" | "failed", summary: string, observed?: unknown) {
  const step = confirmedExecuteStep(task);
  if (!step) return;
  const goalId = confirmedGoalId(task);
  const existing = task.goal_statuses.find((goal) => goal.goal_id === goalId);
  if (existing?.status === "satisfied" && status !== "satisfied") return;
  task.goal_statuses = [{ goal_id: goalId, status, summary }];
  task.goal_results = [{
    goal_id: goalId, source_goal_ids: [], result_kind: "fact", status, observed,
    summary, diagnostics: [],
  }];
}

function confirmedLifecycleExpectation(task: TaskRecord) {
  const step = confirmedExecuteStep(task);
  if (!step) return undefined;
  const expected = step.tool === "instance.start" || step.tool === "instance.restart"
    ? "running" as const
    : step.tool === "instance.stop"
      ? "stopped" as const
      : undefined;
  return expected ? { step, expected } : undefined;
}

function confirmedExecutionEvidence(task: TaskRecord) {
  const confirmed = task.plan.confirmed_operation;
  const step = confirmedExecuteStep(task);
  if (!confirmed || !step) return undefined;
  return task.evidence.find((item) => item.kind === evidenceKindForTool(step.tool)
    && item.step_id === step.id
    && item.tool === step.tool
    && item.target === step.target
    && stableEqual(item.parameters, step.parameters)
    && item.operation_digest === confirmed.operation_digest
    && item.confirmation_digest === confirmed.summary_digest
    && item.result === "match");
}

function hasConfirmedExecutionEvidence(task: TaskRecord) {
  return Boolean(confirmedExecutionEvidence(task));
}

function stableEqual(left: unknown, right: unknown) {
  return JSON.stringify(canonicalizeConfirmation(left)) === JSON.stringify(canonicalizeConfirmation(right));
}

function aggregateGoalResult(task: TaskRecord, goal: TaskRecord["plan"]["goal_requirements"][number]) {
  const stepIds = new Set([...goal.execute_step_ids, ...goal.verify_step_ids]);
  const kinds = new Set(goal.evidence.map((item) => item.kind));
  const candidates = task.evidence.filter((item) => kinds.has(item.kind) && (!item.step_id || stepIds.has(item.step_id)));
  const logStep = goal.domain === "diagnosis"
    ? task.plan.steps.find((step) => step.tool === "logs.query" && stepIds.has(step.id))
    : undefined;
  const filterQuery = logStep?.args.filter_query as { digest?: unknown } | undefined;
  return adaptGoalResult(goal, candidates, { expectedLogQueryDigest: typeof filterQuery?.digest === "string" ? filterQuery.digest : undefined });
}

function sourceGoalCompletion(task: TaskRecord) {
  const bySource = new Map(task.goal_results.flatMap((result) => result.source_goal_ids.map((sourceId) => [sourceId, result] as const)));
  return task.plan.source_goals.map((source, index) => {
    const result = bySource.get(source.id);
    if (!result || result.status !== "satisfied") return `${index + 1}. ${source.source_text}：未完成（缺少对应真实证据）`;
    return `${index + 1}. ${result.summary}`;
  }).join("\n");
}

function verificationContinuation(task: TaskRecord): TaskRecord["completion_continuation"] {
  const step = task.plan.steps.find((item) => item.purpose === "verify" && item.risk === "read");
  if (!step) return undefined;
  const intent = step.tool === "console.command"
    ? `在当前实例控制台执行 ${String(step.args.command ?? "")}，仅用于复验上一操作结果`
    : step.tool === "files.list"
      ? `列出当前实例 ${String(step.args.path ?? "/")} 目录，仅用于复验上一操作结果`
      : step.tool === "config.inspect"
        ? `读取当前实例 ${String(step.args.path ?? "")}，仅用于复验上一操作结果`
        : step.tool === "logs.query"
          ? "只读检查当前实例最近日志，复验上一操作是否产生了真实结果"
          : "";
  if (!intent) return undefined;
  return {
    intent,
    preferred_tool: step.tool,
    answer: "执行回调已经收到，但独立复验证据不足；正在重新执行一次只读复验。",
  };
}

function legacyExecutionRequirements(task: TaskRecord) {
  const kinds = new Set<string>();
  for (const step of task.plan.steps.filter((item) => item.purpose !== "verify")) {
    const kind = evidenceKindForTool(step.tool);
    if (kind) kinds.add(kind);
  }
  return [...kinds].map((kind) => ({ kind }));
}

function evidenceKindForTool(tool: string) {
  if (tool === "console.command") return "console";
  if (tool === "files.list") return "files";
  if (tool === "logs.query") return "logs";
  if (tool.startsWith("config.")) return "config";
  if (tool === "plugin.install") return "files";
  if (tool.startsWith("plugin.")) return "plugin";
  if (tool === "web.search") return "web_search";
  if (tool === "file.download") return "download";
  if (tool === "instance.metrics") return "metrics";
  if (tool === "players.inspect") return "players";
  if (tool.startsWith("instance.")) return "instance";
  if (tool.startsWith("server.")) return "download";
  return undefined;
}

function evaluateRequirement(task: TaskRecord, requirement: TaskRecord["plan"]["operation"]["execution_evidence"][number]) {
  const candidates = task.evidence.filter((item) => item.kind === requirement.kind
    && (!item.step_id || !requirement.step_id || item.step_id === requirement.step_id));
  let sawContradiction = false;
  for (const evidence of candidates) {
    const result = deterministicEvidenceResult(requirement.expected, evidence.observed, evidence.summary, evidence.result);
    if (result === "contradiction") sawContradiction = true;
    if (result === "match") {
      const normalized = evidence.summary.toLowerCase();
      if ((requirement.contains ?? []).every((token) => normalized.includes(token.toLowerCase()))) return "match" as const;
    }
  }
  return sawContradiction ? "contradiction" as const : "missing" as const;
}

function isAgentDirectTask(task: TaskRecord) {
  return task.plan.execution_mode === "agent_direct" && task.plan.agent_execution?.schema_version === "agent-tool-execution/v1";
}

function directExecutionEvidenceComplete(task: TaskRecord) {
  if (!isAgentDirectTask(task)) return false;
  const step = task.plan.steps[0];
  const envelope = task.plan.agent_execution!;
  const requirements = task.plan.operation.execution_evidence;
  if (!step || requirements.length === 0) return false;
  const producerVerification = intrinsicToolPolicy(envelope.tool, envelope.arguments).producer_verified
    ? task.plan.operation.verification_evidence.filter((requirement) => requirement.kind.startsWith("verification."))
    : [];
  return requirements.every((requirement) => evaluateRequirement(task, requirement) === "match")
    && producerVerification.every((requirement) => evaluateRequirement(task, requirement) === "match")
    && producerVerifiedEvidenceAgrees(task, step.id, envelope.tool)
    && task.evidence.some((item) => item.result === "match"
      && item.step_id === step.id
      && item.tool === envelope.tool
      && (!item.parameters || JSON.stringify(canonicalizeConfirmation(item.parameters)) === JSON.stringify(canonicalizeConfirmation(envelope.arguments))));
}

function producerVerifiedEvidenceAgrees(task: TaskRecord, stepId: string, tool: string) {
  if (tool !== "file.download") return true;
  const matching = (kind: string) => task.evidence.filter((item) => item.kind === kind
    && item.step_id === stepId && item.tool === tool && item.result === "match");
  const created = matching("download");
  const verified = matching("verification.download");
  return created.length === 1 && verified.length === 1
    && JSON.stringify(canonicalizeConfirmation(created[0]!.observed))
      === JSON.stringify(canonicalizeConfirmation(verified[0]!.observed));
}

function terminalEvidenceKind(task: TaskRecord, payload: Record<string, unknown>) {
  const reported = String(payload.kind ?? "state");
  // The executor's successful terminal event is the bounded completion proof
  // for a read-only observation. Bind it to the plan's explicit terminal
  // requirement; the actual observed value still comes only from the typed
  // tool callback (for example the console `list` result).
  if (reported === "execution"
    && payload.state === "SUCCEEDED"
    && ["read", "diagnose"].includes(task.plan.operation.action)
    && task.plan.operation.verification_evidence.some((requirement) => requirement.kind === "verification" && requirement.step_id === "terminal")) {
    return "verification";
  }
  return reported;
}

function normalizeAgentEvidence(task: TaskRecord, payload: Record<string, unknown>, kind: string, summary: string): TaskRecord["evidence"][number] {
  const requirements = [...task.plan.operation.execution_evidence, ...task.plan.operation.verification_evidence]
    .filter((requirement) => requirement.kind === kind);
  const occurrence = task.evidence.filter((item) => item.kind === kind).length;
  const requirement = requirements[Math.min(occurrence, Math.max(requirements.length - 1, 0))];
  const suppliedResult = ["match", "contradiction", "insufficient"].includes(String(payload.result))
    ? String(payload.result) as "match" | "contradiction" | "insufficient"
    : undefined;
  const expected = payload.expected ?? requirement?.expected;
  const rawObserved = payload.observed ?? (kind === "web_search"
    ? parseWebSearchEvidence(summary, String(requirement?.parameters?.query ?? ""))
    : undefined);
  const downloadObservation = kind === "download" || kind === "verification.download"
    ? validatedFileDownloadObservation(requirement, rawObserved)
    : undefined;
  const observed = kind === "download" || kind === "verification.download" ? downloadObservation : rawObserved;
  const commandOutcome = kind === "console" ? validatedConsoleCommandOutcome(
    payload.command_outcome,
    summary,
    task.plan.operation.action === "write",
    String(confirmedExecuteStep(task)?.parameters.command ?? ""),
  ) : undefined;
  const result = (kind === "download" || kind === "verification.download") && !downloadObservation
    ? "contradiction" as const
    : commandOutcome && !commandOutcome.consistent
    ? "contradiction" as const
    : commandOutcome && ["rejected", "indeterminate"].includes(commandOutcome.outcome.status)
      ? "contradiction" as const
      : deterministicEvidenceResult(expected, observed, summary, suppliedResult);
  return {
    kind, summary, at: new Date().toISOString(),
    step_id: String(payload.step_id ?? requirement?.step_id ?? "") || undefined,
    tool: String(payload.tool ?? requirement?.tool ?? "") || undefined,
    target: String(payload.target ?? requirement?.target ?? "") || undefined,
    parameters: payload.parameters && typeof payload.parameters === "object" && !Array.isArray(payload.parameters)
      ? payload.parameters as Record<string, unknown>
      : requirement?.parameters,
    operation_digest: String(payload.operation_digest ?? "") || undefined,
    confirmation_digest: String(payload.confirmation_digest ?? "") || undefined,
    expected,
    observed: observed ?? inferObserved(expected, summary),
    result,
    code: String(payload.code ?? "") || undefined,
    stage: String(payload.stage ?? "") || undefined,
    provider_calls: Number.isFinite(Number(payload.provider_calls)) ? Number(payload.provider_calls) : undefined,
    tool_calls: Number.isFinite(Number(payload.tool_calls)) ? Number(payload.tool_calls) : undefined,
    command_outcome: commandOutcome?.outcome,
  };
}

function validatedFileDownloadObservation(
  requirement: TaskRecord["plan"]["operation"]["execution_evidence"][number] | undefined,
  value: unknown,
) {
  if (!requirement || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const observed = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(observed).sort()) !== JSON.stringify([
    "created", "schema_version", "sha256", "size_bytes", "source_url_sha256", "target",
  ])) return undefined;
  const parameters = requirement.parameters ?? {};
  const source = parameters.url;
  const target = parameters.target;
  const requestedSHA = parameters.sha256;
  if (typeof source !== "string" || typeof target !== "string") return undefined;
  const sourceSHA = createHash("sha256").update(source).digest("hex");
  const size = observed.size_bytes;
  const checksum = observed.sha256;
  if (observed.schema_version !== "file-download-result/v1" || observed.created !== true
    || observed.target !== target
    || typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 64 * 1024 * 1024
    || typeof checksum !== "string" || !/^[a-f0-9]{64}$/u.test(checksum)
    || observed.source_url_sha256 !== sourceSHA
    || requestedSHA !== undefined && requestedSHA !== checksum) return undefined;
  return structuredClone(observed);
}

function validatedConsoleCommandOutcome(reported: unknown, summary: string, requireExplicit: boolean, command: string) {
  const computed = classifyConsoleCommandOutcome(summary, requireExplicit, command);
  const outcome = { ...computed, output_sha256: createHash("sha256").update(summary).digest("hex") };
  const conflict = {
    ...outcome,
    status: "indeterminate" as const,
    code: "OUTCOME_CONFLICT" as const,
    user_message: "服务器返回的命令结果缺少一致的可信信息，因此没有把这次操作标记为成功。",
  };
  // The Cloud can independently reconstruct the authoritative outcome from
  // the raw callback. A missing Agent projection is therefore compatible;
  // an explicitly supplied projection must match exactly or fail closed.
  if (reported === undefined || reported === null) return { outcome, consistent: true };
  if (typeof reported !== "object" || Array.isArray(reported)) return { outcome: conflict, consistent: false };
  const candidate = reported as Record<string, unknown>;
  const consistent = candidate.schema_version === outcome.schema_version
    && candidate.status === outcome.status
    && candidate.code === outcome.code
    && candidate.user_message === outcome.user_message
    && candidate.output_sha256 === outcome.output_sha256;
  return { outcome: consistent ? outcome : conflict, consistent };
}

function commandOutcomeUserMessage(task: TaskRecord, outcome?: ConsoleCommandOutcome & { output_sha256: string }) {
  if (!outcome) return "服务器返回的命令结果无法可信确认，因此没有把这次操作标记为成功。";
  const command = String(confirmedExecuteStep(task)?.parameters.command ?? "").trim().toLowerCase();
  if (outcome.code === "NO_TARGETS" && /^title\s+@a\s+(?:actionbar|title)\b/.test(command)) {
    return "没有找到在线玩家，因此没有人收到提示。";
  }
  return outcome.user_message;
}

function deterministicEvidenceResult(expected: unknown, observed: unknown, summary: string, supplied?: "match" | "contradiction" | "insufficient") {
  if (supplied === "contradiction") return "contradiction" as const;
  if (supplied === "insufficient") return "insufficient" as const;
  if (expected === undefined) return supplied === "match" ? "match" as const : "match" as const;
  const normalizedExpected = normalizeFact(expected);
  const normalizedObserved = observed === undefined ? inferObserved(expected, summary) : normalizeFact(observed);
  if (normalizedObserved === undefined) return "insufficient" as const;
  return normalizedObserved === normalizedExpected ? "match" as const : "contradiction" as const;
}

function inferObserved(expected: unknown, summary: string): string | undefined {
  if (typeof expected !== "string") return undefined;
  const normalized = summary.toLowerCase();
  if (/\b(?:does\s+not\s+contain|not\s+present|absent|missing)\b/.test(normalized)) return "absent";
  if (/\b(?:contains|present|listed)\b/.test(normalized) && !/\bnot\b/.test(normalized)) return "present";
  const values = ["midnight", "noon", "night", "day", "peaceful", "easy", "normal", "hard", "thunder", "rain", "clear", "spectator", "adventure", "creative", "survival", "true", "false"];
  for (const value of values) {
    if (new RegExp(`\\b${value}\\b`, "i").test(normalized)) return value;
  }
  if (normalized.includes(expected.toLowerCase())) return expected.toLowerCase();
  return undefined;
}

function parseWebSearchEvidence(summary: string, expectedQuery: string) {
  const marker = "\nEvidence: ";
  const start = summary.lastIndexOf(marker);
  if (start < 0 || summary.length - start > 20_000 || !expectedQuery) return undefined;
  let value: unknown;
  try { value = JSON.parse(summary.slice(start + marker.length)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "web-search-result/v1" || record.query !== expectedQuery
    || typeof record.provider !== "string" || record.provider.length < 1 || record.provider.length > 64
    || !Array.isArray(record.results) || record.results.length < 1 || record.results.length > 10) return undefined;
  const results = record.results.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const result = item as Record<string, unknown>;
    if (typeof result.title !== "string" || result.title.length < 1 || result.title.length > 300
      || typeof result.url !== "string" || result.url.length < 1 || result.url.length > 2_048
      || typeof result.snippet !== "string" || result.snippet.length < 1 || result.snippet.length > 1_200
      || typeof result.date !== "string" || result.date.length > 100) return undefined;
    try {
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    } catch { return undefined; }
    return { title: result.title, url: result.url, snippet: result.snippet, date: result.date };
  });
  if (results.some((item) => !item)) return undefined;
  return { schema_version: "web-search-result/v1", query: expectedQuery, provider: record.provider, results };
}

function normalizeFact(value: unknown) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "boolean" || typeof value === "number") return String(value).toLowerCase();
  return JSON.stringify(value);
}

function claimsSuccess(answer: string) {
  return /(?:已完成|已成功|已经完成|已经安装|已经修改|已设置|任务完成|successfully|completed|installed|modified|changed|fixed)/i.test(answer);
}

function safeRecoveryContinuation(task: TaskRecord, intent: string, preferredTool: string | undefined, instance: {
  profile_revision: string;
  platform: string;
  minecraft_version: string;
  loader?: string;
}) {
  if (!intent) return false;
  const next = draftPlan(task.instance_ref, instance.profile_revision, intent, {
    preferredTool,
    platform: instance.platform,
    minecraftVersion: instance.minecraft_version,
    loader: instance.loader,
  });
  if (next.operation.risk === "forbidden") return false;
  // Read/low recovery may run automatically. Medium/high recovery is allowed
  // only as a new task because TasksService.create will put it behind a new,
  // plan-scoped confirmation token.
  return true;
}
