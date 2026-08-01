import { Injectable } from "@nestjs/common";
import type { ChatRoute, ConversationMessage, ServerProfile, TaskRecord } from "@mcai/contracts";

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
  | { type: "delta"; text: string }
  | { type: "reset" };

type ModelChatStreamEvent = ChatStreamProgress
  | { type: "done"; decision: ChatDecision }
  | { type: "error"; message?: string };

@Injectable()
export class ModelGatewayService {
  private readonly url = process.env.MCAI_MODEL_GATEWAY_URL ?? "http://127.0.0.1:4200";
  private readonly token = process.env.MCAI_MODEL_GATEWAY_TOKEN ?? "";

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
            steps: task.plan.steps.map((step) => ({
              tool: step.tool,
              risk: step.risk,
              requiresConfirmation: Boolean(step.requires_confirmation),
            })),
            acceptance: task.plan.acceptance,
          },
          taskState: task.state,
          evidence: task.evidence.slice(-12),
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
        if (event.type === "delta" && typeof event.text === "string") onProgress(event);
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
      "config.patch",
      "plugin.resolve",
      "plugin.install",
      "console.command",
      "instance.start",
      "instance.stop",
      "instance.restart",
    ],
  };
}

const controlledTools = new Set([
  "logs.query", "files.list", "server.install", "config.patch", "plugin.resolve",
  "plugin.install", "console.command", "instance.start", "instance.stop", "instance.restart",
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
