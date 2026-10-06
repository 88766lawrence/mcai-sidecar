import { Injectable } from "@nestjs/common";
import type { ChatRoute, ConversationMessage, IntentCandidateV2, IntentSemanticFrameBatch, IntentSourceCatalog, ServerProfile, TaskRecord } from "@mcai/contracts";
import { buildIntentSemanticFramePlan, INTENT_CAPABILITIES, mergeIntentSemanticFrames, type IntentIRValidationError } from "../tasks/intent-ir";
import { validateConfirmedWriteWireShape, type ConfirmedWriteProposalDecision } from "../tasks/confirmed-write-proposal";
import { AGENT_LOOP_MAX_ROUNDS, AGENT_LOOP_MAX_TOOL_CALLS, AGENT_LOOP_TOOL_CATALOG, validateAgentLoopDecision, type AgentLoopDecision, type AgentLoopObservation } from "../chat/agent-loop";
import { hasObservedWebLinks } from "../tasks/qa0144-read-observation";

interface GatewayResponse {
  status: "answered" | "unconfigured" | "unavailable";
  requestId: string;
  answer: string;
  continuation?: ChatDecision;
}

export interface ChatDecision {
  route: ChatRoute;
  answer: string;
  delegate?: string;
  toolIntent?: string;
  preferredTool?: string;
  requestId?: string;
  trace?: ConversationMessage["trace"];
}

export type ChatStreamProgress =
  | { type: "status"; stage: "understanding" | "routing" | "planning"; text: string }
  | { type: "route"; route: ChatRoute }
  | { type: "delta"; text: string }
  | { type: "reset" };

type ModelChatStreamEvent = ChatStreamProgress
  | { type: "done"; decision: ChatDecision }
  | { type: "error"; message?: string };

interface IntentCompileWireResponse {
  semanticFrames?: IntentSemanticFrameBatch[];
  requestId?: string;
  providerModel?: string;
  compilerMetrics?: Record<string, unknown>;
  repairUsed?: boolean;
  detail?: {
    code?: string; requestId?: string; provider?: string; httpStatus?: number;
    compilerMetrics?: Record<string, unknown>; repairUsed?: boolean;
  } | string;
}

interface ConfirmedWriteProposalWireResponse {
  proposal?: unknown;
  requestId?: string;
  providerModel?: string;
  proposalMetrics?: Record<string, unknown>;
  repairUsed?: boolean;
  detail?: { code?: string; requestId?: string; provider?: string; httpStatus?: number; proposalMetrics?: Record<string, unknown>; repairUsed?: boolean } | string;
}

@Injectable()
export class ModelGatewayService {
  private readonly url = process.env.MCAI_MODEL_GATEWAY_URL ?? "http://127.0.0.1:4200";
  private readonly token = process.env.MCAI_MODEL_GATEWAY_TOKEN ?? "";

