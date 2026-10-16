import { constrainAgentRequest, requestAllowsMutation } from "./agent-request-boundary";
import { applyUserWebSearchScope } from "./web-search-scope";
import { BadRequestException, Injectable, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OPERATION_POLICY_VERSION, type AgentRunRecord, type ConversationMessage, type ConversationSession, type TaskRecord } from "@mcai/contracts";
import { CloudStore } from "../store/cloud.store";
import { ModelGatewayService, type ChatDecision, type ChatStreamProgress } from "../model-gateway/model-gateway.service";
import { TasksService } from "../tasks/tasks.service";
import {
  expandOperationalSkill,
  explicitPluginInstallProject,
  extractPluginResolveIntent,
  extractConsoleCommandIntent,
  extractConfigInspectIntent,
  extractFilesListIntent,
} from "../tasks/planner";
import { conditionalFirstPlayerGamemodeIntent, configIdentifierScope, extractLogQueryIntent } from "../tasks/goal-requirements";
import { extractGameruleReadIntent } from "../tasks/gamerule-read-intent";
import { classifyOperationalLanguage, extractActionbarConsoleCommand, extractBroadcastConsoleCommand, extractTitleConsoleCommand, extractTransientPlayerEffectCommand, hasInstanceLifecycleLanguage, isRuntimeVersionReadIntent, performanceReadMetrics, resolveConsoleOperation, resolveInstanceLifecycleIntent } from "../tasks/operation-intent";
import { answerEvidenceQuestion, guardDirectWithoutEvidence, isEvidenceQuestion, safeTaskAnswer, safeUserText } from "./user-safe-response";
import { AGENT_LOOP_MAX_ROUNDS, AGENT_LOOP_MAX_TOOL_CALLS, AGENT_LOOP_TOOL_CATALOG, bindAgentToolCallToObservations, canonicalAgentToolCallKey, type AgentLoopObservation, type AgentLoopToolCall } from "./agent-loop";
import { AgentRunStore } from "../agents/agent-run.store";
import { publicSourceSearchCompletion, renderWebSourceFinal, renderQa0144ReadFinal } from "../tasks/qa0144-read-observation";
import { AtomicJsonFile } from "../store/atomic-json-file";
import { renderPluginOutcomeFinal, renderPluginLookupFinal } from "./plugin-outcome-final";
import { renderVerifiedFileDownloadFinal } from "../tasks/file-download-final";

const defaultSystemPrompt = [
  "你是 MCAI Sidecar 的 Minecraft 运维助手。",
  "执行优先：目标明确时立即使用受控工具完成，不把可执行工作退回给用户。",
  "只输出解决用户当前请求所必需的内容，不展示内部推理，不复述问题，不寒暄，不总结已清楚的内容。",
  "禁止在答案末尾主动提供额外帮助或追加邀请，例如“如果需要我可以继续”“有其他问题请告诉我”。",
  "简单知识问题直接回答；仅当缺少继续所必需且无法从当前实例获得的信息时才追问。",
  "请求中的当前实例就是页面已选定的执行目标，只要实例存在，不得重复询问要操作哪个实例。",
  "明确的实例操作或控制台命令优先调用受控工具，不能要求用户重复提供库存中已有的平台、版本或状态。",
  "用户只需描述目标。将“检查服务器健康”“看看服务器有没有问题”等短指令自动展开为只读健康检查技能：读取版本、插件和近期日志，等待每一步真实回调后形成综合结论。",
  "工具已接受、命令已提交或任务正在运行不代表完成；必须等待回调并依据真实证据回答。",
  "复杂分析可委派诊断或规划子 Agent。",
  "只有需要读取服务器状态或执行操作时才请求受控工具。",
  "不得绕过确认、风险策略或生成任意 Shell。",
].join("\n");

const maxContinuationDepth = 6;

interface PersistedChat {
  sessions: ConversationSession[];
  messages: ConversationMessage[];
}

