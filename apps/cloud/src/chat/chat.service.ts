import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConversationMessage, ConversationSession } from "@mcai/contracts";
import { CloudStore } from "../store/cloud.store";
import { ModelGatewayService, type ChatDecision, type ChatStreamProgress } from "../model-gateway/model-gateway.service";
import { TasksService } from "../tasks/tasks.service";
import {
  expandOperationalSkill,
  extractConsoleCommandIntent,
  extractFilesListIntent,
  extractRealtimeLogIntent,
} from "../tasks/planner";

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

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatService.name);
  private loopTimer?: ReturnType<typeof setInterval>;
  private loopTick?: Promise<void>;
  private readonly advances = new Map<string, Promise<ConversationMessage[]>>();
  private persistence: Promise<void> = Promise.resolve();
  private readonly path = join(resolve(process.env.MCAI_CONFIG_DIR ?? join(process.cwd(), ".data", "mcai")), "conversations.json");
  private readonly pendingSends = new Map<string, Promise<{ message: ConversationMessage; task?: ReturnType<TasksService["get"]> }>>();
  private readonly pendingCompletions = new Map<string, ReturnType<TasksService["complete"]>>();

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
    this.loopTimer = setInterval(() => { void this.runAgentLoop(); }, 1_000);
    this.loopTimer.unref();
  }

  async onModuleDestroy() {
    if (this.loopTimer) clearInterval(this.loopTimer);
    await this.loopTick;
    await Promise.allSettled([...this.advances.values()]);
    await this.persistence;
  }

  /** Drive result -> model -> next controlled task even with no browser polling. */
  async runAgentLoop() {
    if (this.loopTick) return this.loopTick;
    const tick = async () => {
      await Promise.all([...this.store.sessions.values()].map(async (session) => {
        try {
          await this.messages(session.id, session.tenant_id);
        } catch {
          this.logger.error(`Agent loop could not advance session ${session.id}; will retry`);
        }
      }));
    };
    this.loopTick = tick();
    try { await this.loopTick; } finally { this.loopTick = undefined; }
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
    const pending = this.advances.get(sessionId);
    if (pending) return pending;
    const operation = this.advanceSession(sessionId, tenantId);
    this.advances.set(sessionId, operation);
    try { return await operation; } finally { this.advances.delete(sessionId); }
  }

  private async advanceSession(sessionId: string, tenantId: string) {
    const session = this.getSession(sessionId, tenantId);
    const list = this.store.messages.get(sessionId) ?? [];
    let changed = false;
    // New requests appended below are observed in this pass; active tasks yield
    // until the next callback/tick. Depth limits bound immediately completed chains.
    for (const message of list) {
      if (message.role !== "assistant" || !message.task_id || message.task_phase === "completion") continue;
      const alreadyCompleted = list.some((item) => item.task_id === message.task_id && item.task_phase === "completion");
      if (alreadyCompleted) continue;
      let completion;
      try {
        completion = await this.completeTask(message.task_id, tenantId);
      } catch (cause) {
        if (cause instanceof NotFoundException) continue;
        throw cause;
      }
      if (!completion) continue;
      if (this.store.sessions.get(sessionId) !== session) return list;
      if (list.some((item) => item.task_id === message.task_id && item.task_phase === "completion")) continue;
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
      const parentTask = this.tasks.get(message.task_id, tenantId);
      const continuation = completion.continuation;
      const nextDepth = (parentTask.chain_depth ?? 0) + 1;
      const stopReason = continuation ? this.continuationStop(parentTask, continuation.intent, continuation.preferred_tool, nextDepth) : undefined;
      if (stopReason) finalMessage.content += `\n\n${stopReason}`;
      if (continuation && !stopReason) {
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
        list.push(finalMessage, requestMessage);
        session.updated_at = requestMessage.created_at;
      } else {
        list.push(finalMessage);
        session.updated_at = finalMessage.created_at;
      }
      changed = true;
    }
    if (changed) await this.persist();
    return list;
  }

  private continuationStop(task: ReturnType<TasksService["get"]>, intent: string, tool: string | undefined, depth: number) {
    if (task.state !== "SUCCEEDED") return "本轮任务未成功，Agent 循环已停止；请检查执行结果后再重试。";
    if (depth > maxContinuationDepth) return "已达到自动执行上限（初始任务加 6 轮后续任务），Agent 循环已停止。";
    const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
    let ancestor: typeof task | undefined = task;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (ancestor.tenant_id !== task.tenant_id || ancestor.session_id !== task.session_id) break;
      if (normalize(ancestor.intent ?? "") === normalize(intent) && ancestor.plan?.steps.some((step) => step.tool === tool)) {
        return "检测到重复工具请求，Agent 循环已停止，避免反复执行同一操作。";
      }
      ancestor = ancestor.parent_task_id ? this.store.tasks.get(ancestor.parent_task_id) : undefined;
    }
    return undefined;
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
    return session;
  }

  async remove(sessionId: string, tenantId: string) {
    this.getSession(sessionId, tenantId);
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
    const routeInput = {
      sessionId: session.id,
      message: content,
      systemPrompt: session.system_prompt,
      history: list.filter((message) => message.id !== userMessage.id),
      instance,
    };
    const consoleCommand = extractConsoleCommandIntent(content);
    const filesListIntent = extractFilesListIntent(content);
    const realtimeLogIntent = extractRealtimeLogIntent(content);
    const operationalSkill = expandOperationalSkill(content);
    const deterministicDecision: ChatDecision | undefined = consoleCommand
      ? { route: "tool", answer: "控制台命令已提交。", toolIntent: content }
      : filesListIntent
        ? { route: "tool", answer: "正在读取插件目录。", toolIntent: filesListIntent, preferredTool: "files.list" }
      : realtimeLogIntent && !operationalSkill
        ? { route: "tool", answer: "将读取当前实例日志并依据实际证据分析。", toolIntent: realtimeLogIntent }
        : undefined;
    if (deterministicDecision && onProgress) {
      onProgress({ type: "delta", text: deterministicDecision.answer });
    }
    const decision = deterministicDecision ?? (onProgress
      ? await this.modelGateway.routeStream(routeInput, onProgress)
      : await this.modelGateway.route(routeInput));
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
        sessionId: session.id,
        chainDepth: 0,
        preferredTool: decision.preferredTool,
      });
      taskId = task.id;
    }
    const assistantMessage: ConversationMessage = {
      id: `message_${randomUUID()}`,
      session_id: session.id,
      request_id: requestId,
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
    const operation = this.persistence.then(() => this.writeArchive());
    this.persistence = operation.catch(() => {});
    return operation;
  }

  private async writeArchive() {
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