  async decideAgentLoop(input: {
    sessionId: string;
    message: string;
    systemPrompt: string;
    history: ConversationMessage[];
    instance: ServerProfile;
    observations?: AgentLoopObservation[];
    round?: number;
  }): Promise<{ status: "answered"; decision: AgentLoopDecision; requestId: string; providerModel?: string; repairUsed?: boolean } | { status: "unconfigured" | "unavailable"; error: string }> {
    if (!this.token) return { status: "unconfigured", error: "MODEL_GATEWAY_UNCONFIGURED" };
    try {
      const response = await fetch(new URL("/v1/agent-loop/decide", this.url), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: input.sessionId,
          message: input.message,
          systemPrompt: input.systemPrompt,
          history: agentLoopHistory(input.history),
          instance: {
            id: input.instance.instance_id, name: input.instance.name, platform: input.instance.platform,
            minecraftVersion: input.instance.minecraft_version, loader: input.instance.loader, state: input.instance.state,
          },
          toolCatalog: AGENT_LOOP_TOOL_CATALOG,
          observations: input.observations ?? [],
          round: input.round ?? 1,
          limits: { maxRounds: AGENT_LOOP_MAX_ROUNDS, maxToolCalls: AGENT_LOOP_MAX_TOOL_CALLS },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || !body) {
        const detail = body?.detail;
        const detailCode = detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).code === "string"
          ? String((detail as Record<string, unknown>).code)
          : "";
        return { status: "unavailable", error: detailCode || `AGENT_LOOP_HTTP_${response.status}` };
      }
      const rawDecision = body.decision && typeof body.decision === "object" && !Array.isArray(body.decision)
        ? body.decision as Record<string, unknown> : undefined;
      const userFacingDecision: Record<string, unknown> | undefined = rawDecision
        && ["final", "cannot_proceed"].includes(String(rawDecision.action))
        && typeof rawDecision.answer === "string"
        ? { ...rawDecision, answer: projectAgentUserAnswer(rawDecision.answer) }
        : rawDecision;
      const groundedAnswer = userFacingDecision?.action === "final"
        && typeof userFacingDecision.answer === "string"
        && hasObservedWebLinks(userFacingDecision.answer, input.observations ?? [])
        ? userFacingDecision.answer : undefined;
      const decisionForValidation = groundedAnswer
        ? { ...(userFacingDecision ?? {}), answer: groundedAnswer.replace(/https?:\/\/\S+/giu, "source-link") }
        : userFacingDecision;
      const checked = validateAgentLoopDecision(decisionForValidation, input.observations?.length
        ? input.observations.filter((item) => item.status === "succeeded").map((item) => item.tool_call_id)
        : undefined);
      if (!checked.ok) return { status: "unavailable", error: checked.code };
      if (groundedAnswer && checked.value.action === "final") checked.value.answer = groundedAnswer;
      return {
        status: "answered", decision: checked.value,
        requestId: typeof body.requestId === "string" ? body.requestId : `agent-loop-${Date.now()}`,
        providerModel: typeof body.providerModel === "string" ? body.providerModel : undefined,
        repairUsed: body.repairUsed === true,
      };
    } catch (error) {
      const code = error instanceof DOMException && error.name === "TimeoutError" ? "AGENT_LOOP_PROVIDER_TIMEOUT" : "AGENT_LOOP_UNAVAILABLE";
      return { status: "unavailable", error: code };
    }
  }

  async proposeConfirmedWrite(input: { intent: string; instance: ServerProfile }): Promise<{
    status: "answered"; proposal: ConfirmedWriteProposalDecision; requestId: string; providerModel: string; proposalMetrics?: Record<string, unknown>; repairUsed?: boolean;
  } | { status: "unconfigured" | "unavailable"; error: string; requestId?: string; providerModel?: string; httpStatus?: number; proposalMetrics?: Record<string, unknown>; repairUsed?: boolean }> {
    if (!this.token) return { status: "unconfigured", error: "MODEL_GATEWAY_UNCONFIGURED" };
    try {
      const response = await fetch(new URL("/v1/confirmed-write/propose", this.url), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          intent: input.intent,
          instanceContext: { name: input.instance.name, platform: input.instance.platform, minecraftVersion: input.instance.minecraft_version, loader: input.instance.loader, state: input.instance.state },
          allowedTools: ["console.command"],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      let body: ConfirmedWriteProposalWireResponse | null = null;
      try { body = await response.json() as ConfirmedWriteProposalWireResponse; } catch { return { status: "unavailable", error: "WRITE_PROPOSAL_INVALID_JSON", httpStatus: response.status }; }
      if (!response.ok) {
        const detail = typeof body?.detail === "object" ? body.detail : undefined;
        return { status: "unavailable", error: detail?.code ?? `WRITE_PROPOSAL_HTTP_${response.status}`, requestId: detail?.requestId, providerModel: detail?.provider, httpStatus: detail?.httpStatus ?? response.status, proposalMetrics: redactProposalMetrics(detail?.proposalMetrics), repairUsed: detail?.repairUsed };
      }
      const checked = validateConfirmedWriteWireShape(body?.proposal);
      if (!checked.ok || !body?.requestId || !body.providerModel) return { status: "unavailable", error: checked.ok ? "WRITE_PROPOSAL_INVALID_RESPONSE" : checked.code, httpStatus: response.status, proposalMetrics: redactProposalMetrics(body?.proposalMetrics), repairUsed: body?.repairUsed };
      return { status: "answered", proposal: checked.value, requestId: body.requestId, providerModel: body.providerModel, proposalMetrics: redactProposalMetrics(body.proposalMetrics), repairUsed: body.repairUsed };
    } catch (error) {
      const code = error instanceof DOMException && error.name === "TimeoutError" ? "WRITE_PROPOSAL_PROVIDER_TIMEOUT" : error instanceof TypeError ? "WRITE_PROPOSAL_NETWORK_ERROR" : "WRITE_PROPOSAL_UNAVAILABLE";
      return { status: "unavailable", error: code };
    }
  }

  async answer(task: TaskRecord, instance: ServerProfile) {
    if (!this.token) {
      return {
        status: "unconfigured" as const,
        answer: "本地模型云尚未完成服务令牌配置。任务计划已由安全规划器生成，但暂时无法生成 AI 回答。",
      };
    }
    try {
      const response = await fetch(new URL("/v1/respond", this.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          intent: task.intent,
          threadId: task.session_id,
          sessionId: task.session_id,
          taskId: task.id,
          parentTaskId: task.parent_task_id,
          chainDepth: task.chain_depth ?? 0,
          instance: {
            id: instance.instance_id,
            name: instance.name,
            platform: instance.platform,
            minecraftVersion: instance.minecraft_version,
            loader: instance.loader,
            state: instance.state,
            profileRevision: instance.profile_revision,
          },
          plan: {
            risk: task.risk,
            operation: task.plan.operation,
            intentIR: task.plan.intent_ir,
            intentIRDigest: task.plan.intent_ir_digest,
            steps: task.plan.steps.map((step) => ({
              tool: step.tool,
              args: step.args,
              risk: step.risk,
              purpose: step.purpose ?? "execute",
              requiresConfirmation: Boolean(step.requires_confirmation),
            })),
            acceptance: task.plan.acceptance,
            sourceGoals: task.plan.source_goals,
            sourceGoalDigest: task.plan.source_goal_digest,
            goalRequirements: task.plan.goal_requirements,
            coverage: task.plan.coverage,
            evidencePolicy: task.plan.evidence_policy,
            responsePolicy: task.plan.response_policy,
          },
          taskState: task.state,
          goalStatuses: task.goal_statuses,
          goalResults: task.goal_results,
          evidence: task.evidence.slice(-100),
          responseMode: "task_completion",
        }),
        signal: AbortSignal.timeout(50_000),
      });
      const body = await response.json().catch(() => null) as GatewayResponse | null;
      if (!response.ok || !body?.answer) throw new Error(`MODEL_GATEWAY_${response.status}`);
      const continuation = validContinuation(body.continuation) ? body.continuation : undefined;
      return { status: body.status, answer: body.answer, requestId: body.requestId, continuation };
    } catch {
      return {
        status: "unavailable" as const,
        answer: "本地模型云暂时不可用。安全任务仍会按受控计划执行，请稍后检查模型云服务状态。",
      };
    }
  }

  async compileIntent(input: {
    sourceCatalog: IntentSourceCatalog;
    instance: ServerProfile;
    attempt: 1 | 2;
    previousCandidate?: IntentCandidateV2;
    validationErrors?: IntentIRValidationError[];
  }): Promise<{ status: "answered"; candidate: IntentCandidateV2; requestId: string; providerModel: string; compilerMetrics?: Record<string, unknown>; repairUsed?: boolean } | {
    status: "unconfigured" | "unavailable"; error: string; requestId?: string; providerModel?: string; httpStatus?: number;
    compilerMetrics?: Record<string, unknown>; repairUsed?: boolean;
  }> {
    if (!this.token) return { status: "unconfigured", error: "MODEL_GATEWAY_UNCONFIGURED" };
    try {
      const framePlan = buildIntentSemanticFramePlan(input.sourceCatalog);
      const response = await fetch(new URL("/v1/intent/compile", this.url), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          sourceCatalog: input.sourceCatalog,
          framePlan,
          attempt: input.attempt,
          instance: {
            id: input.instance.instance_id, name: input.instance.name, platform: input.instance.platform,
            minecraftVersion: input.instance.minecraft_version, loader: input.instance.loader, state: input.instance.state,
          },
          capabilities: Object.entries(INTENT_CAPABILITIES).map(([id, capability]) => ({
            id, domain: capability.domain, resultKinds: capability.resultKinds, parameters: capability.parameters,
            requiredParameters: capability.requiredParameters ?? [], description: capability.description ?? "",
            semantics: capability.semantics ?? {}, scope: capability.scope ?? {}, fixed: capability.fixed ?? {},
          })),
          ...(input.previousCandidate ? { previousCandidate: input.previousCandidate } : {}),
          ...(input.validationErrors?.length ? { validationErrors: input.validationErrors.slice(0, 24).map(({ code, path }) => ({ code, path })) } : {}),
        }),
        signal: AbortSignal.timeout(35_000),
      });
      let body: IntentCompileWireResponse | null = null;
      try { body = await response.json() as IntentCompileWireResponse; } catch {
        return { status: "unavailable", error: "MODEL_GATEWAY_INVALID_JSON", httpStatus: response.status };
      }
      if (!response.ok) {
        const detail = typeof body?.detail === "object" ? body.detail : undefined;
        const code = detail?.code ?? `MODEL_GATEWAY_HTTP_${response.status}`;
        const compilerMetrics = redactedCompilerMetrics(detail?.requestId ?? "unknown", detail?.provider ?? "unknown", detail?.compilerMetrics);
        const result = {
          status: "unavailable" as const, error: code, requestId: detail?.requestId, providerModel: detail?.provider,
          httpStatus: detail?.httpStatus ?? response.status, compilerMetrics, repairUsed: detail?.repairUsed,
        };
        console.info("[model-gateway] intent compiler failure", JSON.stringify({ ...compilerMetrics, http_status: result.httpStatus, repair_used: result.repairUsed, terminal_code: code }));
        return result;
      }
      if (!body?.semanticFrames || !body.requestId || !body.providerModel) return { status: "unavailable", error: "INTENT_COMPILER_INVALID_RESPONSE", httpStatus: response.status };
      const merged = mergeIntentSemanticFrames(input.sourceCatalog, framePlan, body.semanticFrames);
      if (!merged.ok) {
        const code = merged.errors[0]?.code ?? "INTENT_SEMANTIC_FRAME_MERGE_ERROR";
        const compilerMetrics = { ...redactedCompilerMetrics(body.requestId, body.providerModel, body.compilerMetrics), terminal_code: code };
        console.info("[model-gateway] intent compiler failure", JSON.stringify(compilerMetrics));
        return { status: "unavailable", error: code, requestId: body.requestId, providerModel: body.providerModel, httpStatus: response.status, compilerMetrics, repairUsed: body.repairUsed };
      }
      const compilerMetrics = { ...(body.compilerMetrics ?? {}), catalog_ref_count: input.sourceCatalog.refs.length };
      console.info("[model-gateway] intent compiler metrics", JSON.stringify(redactedCompilerMetrics(body.requestId, body.providerModel, compilerMetrics)));
      return { status: "answered", candidate: merged.candidate, requestId: body.requestId, providerModel: body.providerModel, compilerMetrics, repairUsed: body.repairUsed };
    } catch (error) {
      console.error("[model-gateway] intent compilation failed:", error instanceof Error ? error.message : "unknown error");
      const code = error instanceof DOMException && error.name === "TimeoutError"
        ? "MODEL_GATEWAY_CLIENT_TIMEOUT"
        : error instanceof TypeError ? "MODEL_GATEWAY_NETWORK_ERROR" : "MODEL_GATEWAY_UNAVAILABLE";
      return { status: "unavailable", error: code };
    }
  }

  recordIntentCompilerTerminal(input: { requestId: string; providerModel: string; compilerMetrics?: Record<string, unknown>; code: string; repairUsed: boolean; candidateCount?: number }) {
    console.info("[model-gateway] intent compiler terminal", JSON.stringify({
      ...redactedCompilerMetrics(input.requestId, input.providerModel, input.compilerMetrics),
      terminal_code: input.code,
      repair_used: input.repairUsed,
      candidate_count: input.candidateCount ?? 0,
    }));
  }

  async decideRecovery(task: TaskRecord, instance: ServerProfile, failure: string) {
    if (!this.token) return "模型云未配置；请检查失败证据后再决定重试、回滚或人工处理。";
    try {
      const response = await fetch(new URL("/v1/respond", this.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          intent: task.intent,
          instance,
          plan: task.plan,
          taskState: task.state,
          failure,
          evidence: task.evidence.slice(-8),
          responseMode: "recovery_decision",
        }),
        signal: AbortSignal.timeout(50_000),
      });
      const body = await response.json().catch(() => null) as GatewayResponse | null;
      if (!response.ok || !body?.answer) throw new Error(`MODEL_GATEWAY_${response.status}`);
      return body.answer.trim().slice(0, 500);
    } catch {
      return "自动恢复决策暂时不可用；已保留失败证据，请人工检查后再重试。";
    }
  }

  async route(input: {
    sessionId: string;
    message: string;
    systemPrompt: string;
    history: ConversationMessage[];
    instance: ServerProfile;
  }): Promise<ChatDecision> {
    if (!this.token) {
      return { route: "direct", answer: "本地模型云尚未配置，暂时无法回答。" };
    }
    try {
      const response = await fetch(new URL("/v1/chat", this.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(chatPayload(input)),
        signal: AbortSignal.timeout(180_000),
      });
      const body = await response.json().catch(() => null) as ChatDecision | null;
      if (!response.ok || !body?.answer || !["direct", "clarify", "delegate", "tool"].includes(body.route)) {
        throw new Error(`MODEL_GATEWAY_${response.status}`);
      }
      return body;
    } catch (error) {
      console.error("[model-gateway] chat route failed:", error instanceof Error ? error.message : "unknown error");
      return {
        route: "direct",
        answer: "模型云暂时不可用。你可以稍后重试；现有 Agent 与任务执行不受影响。",
      };
    }
  }

  async routeStream(input: {
    sessionId: string;
    message: string;
    systemPrompt: string;
    history: ConversationMessage[];
    instance: ServerProfile;
  }, onProgress: (event: ChatStreamProgress) => void): Promise<ChatDecision> {
    if (!this.token) {
      const decision = { route: "direct" as const, answer: "本地模型云尚未配置，暂时无法回答。" };
      onProgress({ type: "delta", text: decision.answer });
      return decision;
    }
    try {
      const response = await fetch(new URL("/v1/chat/stream", this.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(chatPayload(input)),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body) throw new Error(`MODEL_GATEWAY_${response.status}`);

      let decision: ChatDecision | undefined;
      await readNdjson(response.body, (event) => {
        if (event.type === "route" && ["direct", "clarify", "delegate", "tool"].includes(event.route)) onProgress(event);
        else if (event.type === "delta" && typeof event.text === "string") onProgress(event);
        else if (event.type === "reset") onProgress(event);
        else if (event.type === "done") decision = event.decision;
        else if (event.type === "error") throw new Error("MODEL_GATEWAY_STREAM");
      });
      if (!decision || !decision.answer || !["direct", "clarify", "delegate", "tool"].includes(decision.route)) {
        throw new Error("MODEL_GATEWAY_STREAM_INVALID");
      }
      return decision;
    } catch (error) {
      console.error("[model-gateway] chat stream failed:", error instanceof Error ? error.message : "unknown error");
      const decision = {
        route: "direct" as const,
        answer: "模型云暂时不可用。你可以稍后重试；现有 Agent 与任务执行不受影响。",
      };
      onProgress({ type: "reset" });
      onProgress({ type: "delta", text: decision.answer });
      return decision;
    }
  }
}

