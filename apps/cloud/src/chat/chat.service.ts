import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConversationMessage, ConversationSession } from "@mcai/contracts";
import { CloudStore } from "../store/cloud.store";
import { ModelGatewayService, type ChatStreamProgress } from "../model-gateway/model-gateway.service";
import { TasksService } from "../tasks/tasks.service";

const defaultSystemPrompt = [
  "你是 MCAI Sidecar 的 Minecraft 运维助手。",
  "简单知识问题直接回答；目标含糊时先追问。",
  "复杂分析可委派诊断或规划子 Agent。",
  "只有需要读取服务器状态或执行操作时才请求受控工具。",
  "不得绕过确认、风险策略或生成任意 Shell。",
].join("\n");

interface PersistedChat {
  sessions: ConversationSession[];
  messages: ConversationMessage[];
}

@Injectable()
export class ChatService implements OnModuleInit {
  private readonly path = join(resolve(process.env.MCAI_CONFIG_DIR ?? join(process.cwd(), ".data", "mcai")), "conversations.json");

  constructor(
    private readonly store: CloudStore,
    private readonly modelGateway: ModelGatewayService,
    private readonly tasks: TasksService,
  ) {}

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
    const session = this.getSession(sessionId, tenantId);
    const list = this.store.messages.get(sessionId) ?? [];
    let changed = false;
    for (const message of [...list]) {
      if (message.role !== "assistant" || !message.task_id || message.task_phase === "completion") continue;
      const alreadyCompleted = list.some((item) => item.task_id === message.task_id && item.task_phase === "completion");
      if (alreadyCompleted) continue;
      let completion;
      try {
        completion = await this.tasks.complete(message.task_id, tenantId);
      } catch (cause) {
        if (cause instanceof NotFoundException) continue;
        throw cause;
      }
      if (!completion) continue;
      const finalMessage: ConversationMessage = {
        id: `message_${randomUUID()}`,
        session_id: session.id,
        role: "assistant",
        content: completion.answer,
        route: "tool",
        task_id: message.task_id,
        task_phase: "completion",
        created_at: new Date().toISOString(),
      };
      list.push(finalMessage);
      session.updated_at = finalMessage.created_at;
      changed = true;
    }
    if (changed) await this.persist();
    return list;
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
    return session;
  }

  async remove(sessionId: string, tenantId: string) {
    this.getSession(sessionId, tenantId);
    this.store.sessions.delete(sessionId);
    this.store.messages.delete(sessionId);
    await this.persist();
    return { deleted: true };
  }

  async send(sessionId: string, tenantId: string, contentInput: string) {
    return this.sendInternal(sessionId, tenantId, contentInput);
  }

  async sendStream(sessionId: string, tenantId: string, contentInput: string, onProgress: (event: ChatStreamProgress) => void) {
    return this.sendInternal(sessionId, tenantId, contentInput, onProgress);
  }

  private async sendInternal(sessionId: string, tenantId: string, contentInput: string, onProgress?: (event: ChatStreamProgress) => void) {
    const session = this.getSession(sessionId, tenantId);
    const content = contentInput.trim();
    if (!content || content.length > 4_000) throw new BadRequestException("消息需要 1-4000 个字符");
    const instance = this.store.instances.get(session.instance_ref);
    if (!instance || instance.tenant_id !== tenantId) throw new NotFoundException("Instance not found");
    const list = this.store.messages.get(session.id) ?? [];
    const userMessage: ConversationMessage = {
      id: `message_${randomUUID()}`,
      session_id: session.id,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    list.push(userMessage);
    const routeInput = {
      message: content,
      systemPrompt: session.system_prompt,
      history: list.slice(0, -1),
      instance,
    };
    const decision = onProgress
      ? await this.modelGateway.routeStream(routeInput, onProgress)
      : await this.modelGateway.route(routeInput);
    let taskId: string | undefined;
    if (decision.route === "tool") {
      const normalizedIntent = decision.toolIntent?.trim();
      const task = await this.tasks.create({
        tenantId,
        instanceRef: session.instance_ref,
        // Preserve exact user authorization and version constraints when the model normalizes an operation.
        intent: normalizedIntent && normalizedIntent !== content ? `${content}\n\nAgent operation: ${normalizedIntent}` : content,
        assistantResponse: decision.answer,
        modelRequestId: decision.requestId,
        modelStatus: "answered",
      });
      taskId = task.id;
    }
    const assistantMessage: ConversationMessage = {
      id: `message_${randomUUID()}`,
      session_id: session.id,
      role: "assistant",
      content: decision.answer,
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
    return { message: assistantMessage, task: taskId ? this.tasks.get(taskId, tenantId) : undefined };
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
    await mkdir(resolve(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