export function renderConcreteAgentFailure(request: string, observations: AgentLoopObservation[]) {
  const failed = [...observations].reverse().find((item) => ["failed", "indeterminate"].includes(item.status));
  if (!failed) return undefined;
  const summaries = [...failed.evidence.summaries].reverse();
  const candidates = [...summaries, failed.error?.message ?? ""];
  const completedWrites = [...new Set(observations.flatMap((item) => {
    if (item.status !== "succeeded" || item.side_effect !== "applied") return [];
    const args = (item.data as { call_arguments?: Record<string, unknown> } | undefined)?.call_arguments;
    if (item.tool === "plugin.install" && typeof args?.project === "string"
      && /^[a-z0-9_-]{2,64}$/iu.test(args.project)) return [`plugin:${args.project}`];
    if (item.tool === "config.patch" && typeof args?.path === "string") return [`config:${args.path}`];
    return [`operation:${item.tool}`];
  }))];
  const failedArgs = (failed.data as { call_arguments?: Record<string, unknown> } | undefined)?.call_arguments;
  const failedProject = typeof failedArgs?.project === "string" && /^[a-z0-9_-]{2,64}$/iu.test(failedArgs.project)
    ? failedArgs.project : undefined;
  const toolNames = AGENT_LOOP_TOOL_CATALOG.map((entry) => entry.name);
  for (const candidate of candidates) {
    let fact = String(candidate ?? "").trim();
    if (!fact) continue;
    fact = fact.replace(/(?:(?:api[_ -]?key|token|secret|password)\s*[:=]\s*)\S+/giu, "$1[REDACTED]");
    fact = fact.replace(/https?:\/\/\S+|\bmcs:[A-Za-z0-9:_-]{12,}\b|\b(?:task|call)_[a-z0-9-]{8,}\b/giu, "");
    for (const toolName of toolNames) {
      const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      fact = fact.replace(new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`, "giu"), " 相关操作");
    }
    fact = fact.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/giu, (value) => value.replaceAll("_", " "));
    fact = fact.replace(/\s+/gu, " ").trim().replace(/^[;；,，:：\s]+|[;；,，\s]+$/gu, "").slice(0, 320);
    fact = safeUserText(fact, "");
    if (!fact || !/(?:\b(?:HTTP\s*)?[45]\d\d\b|不存在|未找到|拒绝|超时|不可用|错误|失败|not found|no exact|denied|timeout|unavailable|error|fail)/iu.test(fact)) continue;
    const chinese = /[\u3400-\u9fff]/u.test(request);
    const period = /[。.!！?？]$/u.test(fact) ? "" : chinese ? "。" : ".";
    const noSideEffect = failed.side_effect === "none" && completedWrites.length === 0
      ? chinese ? "本次失败未产生修改。" : " The failed attempt made no changes."
      : "";
    const completed = completedWrites.map((item) => {
      const [kind, value] = item.split(":", 2);
      if (kind === "plugin") return chinese ? `已安装 ${value}` : `installed ${value}`;
      if (kind === "config") return chinese ? `已修改 ${value}` : `updated ${value}`;
      return chinese ? "已有操作执行成功" : "an operation succeeded";
    }).join(chinese ? "；" : "; ");
    const partial = completedWrites.length > 0
      ? chinese
        ? `部分完成：${completed}。${failedProject ? `${failedProject} 未完成。` : ""}`
        : `Partially completed: ${completed}.${failedProject ? ` ${failedProject} remains incomplete.` : ""} `
      : chinese ? "任务未完成。" : "The task could not be completed. ";
    return chinese
      ? `${partial}具体失败原因：${fact}${period}${noSideEffect}`
      : `${partial}Specific failure: ${fact}${period}${noSideEffect}`;
  }
  return undefined;
}

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly path: string;
  private readonly pendingSends = new Map<string, Promise<{ message: ConversationMessage; task?: ReturnType<TasksService["get"]> }>>();
  private readonly pendingCompletions = new Map<string, ReturnType<TasksService["complete"]>>();
  private readonly pendingAgentLoopCompletions = new Map<string, Promise<void>>();
  private backgroundRunner?: ReturnType<typeof setInterval>;
  private backgroundPass?: Promise<void>;
  private backgroundEnabled = false;
  private readonly persistence: AtomicJsonFile;

  constructor(
    private readonly store: CloudStore,
    private readonly modelGateway: ModelGatewayService,
    private readonly tasks: TasksService,
    private readonly agentRuns: AgentRunStore = new AgentRunStore(),
    @Optional() configPath?: string,
  ) {
    this.path = configPath ?? join(resolve(process.env.MCAI_CONFIG_DIR ?? join(process.cwd(), ".data", "mcai")), "conversations.json");
    this.persistence = new AtomicJsonFile(this.path);
  }

  async onModuleInit() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as PersistedChat;
      for (const session of data.sessions ?? []) this.store.sessions.set(session.id, session);
      for (const message of data.messages ?? []) {
        const list = this.store.messages.get(message.session_id) ?? [];
        list.push(message);
        this.store.messages.set(message.session_id, list);
      }
    } catch {
      // First run or an unreadable optional conversation archive starts empty.
    }
    this.backgroundEnabled = true;
    this.backgroundRunner = setInterval(() => { void this.runBackgroundPass(); }, 250);
    this.backgroundRunner.unref?.();
    void this.runBackgroundPass();
  }

  async onModuleDestroy() {
    this.backgroundEnabled = false;
    if (this.backgroundRunner) clearInterval(this.backgroundRunner);
    await this.backgroundPass;
  }

  list(tenantId: string) {
    return [...this.store.sessions.values()]
      .filter((session) => session.tenant_id === tenantId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async create(tenantId: string, instanceRef: string, title?: string) {
    const instance = this.store.instances.get(instanceRef);
    if (!instance || instance.tenant_id !== tenantId) throw new NotFoundException("Instance not found");
    if (this.list(tenantId).length >= 50) throw new BadRequestException("最多保留 50 个会话");
    const now = new Date().toISOString();
    const session: ConversationSession = {
      id: `session_${randomUUID()}`,
      tenant_id: tenantId,
      instance_ref: instanceRef,
      title: title?.trim().slice(0, 60) || "新会话",
      system_prompt: defaultSystemPrompt,
      created_at: now,
      updated_at: now,
    };
    this.store.sessions.set(session.id, session);
    this.store.messages.set(session.id, []);
    await this.persist();
    return session;
  }

  async messages(sessionId: string, tenantId: string) {
    this.getSession(sessionId, tenantId);
    return this.store.messages.get(sessionId) ?? [];
  }

  private async advanceSession(sessionId: string, tenantId: string) {
    const session = this.getSession(sessionId, tenantId);
    const list = this.store.messages.get(sessionId) ?? [];
    let changed = false;
    for (const message of [...list]) {
      if (message.role !== "assistant" || !message.task_id || message.task_phase === "completion") continue;
      const alreadyCompleted = list.some((item) => item.task_id === message.task_id && item.task_phase === "completion");
      if (alreadyCompleted) continue;
      const agentLoopRun = await this.agentRuns.findByCurrentTask(message.task_id, tenantId);
      if (agentLoopRun) {
        const key = `${tenantId}:${message.task_id}`;
        let pending = this.pendingAgentLoopCompletions.get(key);
        if (!pending) {
          pending = this.completeAgentLoopTask(session, tenantId, message.task_id, agentLoopRun, list);
          this.pendingAgentLoopCompletions.set(key, pending);
        }
        try { await pending; } finally { if (this.pendingAgentLoopCompletions.get(key) === pending) this.pendingAgentLoopCompletions.delete(key); }
        changed = true;
        continue;
      }
      // A durable run advances current_task_id after each tool call. Earlier
      // request messages remain in the conversation, but they still belong to
      // that run and must never fall through to the legacy completion engine.
      // Bind ownership through the persisted tool-call id rather than through
      // mutable current-task state.
      let historicalAgentRun;
      try {
        const historicalTask = this.tasks.get(message.task_id, tenantId);
        const callId = historicalTask.plan?.agent_execution?.tool_call_id;
        historicalAgentRun = callId ? await this.agentRuns.findByCall(callId, tenantId) : undefined;
      } catch (cause) {
        if (!(cause instanceof NotFoundException)) throw cause;
      }
      if (historicalAgentRun) continue;
      // The durable run lookup yields. A concurrent poll may have appended the
      // completion while this request was awaiting storage, so re-check before
      // entering the legacy completion path and preserve GET idempotency.
      if (list.some((item) => item.task_id === message.task_id && item.task_phase === "completion")) continue;
      let completion;
      try {
        completion = await this.completeTask(message.task_id, tenantId);
      } catch (cause) {
        if (cause instanceof NotFoundException) continue;
        throw cause;
      }
      if (!completion) continue;
      if (list.some((item) => item.task_id === message.task_id && item.task_phase === "completion")) continue;
      const finalMessage: ConversationMessage = {
        id: `message_${randomUUID()}`,
        session_id: session.id,
        role: "assistant",
        content: safeUserText(completion.answer, "任务已结束，但目前无法用可靠证据确认结果。"),
        route: "tool",
        task_id: message.task_id,
        task_phase: "completion",
        created_at: new Date().toISOString(),
      };
      list.push(finalMessage);
      session.updated_at = finalMessage.created_at;
      changed = true;
      const parentTask = this.tasks.get(message.task_id, tenantId);
      const continuation = completion.continuation;
      const nextDepth = (parentTask.chain_depth ?? 0) + 1;
      if (continuation && nextDepth <= maxContinuationDepth) {
        const nextTask = await this.tasks.create({
          tenantId,
          instanceRef: session.instance_ref,
          intent: continuation.intent,
          assistantResponse: continuation.answer,
          modelRequestId: continuation.request_id,
          modelStatus: "answered",
          sessionId: session.id,
          parentTaskId: parentTask.id,
          chainDepth: nextDepth,
          preferredTool: continuation.preferred_tool,
        });
        const requestMessage: ConversationMessage = {
          id: `message_${randomUUID()}`,
          session_id: session.id,
          role: "assistant",
          content: continuation.answer,
          route: "tool",
          task_id: nextTask.id,
          task_phase: "request",
          trace: [{ stage: "tool", label: "继续调用工具", result: continuation.preferred_tool ?? nextTask.plan.steps[0]?.tool ?? "controlled" }],
          created_at: new Date().toISOString(),
        };
        list.push(requestMessage);
        session.updated_at = requestMessage.created_at;
      }
    }
    if (changed) await this.persist();
    return list;
  }

  private runBackgroundPass() {
    if (!this.backgroundEnabled) return Promise.resolve();
    if (this.backgroundPass) return this.backgroundPass;
    const pass = (async () => {
      for (const session of [...this.store.sessions.values()]) {
        try {
          await this.advanceSession(session.id, session.tenant_id);
        } catch (cause) {
          console.error(JSON.stringify({
            event: "mcai_agent_runner_session_failed",
            session_id: session.id,
            error: cause instanceof Error ? cause.message : String(cause),
          }));
        }
      }
    })();
    this.backgroundPass = pass;
    void pass.finally(() => { if (this.backgroundPass === pass) this.backgroundPass = undefined; });
    return pass;
  }

  private async completeAgentLoopTask(
    session: ConversationSession,
    tenantId: string,
    taskId: string,
    run: AgentRunRecord,
    list: ConversationMessage[],
  ) {
    const observation = this.tasks.agentLoopObservation(taskId, tenantId);
    if (!observation) return;
    run = await this.agentRuns.recordObservation(run.run_id, taskId, observation);
    if (run.status === "CANCELLED") return;
    const restoredObservations = restoreAgentLoopObservations(run.observations);
    if (!restoredObservations) {
      await this.agentRuns.finish(run.run_id, "FAILED", { code: "AGENT_RUN_INVALID_PERSISTED_TOOL" });
      return;
    }
    const exhausted = agentRunBudgetExhausted(run, Date.now());
    const decisionInput = {
      sessionId: session.id,
      message: run.original_user_message,
      systemPrompt: run.system_prompt,
      history: list,
      instance: this.store.instances.get(session.instance_ref)!,
      observations: restoredObservations,
      round: run.round_count + 1,
    };
    const publicSearch = publicSourceSearchCompletion(run.original_user_message, restoredObservations);
    let result = publicSearch ? { status: "answered" as const, decision: publicSearch.decision, requestId: run.run_id }
      : exhausted ? { status: "unavailable" as const, error: "AGENT_LOOP_BUDGET_EXHAUSTED" } : await this.modelGateway.decideAgentLoop(decisionInput);
    // The observation is already durable and the tool must never be replayed.
    // One bounded retry only asks the model to decide from the same facts when
    // the decision endpoint is transiently unavailable.
    if (!exhausted && result.status === "unavailable"
      && (transientAgentDecisionError(result.error)
        || result.error === "AGENT_TERMINAL_EVIDENCE_INCOMPLETE"
        || result.error === "AGENT_TERMINAL_REVIEW_INVALID")) {
      result = await this.modelGateway.decideAgentLoop(decisionInput);
    }
    if (result.status === "answered") {
      result = { ...result, decision: constrainAgentRequest(applyUserWebSearchScope(result.decision, run.original_user_message), run.original_user_message, this.store.instances.get(session.instance_ref)?.platform) };
      await this.agentRuns.recordDecision(run.run_id, run.round_count + 1, result.decision);
    }
    else await this.agentRuns.recordDecisionError(run.run_id, run.round_count + 1, { code: result.error, exhausted });
    const durableRun = await this.agentRuns.get(run.run_id, tenantId);
    if (!durableRun || durableRun.status === "CANCELLED") return;
    const completedWebSearchAnswer = renderCompletedWebSearch(run.original_user_message, restoredObservations);
    if (result.status === "answered" && result.decision.action === "tool_call") {
      const boundDecision = bindAgentToolCallToObservations(result.decision, restoredObservations);
      const callKey = boundDecision ? canonicalAgentToolCallKey(boundDecision) : "";
      if (boundDecision && canExecuteAgentCall(run, boundDecision, restoredObservations) && run.tool_call_count < AGENT_LOOP_MAX_TOOL_CALLS) {
        const toolCallId = `call_${randomUUID()}`;
        const nextTask = await this.tasks.create({
          tenantId, instanceRef: session.instance_ref, intent: run.original_user_message,
          assistantResponse: boundDecision.reason, modelRequestId: result.requestId, modelStatus: "answered",
          sessionId: session.id, parentTaskId: taskId, chainDepth: run.round_count,
          preferredTool: boundDecision.tool, agentToolCall: { ...boundDecision, toolCallId },
        });
        await this.agentRuns.advance(run.run_id, taskId, nextTask.id, {
          id: toolCallId, key: callKey, tool: boundDecision.tool,
          arguments: boundDecision.arguments, reason: boundDecision.reason,
        });
        await this.tasks.bindAgentApproval?.(run.run_id, nextTask.id, toolCallId);
        list.push({
          id: `message_${randomUUID()}`, session_id: session.id, role: "assistant",
          content: safeTaskAnswer(boundDecision.reason, nextTask.state, nextTask.evidence.length > 0), route: "tool",
          task_id: nextTask.id, task_phase: "request",
          trace: [{ stage: "tool", label: "AI 依据真实结果继续调用工具", result: boundDecision.tool }],
          created_at: new Date().toISOString(),
        });
        session.updated_at = list[list.length - 1]!.created_at;
        return;
      }
    }
    const modelFinalAnswer = result.status === "answered" && result.decision.action === "final"
      ? result.decision.answer
      : undefined;
    const verifiedConfigChange = renderReadThenPatchFinal(run.original_user_message, restoredObservations);
    const verifiedPerformance = renderPerformanceFinal(run.original_user_message, restoredObservations);
    const canonicalReadAnswer = renderQa0144ReadFinal(run.original_user_message, restoredObservations);
    const canonicalInventoryAnswer = restoredObservations.length === 1 && restoredObservations[0]?.tool === "files.list"
      ? canonicalReadAnswer : undefined;
    const canonicalDownloadAnswer = renderVerifiedFileDownloadFinal(run.original_user_message, restoredObservations);
    const webOnly = restoredObservations.length > 0 && restoredObservations.every((item) => item.tool === "web.search");
    // URLs alone cannot prove a model's claims. Pure searches close with fetched
    // passages and their provenance, or an explicit discovery-only result.
    const sourceAnswer = webOnly ? renderWebSourceFinal(run.original_user_message, restoredObservations) : undefined;
    const pluginLookup = !requestAllowsMutation(run.original_user_message) ? renderPluginLookupFinal(run.original_user_message, restoredObservations) : undefined;
    const groundedAnswer = pluginLookup ?? verifiedConfigChange ?? verifiedPerformance ?? canonicalInventoryAnswer ?? sourceAnswer
      ?? (webOnly ? undefined : modelFinalAnswer ?? canonicalReadAnswer ?? canonicalDownloadAnswer);
    const cannotProceedAnswer = !sourceAnswer && !verifiedConfigChange && result.status === "answered" && result.decision.action === "cannot_proceed"
      ? result.decision.answer
      : undefined;
    const concreteFailureAnswer = renderConcreteAgentFailure(run.original_user_message, restoredObservations);
    const partialFailureAnswer = restoredObservations.some((item) => item.status === "succeeded" && item.side_effect === "applied")
      ? concreteFailureAnswer : undefined;
    const pluginOutcome = renderPluginOutcomeFinal(run.original_user_message, restoredObservations);
    const pluginAnswer = pluginOutcome && (pluginOutcome.blocked || result.status === "unavailable") ? pluginOutcome.answer : undefined;
    const answer = pluginAnswer ?? partialFailureAnswer ?? cannotProceedAnswer ?? groundedAnswer ?? completedWebSearchAnswer ?? concreteFailureAnswer ?? (result.status === "answered"
      ? "我没有重复执行相同操作；目前无法继续安全完成这条请求。"
      : observation.status === "succeeded"
        ? "已取得真实工具结果，但暂时无法生成可靠的最终说明。"
        : "这次操作没有取得可用结果，因此无法确认目标已经完成。");
    await this.agentRuns.finish(run.run_id, (!publicSearch || publicSearch.verified) && !pluginAnswer && !cannotProceedAnswer && (groundedAnswer || completedWebSearchAnswer) ? "SUCCEEDED" : "FAILED", { answer, observation_status: observation.status });
    const finishedRun = await this.agentRuns.get(run.run_id, tenantId);
    if (!finishedRun || finishedRun.status === "CANCELLED") return;
    let terminalTaskId = taskId;
    if (finishedRun.status === "FAILED") {
      const failedCallId = [...restoredObservations].reverse()
        .find((item) => item.status === "failed" || item.status === "indeterminate")?.tool_call_id;
      if (failedCallId) {
        for (const candidate of [...list].reverse()) {
          if (!candidate.task_id) continue;
          try {
            if (this.tasks.get(candidate.task_id, tenantId).plan?.agent_execution?.tool_call_id === failedCallId) {
              terminalTaskId = candidate.task_id;
              break;
            }
          } catch (cause) {
            if (!(cause instanceof NotFoundException)) throw cause;
          }
        }
      }
    }
    const trustedDownloadAnswer = !cannotProceedAnswer && !modelFinalAnswer && !canonicalReadAnswer
      && Boolean(canonicalDownloadAnswer) && answer === canonicalDownloadAnswer;
    list.push({
      id: `message_${randomUUID()}`, session_id: session.id, role: "assistant",
      content: trustedDownloadAnswer || (sourceAnswer && answer === sourceAnswer) ? answer : safeUserText(answer, "任务已结束，但目前无法用可靠证据确认结果。"), route: "tool",
      task_id: terminalTaskId, task_phase: "completion",
      trace: [{ stage: "review", label: "AI 依据真实工具结果形成回答", result: observation.status }],
      created_at: new Date().toISOString(),
    });
    session.updated_at = list[list.length - 1]!.created_at;
  }

  private async completeTask(taskId: string, tenantId: string) {
    const key = `${tenantId}:${taskId}`;
    const pending = this.pendingCompletions.get(key);
    if (pending) return pending;
    const operation = this.tasks.complete(taskId, tenantId);
    this.pendingCompletions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingCompletions.get(key) === operation) this.pendingCompletions.delete(key);
    }
  }

  async update(sessionId: string, tenantId: string, input: { title?: string; system_prompt?: string }) {
    const session = this.getSession(sessionId, tenantId);
    if (typeof input.title === "string") {
      const title = input.title.trim();
      if (!title || title.length > 60) throw new BadRequestException("会话标题需要 1-60 个字符");
      session.title = title;
    }
    if (typeof input.system_prompt === "string") {
      const prompt = input.system_prompt.trim();
      if (!prompt || prompt.length > 4_000) throw new BadRequestException("系统提示词需要 1-4000 个字符");
      session.system_prompt = prompt;
    }
    session.updated_at = new Date().toISOString();
    await this.persist();
    void this.runBackgroundPass();
    return session;
  }

  async remove(sessionId: string, tenantId: string) {
    this.getSession(sessionId, tenantId);
    await this.agentRuns.removeBySession(sessionId, tenantId);
    this.store.sessions.delete(sessionId);
    this.store.messages.delete(sessionId);
    await this.persist();
    return { deleted: true };
  }

  async send(sessionId: string, tenantId: string, contentInput: string, requestId?: string) {
    return this.sendInternal(sessionId, tenantId, contentInput, requestId);
  }

  async sendStream(sessionId: string, tenantId: string, contentInput: string, requestId: string | undefined, onProgress: (event: ChatStreamProgress) => void) {
    return this.sendInternal(sessionId, tenantId, contentInput, requestId, onProgress);
  }

  private async sendInternal(sessionId: string, tenantId: string, contentInput: string, requestIdInput?: string, onProgress?: (event: ChatStreamProgress) => void) {
    const session = this.getSession(sessionId, tenantId);
    const content = contentInput.trim();
    if (!content || content.length > 4_000) throw new BadRequestException("消息需要 1-4000 个字符");
    const requestId = requestIdInput?.trim();
    if (requestId && !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
      throw new BadRequestException("Invalid request_id");
    }
    if (!requestId) return this.executeSend(session, tenantId, content, undefined, onProgress);

    const list = this.store.messages.get(session.id) ?? [];
    const priorUser = list.find((message) => message.role === "user" && message.request_id === requestId);
    if (priorUser && priorUser.content !== content) throw new BadRequestException("request_id already used for different content");
    const priorAnswer = list.find((message) => message.role === "assistant" && message.request_id === requestId);
    if (priorAnswer) {
      return { message: priorAnswer, task: priorAnswer.task_id ? this.tasks.get(priorAnswer.task_id, tenantId) : undefined };
    }

    const pendingKey = `${tenantId}:${sessionId}:${requestId}`;
    const pending = this.pendingSends.get(pendingKey);
    if (pending) return pending;
    const operation = this.executeSend(session, tenantId, content, requestId, onProgress);
    this.pendingSends.set(pendingKey, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingSends.get(pendingKey) === operation) this.pendingSends.delete(pendingKey);
    }
  }

  private async executeSend(
    session: ConversationSession,
    tenantId: string,
    content: string,
    requestId?: string,
    onProgress?: (event: ChatStreamProgress) => void,
  ) {
    const entryStartedAt = Date.now();
    const instance = this.store.instances.get(session.instance_ref);
    if (!instance || instance.tenant_id !== tenantId) throw new NotFoundException("Instance not found");
    const list = this.store.messages.get(session.id) ?? [];
    let userMessage = requestId
      ? list.find((message) => message.role === "user" && message.request_id === requestId)
      : undefined;
    if (!userMessage) {
      userMessage = {
        id: `message_${randomUUID()}`,
        session_id: session.id,
        request_id: requestId,
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };
      list.push(userMessage);
    }
    if (isEvidenceQuestion(content)) {
      const priorAssistant = [...list].reverse().find((message) => message.role === "assistant");
      const priorUser = [...list].reverse().find((message) => message.role === "user" && message.id !== userMessage.id);
      let priorTask: TaskRecord | undefined;
      if (priorAssistant?.task_id) {
        try { priorTask = this.tasks.get(priorAssistant.task_id, tenantId); } catch { /* Missing historical task stays unproven. */ }
      }
      const answer = answerEvidenceQuestion(priorTask, `${priorUser?.content ?? ""}\n${priorAssistant?.content ?? ""}`);
      if (onProgress) onProgress({ type: "delta", text: answer });
      const followUpMessage: ConversationMessage = {
        id: `message_${randomUUID()}`, session_id: session.id, request_id: requestId, role: "assistant",
        content: answer, route: "direct", trace: [{ stage: "review", label: "核对最近执行证据", result: priorTask ? priorTask.state : "没有关联任务" }],
        created_at: new Date().toISOString(),
      };
      list.push(followUpMessage);
      this.store.messages.set(session.id, list);
      session.updated_at = followUpMessage.created_at;
      await this.persist();
      return { message: followUpMessage };
    }
    const routeInput = {
      sessionId: session.id,
      message: content,
      systemPrompt: session.system_prompt,
      history: list.filter((message) => message.id !== userMessage.id),
      instance,
    };
    onProgress?.({ type: "status", stage: "understanding", text: "正在理解请求" });
    const pendingAgentRun = await this.agentRuns.create({
      tenant_id: tenantId, session_id: session.id, instance_ref: session.instance_ref,
      original_user_message: content, system_prompt: session.system_prompt,
      model_name: undefined, prompt_version: "agent-loop-prompt/v1",
      tool_catalog_version: "agent-loop-decision/v1", policy_version: OPERATION_POLICY_VERSION,
    });
    onProgress?.({ type: "status", stage: "routing", text: "正在判断是否需要工具" });
    // Production chat is AI-first. The legacy deterministic router below is
    // retained only as a compatibility fallback when the model endpoint is
    // unavailable; it never gets to pre-empt an answered AI decision.
    const decideAgentLoop = (this.modelGateway as ModelGatewayService & { decideAgentLoop?: ModelGatewayService["decideAgentLoop"] }).decideAgentLoop;
    const knowledgeRefinement = typeof decideAgentLoop === "function"
      && /paper\s*(?:和|与|跟|vs)\s*fabric.*区别/iu.test(content)
      && typeof this.modelGateway.route === "function"
      ? await this.modelGateway.route(routeInput) : undefined;
    const refinedKnowledgeAnswer = knowledgeRefinement?.route === "direct"
      && knowledgeRefinement.trace?.some((item) => item.stage === "planning" && item.label === "目标已细化")
      ? knowledgeRefinement.answer : undefined;
    let agentLoopResult = refinedKnowledgeAnswer
      ? { status: "answered" as const, requestId: knowledgeRefinement?.requestId ?? `refined-${randomUUID()}`,
          decision: { action: "final" as const, answer: refinedKnowledgeAnswer, citations: [] as string[] } }
      : typeof decideAgentLoop === "function"
      ? await decideAgentLoop.call(this.modelGateway, { ...routeInput, observations: [], round: 1 })
      : { status: "unavailable" as const, error: "AGENT_LOOP_NOT_IMPLEMENTED" };
    if (agentLoopResult.status !== "answered" && transientAgentDecisionError(agentLoopResult.error) && typeof decideAgentLoop === "function") {
      await this.agentRuns.recordDecisionError(pendingAgentRun.run_id, 1, { code: agentLoopResult.error, attempt: 1, retry: "transient_once" });
      agentLoopResult = await decideAgentLoop.call(this.modelGateway, { ...routeInput, observations: [], round: 1 });
    }
    const activeAfterDecision = await this.agentRuns.get(pendingAgentRun.run_id, tenantId);
    if (!activeAfterDecision || activeAfterDecision.status === "CANCELLED") {
      throw new NotFoundException("Session was deleted while the request was running");
    }
    if (agentLoopResult.status === "answered") {
      agentLoopResult = { ...agentLoopResult, decision: constrainAgentRequest(applyUserWebSearchScope(agentLoopResult.decision, content), content, instance.platform) };
      await this.agentRuns.recordDecision(pendingAgentRun.run_id, 1, agentLoopResult.decision);
    }
    else {
      await this.agentRuns.recordDecisionError(pendingAgentRun.run_id, 1, { code: agentLoopResult.error });
      await this.agentRuns.finish(pendingAgentRun.run_id, "FAILED", { code: agentLoopResult.error, stage: "initial_decision" });
    }
    let initialAgentToolCall: (AgentLoopToolCall & { toolCallId: string }) | undefined;
    let agentLoopDecision: ChatDecision | undefined;
    if (agentLoopResult.status === "answered") {
      if (agentLoopResult.decision.action === "tool_call") {
        onProgress?.({ type: "status", stage: "planning", text: "正在校验工具计划" });
        initialAgentToolCall = { ...agentLoopResult.decision, toolCallId: `call_${randomUUID()}` };
        agentLoopDecision = {
          route: "tool", answer: agentLoopResult.decision.reason,
          toolIntent: content, preferredTool: agentLoopResult.decision.tool,
          requestId: agentLoopResult.requestId,
          trace: [{ stage: "routing", label: "AI 先理解请求并选择受控工具", result: agentLoopResult.decision.tool }],
        };
      } else if (agentLoopResult.decision.action === "final") {
        agentLoopDecision = { route: "direct", answer: guardDirectWithoutEvidence(agentLoopResult.decision.answer), requestId: agentLoopResult.requestId,
          trace: refinedKnowledgeAnswer ? knowledgeRefinement?.trace : undefined };
      } else {
        agentLoopDecision = { route: "clarify", answer: agentLoopResult.decision.answer, requestId: agentLoopResult.requestId };
      }
      if (onProgress) onProgress({ type: "route", route: agentLoopDecision!.route });
      if (onProgress) onProgress({ type: "delta", text: agentLoopDecision!.answer });
    }
    if (agentLoopResult.status === "answered" && agentLoopResult.decision.action !== "tool_call") {
      await this.agentRuns.finish(pendingAgentRun.run_id, agentLoopResult.decision.action === "final" ? "SUCCEEDED" : "FAILED", {
        answer: agentLoopResult.decision.answer,
        stage: "initial_decision",
      });
    }
    const configInspectIntent = extractConfigInspectIntent(content);
    const adjacentDomainContent = configIdentifierScope(content)?.maskedIntent ?? content;
    const playerMessageCommand = extractTitleConsoleCommand(adjacentDomainContent) ?? extractActionbarConsoleCommand(adjacentDomainContent) ?? extractBroadcastConsoleCommand(adjacentDomainContent) ?? extractTransientPlayerEffectCommand(adjacentDomainContent);
    const lifecycle = playerMessageCommand ? undefined : resolveInstanceLifecycleIntent(adjacentDomainContent);
    const lifecycleLanguage = playerMessageCommand ? false : hasInstanceLifecycleLanguage(adjacentDomainContent);
    const instanceState = String(instance.state ?? "").toLowerCase();
    const lifecycleAlreadySatisfied = lifecycle?.action === "start" && instanceState === "running"
      || lifecycle?.action === "stop" && instanceState === "stopped";
    const operationLanguage = classifyOperationalLanguage(adjacentDomainContent);
    const consoleCommand = playerMessageCommand ?? (operationLanguage === "none"
      ? undefined
      : extractConsoleCommandIntent(adjacentDomainContent) ?? resolveConsoleOperation(adjacentDomainContent));
    const filesListIntent = extractFilesListIntent(adjacentDomainContent);
    const logQueryIntent = extractLogQueryIntent(adjacentDomainContent);
    const operationalSkill = expandOperationalSkill(adjacentDomainContent);
    const pluginInstallProject = explicitPluginInstallProject(adjacentDomainContent);
    const pluginResolveIntent = extractPluginResolveIntent(adjacentDomainContent);
    const performanceMetrics = performanceReadMetrics(adjacentDomainContent);
    const runtimeVersionRead = isRuntimeVersionReadIntent(adjacentDomainContent);
    const gameruleRead = extractGameruleReadIntent(adjacentDomainContent);
    const conditionalPlayerRead = conditionalFirstPlayerGamemodeIntent(adjacentDomainContent);
    const deterministicDecision: ChatDecision | undefined = lifecycleAlreadySatisfied
      ? { route: "direct", answer: lifecycle?.action === "start" ? "当前实例本来就在运行，无需再次启动。" : "当前实例本来就是停止状态，无需再次停止。" }
      : lifecycle
        ? { route: "tool", answer: `${lifecycle.action === "start" ? "启动" : lifecycle.action === "stop" ? "停止" : "重启"}计划已准备，等待确认后执行。`, toolIntent: content, preferredTool: lifecycle.tool }
      : lifecycleLanguage
        ? { route: "clarify", answer: "这条请求包含多个可能的实例生命周期动作，当前无法唯一确定要启动、停止还是重启，因此没有执行。请只保留一个要执行的动作。" }
      : conditionalPlayerRead
        ? { route: "tool", answer: "正在读取在线玩家条件与首位玩家的当前游戏模式。", toolIntent: content }
      : performanceMetrics.length
        ? { route: "tool", answer: "正在读取当前实例的性能指标。", toolIntent: content }
      : runtimeVersionRead
        ? { route: "tool", answer: "正在读取当前实例的实时服务端实现与 Minecraft 版本。", toolIntent: content }
      : gameruleRead
        ? { route: "tool", answer: `正在读取游戏规则 ${gameruleRead.rule} 的当前值。`, toolIntent: content, preferredTool: "console.command" }
      : configInspectIntent
        ? { route: "tool", answer: "正在只读查询指定配置项。", toolIntent: content, preferredTool: "config.inspect" }
      : consoleCommand
      ? { route: "tool", answer: consoleCommand.startsWith("say ") ? "广播命令已准备，等待确认后执行。" : "控制台命令已准备，等待确认后执行。", toolIntent: content }
      : filesListIntent
        ? { route: "tool", answer: "正在读取插件目录。", toolIntent: filesListIntent, preferredTool: "files.list" }
      : pluginResolveIntent
        ? { route: "tool", answer: "正在核对插件兼容性、可信来源和校验信息。", toolIntent: content, preferredTool: "plugin.resolve" }
      : pluginInstallProject
        ? { route: "tool", answer: `已准备 ${pluginInstallProject} 插件安装计划，等待确认后执行。`, toolIntent: content, preferredTool: "plugin.install" }
      : logQueryIntent && !operationalSkill
        ? { route: "tool", answer: "将读取当前实例日志并依据实际证据分析。", toolIntent: content, preferredTool: "logs.query" }
        : undefined;
    const routeStartedAt = Date.now();
    const legacyCompatibilityEnabled = typeof decideAgentLoop !== "function";
    const compatibilityDecision = legacyCompatibilityEnabled ? deterministicDecision : undefined;
    const naturalFallbackAllowed = !legacyCompatibilityEnabled && !agentLoopDecision
      && operationLanguage === "none" && !operationalSkill && !deterministicDecision;
    const agentUnavailableDecision: ChatDecision | undefined = !legacyCompatibilityEnabled && !agentLoopDecision && !naturalFallbackAllowed
      ? { route: "clarify", answer: "暂时无法启动智能执行流程，因此没有调用任何工具或更改服务器。" }
      : undefined;
    const routeSource = agentLoopDecision ? "ai_loop" : naturalFallbackAllowed ? "model_fallback" : agentUnavailableDecision ? "agent_unavailable" : compatibilityDecision ? "explicit_legacy_compatibility" : "model_fallback";
    this.recordEntryStage("route_selected", entryStartedAt, {
      route_source: routeSource,
      model_calls: agentLoopDecision || agentUnavailableDecision ? 1 : compatibilityDecision ? 0 : 2,
      deterministic_capability: logQueryIntent && !operationalSkill ? "logs.query" : undefined,
    });
    if (!agentLoopDecision && (agentUnavailableDecision ?? compatibilityDecision) && onProgress) {
      onProgress({ type: "delta", text: (agentUnavailableDecision ?? compatibilityDecision)!.answer });
    }
    const rawRoutedDecision = agentLoopDecision ?? agentUnavailableDecision ?? compatibilityDecision ?? (onProgress
      ? await this.modelGateway.routeStream(routeInput, onProgress)
      : await this.modelGateway.route(routeInput));
    const routedDecision: ChatDecision = naturalFallbackAllowed && !["direct", "clarify"].includes(rawRoutedDecision.route)
      ? { route: "clarify", answer: "这条请求可能需要工具，但智能执行流程暂时不可用，因此没有执行任何操作。" }
      : rawRoutedDecision;
    if (routedDecision !== rawRoutedDecision && onProgress) {
      onProgress({ type: "reset" });
      onProgress({ type: "delta", text: routedDecision.answer });
    }
    this.recordEntryStage("route_completed", routeStartedAt, {
      route_source: routeSource,
      model_calls: agentLoopDecision || agentUnavailableDecision ? 1 : compatibilityDecision ? 0 : 2,
      route: routedDecision.route,
    });
    // The durable Agent decision is already the authoritative business route.
    // Reclassifying its original utterance here repeats the legacy planner's job
    // and can turn text transformations or conversation into fake operations.
    // Legacy/model-fallback routes keep the conservative compatibility gate.
    const operationalDecision = lifecycleAlreadySatisfied || agentLoopDecision
      ? routedDecision
      : enforceOperationalRoute(content, routedDecision);
    // Agent final answers were guarded before their first streamed delta. Only
    // fallback decisions need the terminal guard here, avoiding a second pass.
    const needsTerminalDirectGuard = operationalDecision.route === "direct" && !agentLoopDecision;
    const guardedDirectAnswer = needsTerminalDirectGuard ? guardDirectWithoutEvidence(operationalDecision.answer) : undefined;
    const decision = needsTerminalDirectGuard && guardedDirectAnswer !== operationalDecision.answer
      ? { ...operationalDecision, answer: guardedDirectAnswer ?? "我还没有执行，无法确认操作已经完成。" }
      : operationalDecision;
    if (decision !== routedDecision && onProgress) {
      onProgress({ type: "reset" });
      onProgress({ type: "delta", text: decision.answer });
    }
    let taskId: string | undefined;
    let authoritativeTaskAnswer: string | undefined;
    if (decision.route === "tool") {
      const activeBeforeTask = await this.agentRuns.get(pendingAgentRun.run_id, tenantId);
      if (!activeBeforeTask || activeBeforeTask.status === "CANCELLED") {
        throw new NotFoundException("Session was deleted while the request was running");
      }
      const taskStartedAt = Date.now();
      let task: Awaited<ReturnType<TasksService["create"]>>;
      try {
        task = await this.tasks.create({
          tenantId,
          instanceRef: session.instance_ref,
          // The typed semantic compiler must receive the exact user utterance.
          // Model rewrites are advisory routing metadata, never authoritative source text.
          intent: content,
          assistantResponse: decision.answer,
          modelRequestId: decision.requestId,
          modelStatus: "answered",
          sessionId: session.id,
          chainDepth: 0,
          preferredTool: decision.preferredTool,
          agentToolCall: initialAgentToolCall,
        });
      } catch (cause) {
        const validationCode = initialAgentToolCall ? agentToolValidationRejectionCode(cause) : undefined;
        if (!validationCode) throw cause;
        const answer = "请求的工具参数未通过安全校验，因此没有执行或写入任何内容。";
        await this.agentRuns.finish(pendingAgentRun.run_id, "FAILED", {
          code: "AGENT_LOOP_TOOL_VALIDATION_REJECTED", stage: "initial_tool_validation",
          validation_code: validationCode, side_effect: "none",
        });
        const rejectedMessage: ConversationMessage = {
          id: `message_${randomUUID()}`, session_id: session.id, request_id: requestId,
          role: "assistant", content: answer, route: "clarify", task_phase: "completion",
          trace: [{ stage: "review", label: "工具请求已被安全拒绝", result: "未创建任务或执行任何操作" }],
          created_at: new Date().toISOString(),
        };
        list.push(rejectedMessage);
        this.store.messages.set(session.id, list);
        if (session.title === "新会话") session.title = content.replace(/\s+/g, " ").slice(0, 24);
        session.updated_at = rejectedMessage.created_at;
        await this.persist();
        onProgress?.({ type: "reset" });
        onProgress?.({ type: "route", route: "clarify" });
        onProgress?.({ type: "delta", text: answer });
        this.recordEntryStage("task_rejected", taskStartedAt, {
          route_source: routeSource, model_calls: 1, task_created: false,
          validation_rejected: true, side_effect: "none",
        });
        this.recordEntryStage("request_completed", entryStartedAt, {
          route_source: routeSource, model_calls: 1, task_created: false, route: "clarify",
        });
        return { message: rejectedMessage };
      }
      taskId = task.id;
      if (initialAgentToolCall) {
        await this.agentRuns.start(pendingAgentRun.run_id, task.id, {
          id: initialAgentToolCall.toolCallId, key: canonicalAgentToolCallKey(initialAgentToolCall),
          tool: initialAgentToolCall.tool, arguments: initialAgentToolCall.arguments, reason: initialAgentToolCall.reason,
        });
        // Older test doubles and rolling deployments may not expose the new
        // durable approval hook; production TasksService always does.
        await this.tasks.bindAgentApproval?.(pendingAgentRun.run_id, task.id, initialAgentToolCall.toolCallId);
      }
      this.recordEntryStage("task_persisted", taskStartedAt, {
        route_source: routeSource,
        model_calls: agentLoopDecision ? 1 : deterministicDecision ? 1 : 2,
        task_created: true,
        task_state: task.state,
      });
      if (task.state === "WAITING" || task.state === "PARTIAL" || task.state === "FAILED" || task.state === "REJECTED") {
        authoritativeTaskAnswer = task.assistant_response;
      }
    }
    const taskForMessage = taskId ? this.tasks.get(taskId, tenantId) : undefined;
    this.getSession(session.id, tenantId);
    const assistantMessage: ConversationMessage = {
      id: `message_${randomUUID()}`,
      session_id: session.id,
      request_id: requestId,
      role: "assistant",
      content: taskId
        ? safeTaskAnswer(authoritativeTaskAnswer ?? decision.answer, taskForMessage!.state, (taskForMessage!.evidence?.length ?? 0) > 0)
        : safeUserText(decision.answer, "我暂时没能理解这条请求，因此没有执行任何操作。请把要做的事说完整一些。"),
      route: decision.route,
      delegate: decision.delegate,
      task_id: taskId,
      task_phase: taskId ? "request" : undefined,
      trace: decision.trace,
      created_at: new Date().toISOString(),
    };
    list.push(assistantMessage);
    this.store.messages.set(session.id, list);
    if (session.title === "新会话") session.title = content.replace(/\s+/g, " ").slice(0, 24);
    session.updated_at = assistantMessage.created_at;
    await this.persist();
    void this.runBackgroundPass();
    this.recordEntryStage("request_completed", entryStartedAt, {
      route_source: routeSource,
      model_calls: agentLoopDecision ? 1 : deterministicDecision ? 1 : 2,
      task_created: Boolean(taskId),
      route: decision.route,
    });
    return { message: assistantMessage, task: taskId ? this.tasks.get(taskId, tenantId) : undefined };
  }

  private recordEntryStage(stage: string, startedAt: number, fields: Record<string, unknown>) {
    console.info(JSON.stringify({
      event: "mcai_chat_entry_stage",
      stage,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      ...fields,
    }));
  }

  private getSession(sessionId: string, tenantId: string) {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.tenant_id !== tenantId) throw new NotFoundException("Session not found");
    return session;
  }

  private async persist() {
    const data: PersistedChat = {
      sessions: [...this.store.sessions.values()],
      messages: [...this.store.messages.values()].flat(),
    };
    await this.persistence.write(data);
  }
}

function restoreAgentLoopObservations(observations: AgentRunRecord["observations"]): AgentLoopObservation[] | undefined {
  const allowed = new Set<string>(AGENT_LOOP_TOOL_CATALOG.map((entry) => entry.name));
  if (observations.some((observation) => !allowed.has(observation.tool))) return undefined;
  return observations.map((observation) => ({
    ...observation,
    retryable: observation.retryable === true,
    side_effect: observation.side_effect ?? "none",
    tool: observation.tool as AgentLoopObservation["tool"],
  }));
}

function agentToolValidationRejectionCode(cause: unknown) {
  if (!(cause instanceof BadRequestException)) return undefined;
  const match = /^(AGENT_LOOP_[A-Z0-9_]+):/u.exec(cause.message);
  return match?.[1];
}

export function renderReadThenPatchFinal(message: string, observations: AgentLoopObservation[]): string | undefined {
  if (observations.some((item) => item.status !== "succeeded")) return undefined;
  const patched = [...observations].reverse().find((item) => item.tool === "config.patch");
  if (!patched) return undefined;
  const writeData = patched.data as { call_arguments?: { path?: string; patch?: Array<{ op?: string; key?: string; value?: unknown }> } } | undefined;
  const write = writeData?.call_arguments;
  if (!write || !Array.isArray(write.patch) || write.patch.length !== 1 || !write.path) return undefined;
  const change = write.patch[0];
  if (change?.op !== "replace" || !["string", "number", "boolean"].includes(typeof change.value)
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(change.key ?? "")
    || /password|secret|token|api[_-]?key/iu.test(change.key ?? "")) return undefined;
  const inspected = observations.slice(0, observations.indexOf(patched)).reverse().find((item) => item.tool === "config.inspect");
  const readData = inspected?.data as { qa0144_read_result?: { output_schema_id?: string; value?: { path?: string; entries?: Array<{ key?: string; present?: boolean; value?: unknown }> } } } | undefined;
  const read = readData?.qa0144_read_result;
  const before = read?.output_schema_id === "config-inspect-result/v1" && read.value?.path === write.path
    ? read.value.entries?.find((entry) => entry.key === change.key && entry.present === true)
    : undefined;
  const verified = patched.evidence?.summaries?.some((summary) => /Patched .+ verified sha256:/iu.test(summary));
  if (!verified) return undefined;
  const restarted = observations.slice(observations.indexOf(patched) + 1).some((item) => item.tool === "instance.restart");
  const oldValue = before && typeof before.value === "string" ? before.value : undefined;
  return /[\u3400-\u9fff]/u.test(message)
    ? `${oldValue === undefined ? "" : `已读取 ${write.path}：${change.key} 原值为「${oldValue}」。`}已将文件中的 ${change.key} 改为「${String(change.value)}」，写入后校验成功。${restarted ? "实例重启已完成。" : ""}`
    : `${oldValue === undefined ? "" : `Read ${write.path}: ${change.key} was "${oldValue}". `}Changed ${change.key} to "${String(change.value)}" in ${write.path} and verified the write.${restarted ? " The instance restart completed." : ""}`;
}

export function renderPerformanceFinal(message: string, observations: AgentLoopObservation[]): string | undefined {
  if (!/\bTPS\b/iu.test(message) || !/\bCPU\b/iu.test(message) || !/(?:内存|memory)/iu.test(message)
    || observations.some((item) => item.status !== "succeeded")) return undefined;
  const consoleRead = observations.find((item) => item.tool === "console.command"
    && (item.data as { call_arguments?: { command?: string } } | undefined)?.call_arguments?.command === "tps");
  const metricsRead = observations.find((item) => item.tool === "instance.metrics");
  if (!consoleRead || !metricsRead) return undefined;
  const tpsText = consoleRead.evidence.summaries.join("\n");
  const metricsText = metricsRead.evidence.summaries.join("\n");
  const tps = /TPS from last 1m, 5m, 15m:\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)/iu.exec(tpsText);
  const cpu = /\bcpu_percent=([0-9.]+)/iu.exec(metricsText);
  const memory = /\bmemory_bytes=(\d+)/iu.exec(metricsText);
  const limit = /\bmemory_limit_bytes=(\d+)/iu.exec(metricsText);
  if (!tps || !cpu || !memory || !limit) return undefined;
  const samples = tps.slice(1).map(Number);
  const cpuPercent = Number(cpu[1]);
  const usedBytes = Number(memory[1]);
  const limitBytes = Number(limit[1]);
  if (samples.some((value) => !Number.isFinite(value) || value < 0 || value > 20)
    || !Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > 100
    || !Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(limitBytes)
    || usedBytes < 0 || limitBytes <= 0 || usedBytes > limitBytes) return undefined;
  const usedGiB = (usedBytes / 2 ** 30).toFixed(2);
  const limitGiB = (limitBytes / 2 ** 30).toFixed(2);
  const ratio = (100 * usedBytes / limitBytes).toFixed(1);
  return /[\u3400-\u9fff]/u.test(message)
    ? `TPS（1/5/15 分钟）：${samples.map((value) => value.toFixed(1)).join(" / ")}；CPU：${cpuPercent.toFixed(2)}%；内存：${usedGiB} / ${limitGiB} GiB（${ratio}%）。`
    : `TPS (1/5/15 minutes): ${samples.map((value) => value.toFixed(1)).join(" / ")}; CPU: ${cpuPercent.toFixed(2)}%; memory: ${usedGiB} / ${limitGiB} GiB (${ratio}%).`;
}

function renderCompletedWebSearch(message: string, observations: AgentLoopObservation[]): string | undefined {
  const results = observations.flatMap((observation) => {
    if (observation.tool !== "web.search" || observation.status !== "succeeded"
      || !observation.data || typeof observation.data !== "object") return [];
    const projected = (observation.data as { qa0144_read_result?: unknown }).qa0144_read_result;
    if (!projected || typeof projected !== "object"
      || (projected as { output_schema_id?: unknown }).output_schema_id !== "web-search-result/v1") return [];
    const value = (projected as { value?: unknown }).value;
    const entries = value && typeof value === "object" ? (value as { results?: unknown }).results : undefined;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as { title?: unknown; url?: unknown };
      if (typeof candidate.title !== "string" || typeof candidate.url !== "string") return [];
      try {
        const url = new URL(candidate.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") return [];
      } catch { return []; }
      return [{ title: candidate.title.trim(), url: candidate.url }];
    });
  }).filter((item) => item.title && item.url);
  const unique = [...new Map(results.map((item) => [item.url, item])).values()].slice(0, 3);
  if (unique.length === 0) return undefined;
  const chinese = /[\u3400-\u9fff]/u.test(message);
  const sources = unique.map((item) => `- ${item.title}: ${item.url}`).join("\n");
  return chinese
    ? `现有搜索结果摘要不足以可靠确认问题中的具体结论；我不会根据查询词猜测。已检索来源：\n${sources}`
    : `The available search-result snippets are insufficient to confirm the specific conclusion reliably, so I will not infer it from the query. Sources searched:\n${sources}`;
}

export function agentRunBudgetExhausted(run: Pick<AgentRunRecord, "round_count" | "tool_call_count" | "created_at">, now: number) {
  // Slow successful tools must still get a final model turn. Round/call caps
  // bound work, while each gateway call keeps its own strict timeout.
  void now;
  return run.round_count >= AGENT_LOOP_MAX_ROUNDS || run.tool_call_count >= AGENT_LOOP_MAX_TOOL_CALLS;
}

export function transientAgentDecisionError(code: string) {
  return /(?:TIMEOUT|UNAVAILABLE|HTTP_50[234]|DISCONNECTED|TRANSPORT)/iu.test(code);
}

export function canExecuteAgentCall(
  run: Pick<AgentRunRecord, "calls">,
  decision: AgentLoopToolCall,
  observations: AgentLoopObservation[],
) {
  const structuralCodes = new Set(["INVALID_LOG_FILTER_QUERY", "AGENT_LOOP_INVALID_ARGUMENTS"]);
  const sameToolStructuralFailures = observations.filter((item) => item.tool === decision.tool
    && item.status === "failed" && item.side_effect === "none" && structuralCodes.has(item.error?.code ?? ""));
  if (sameToolStructuralFailures.length >= 2) return false;
  const callKey = canonicalAgentToolCallKey(decision);
  const matchingIndexes = run.calls.map((call, index) => call.key === callKey ? index : -1).filter((index) => index >= 0);
  if (matchingIndexes.length === 0) return true;
  const last = matchingIndexes.at(-1)!;
  const priorCall = run.calls[last];
  const priorObservation = observations.find((item) => item.tool_call_id === priorCall?.id);
  return Boolean(priorObservation?.status === "failed" && priorObservation.retryable && priorObservation.side_effect === "none" && matchingIndexes.length === 1);
}

function enforceOperationalRoute(content: string, decision: ChatDecision): ChatDecision {
  const language = classifyOperationalLanguage(content);
  if (language === "none" || (decision.route !== "direct" && decision.route !== "delegate")) return decision;
  return {
    route: "clarify",
    answer: language === "write"
      ? "这是一个会改变服务器状态的操作请求，但当前还没有形成可审批的受控目标和参数，因此没有执行。请补充缺少的目标或参数。"
      : "这是一个需要读取当前实例真实状态的请求，不能用知识回答代替工具结果。请明确要查看的对象。",
    requestId: decision.requestId,
    trace: [
      ...(decision.trace ?? []),
      { stage: "review", label: "操作门禁", result: "拒绝 direct；缺少安全可执行计划", approved: false },
    ],
  };
}