function redactedCompilerMetrics(requestId: string, providerModel: string, metrics: Record<string, unknown> | undefined) {
  const allowed = ["mode", "attempt", "provider_ms", "parse_ms", "validate_ms", "total_ms", "input_chars", "prompt_chars", "schema_chars", "output_chars", "input_token_estimate", "prompt_token_estimate", "schema_token_estimate", "output_token_estimate", "catalog_ref_count", "candidate_clause_count", "candidate_goal_count", "frame_count", "shard_count", "provider_call_count", "cancelled_shard_count", "completed_shard_count", "max_concurrency", "max_provider_calls", "deadline_ms", "repair_reason", "terminal_code", "cancelled"];
  return Object.fromEntries([
    ["request_id", requestId], ["provider", providerModel],
    ...allowed.filter((key) => metrics?.[key] !== undefined).map((key) => [key, metrics?.[key]]),
  ]);
}

function redactProposalMetrics(metrics: Record<string, unknown> | undefined) {
  const allowed = ["mode", "attempt", "provider_ms", "parse_ms", "validate_ms", "total_ms", "input_chars", "prompt_chars", "schema_chars", "output_chars", "input_token_estimate", "prompt_token_estimate", "schema_token_estimate", "output_token_estimate", "repair_reason", "repair_used", "terminal_code"];
  return Object.fromEntries(allowed.filter((key) => metrics?.[key] !== undefined).map((key) => [key, metrics?.[key]]));
}

