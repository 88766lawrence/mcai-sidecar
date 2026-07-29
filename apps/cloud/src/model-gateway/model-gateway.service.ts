import { Injectable } from "@nestjs/common";
import type { ChatRoute, ConversationMessage, ServerProfile, TaskRecord } from "@mcai/contracts";

interface GatewayResponse {
  status: "answered" | "unconfigured";
  requestId: string;
  answer: string;
}

export interface ChatDecision {
  route: ChatRoute;
  answer: string;
  delegate?: string;
  toolIntent?: string;
  requestId?: string;
  trace?: ConversationMessage["trace"];
}

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
      return { status: body.status, answer: body.answer, requestId: body.requestId };
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
        body: JSON.stringify({
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
            "instance.start",
            "instance.restart",
          ],
        }),
        signal: AbortSignal.timeout(240_000),
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
}