const agentLoopHistoryMaxItems = 40;
const agentLoopHistoryMaxChars = 48_000;
const agentLoopHistoryItemMaxChars = 4_000;

function agentLoopHistory(history: ConversationMessage[]) {
  const retained = history
    .filter((message) => !message.task_id || message.task_phase === "completion")
    .slice(-agentLoopHistoryMaxItems);
  const itemBudget = Math.min(
    agentLoopHistoryItemMaxChars,
    Math.floor(agentLoopHistoryMaxChars / Math.max(1, retained.length)),
  );
  return retained.map(({ role, content }) => ({
    role,
    content: compactAgentLoopHistoryContent(content, itemBudget),
  }));
}

function compactAgentLoopHistoryContent(content: string, limit: number) {
  const text = content.trim();
  if (!text || limit <= 0 || text.length <= limit) return text;
  const marker = "\n…[历史内容已压缩]…\n";
  if (limit <= marker.length + 2) return text.slice(0, limit);
  const head = Math.max(1, Math.floor((limit - marker.length) / 2));
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

const agentLoopUserToolLabels: Record<string, string> = {
  "console.command": "服务器指令",
  "config.inspect": "配置读取",
  "files.list": "目录读取",
  "logs.query": "日志查询",
  "instance.metrics": "性能读取",
  "players.inspect": "玩家状态读取",
  "plugin.resolve": "插件信息查询",
  "web.search": "网页搜索",
  "file.download": "文件下载",
  "config.patch": "配置修改",
  "plugin.install": "插件安装",
  "instance.start": "实例启动",
  "instance.stop": "实例停止",
  "instance.restart": "实例重启",
};

function projectAgentUserAnswer(answer: string) {
  return AGENT_LOOP_TOOL_CATALOG.reduce((projected, entry) => {
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return projected.replace(
      new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`, "giu"),
      `$1${agentLoopUserToolLabels[entry.name] ?? "受控工具"}`,
    );
  }, answer);
}

function chatPayload(input: {
  sessionId: string;
  message: string;
  systemPrompt: string;
  history: ConversationMessage[];
  instance: ServerProfile;
}) {
  return {
    threadId: input.sessionId,
    sessionId: input.sessionId,
    message: input.message,
    systemPrompt: input.systemPrompt,
    history: input.history.slice(-12).map(({ role, content }) => ({ role, content })),
    instance: {
      id: input.instance.instance_id,
      name: input.instance.name,
      platform: input.instance.platform,
      minecraftVersion: input.instance.minecraft_version,
      loader: input.instance.loader,
      state: input.instance.state,
    },
    availableTools: [
      "logs.query",
      "files.list",
      "server.install",
      "config.inspect",
      "config.patch",
      "plugin.resolve",
      "plugin.install",
      "web.search",
      "file.download",
      "players.inspect",
      "console.command",
      "instance.start",
      "instance.stop",
      "instance.restart",
    ],
  };
}

const controlledTools = new Set([
  "logs.query", "files.list", "server.install", "config.inspect", "config.patch", "plugin.resolve",
  "plugin.install", "web.search", "file.download", "players.inspect", "console.command", "instance.start", "instance.stop", "instance.restart",
]);

function validContinuation(value: ChatDecision | undefined): value is ChatDecision & { route: "tool"; toolIntent: string } {
  return Boolean(
    value
    && value.route === "tool"
    && typeof value.toolIntent === "string"
    && value.toolIntent.trim()
    && typeof value.preferredTool === "string"
    && controlledTools.has(value.preferredTool),
  );
}

async function readNdjson(stream: ReadableStream<Uint8Array>, onEvent: (event: ModelChatStreamEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as ModelChatStreamEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as ModelChatStreamEvent);
}
