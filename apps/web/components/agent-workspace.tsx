"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  AlertTriangle, Bot, CheckCircle2, ChevronDown, CircleAlert, ClipboardCheck,
  Cloud, FileClock, LoaderCircle, LogOut, Menu, MessageSquare,
  Plus, RefreshCw, RotateCcw, Send, Server, Settings2, ShieldCheck, Sparkles, Square,
  Trash2, UserRound, Wrench, X,
} from "lucide-react";
import type {
  ChatRoute, ConversationMessage, ConversationSession, ConversationStreamEvent, ServerProfile, TaskRecord,
} from "@mcai/contracts";
import { api, apiStream } from "../lib/api";

type Agent = { id: string; displayName: string; status: "online" | "offline" | "pending"; version: string; lastSeen: string };

gsap.registerPlugin(useGSAP);

export function AgentWorkspace({ onLogout }: { onLogout: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [instances, setInstances] = useState<ServerProfile[]>([]);
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<ConversationMessage | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedInstance, setSelectedInstance] = useState("");
  const [intent, setIntent] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState("");
  const [cloudOnline, setCloudOnline] = useState(true);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [reviewTask, setReviewTask] = useState<TaskRecord | null>(null);
  const [highRiskText, setHighRiskText] = useState("");
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const activeSessionIdRef = useRef("");
  const followLatestRef = useRef(true);
  const sendingRef = useRef(false);
  const streamRouteRef = useRef<ChatRoute | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);

  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add({
      desktop: "(min-width: 761px)",
      reduceMotion: "(prefers-reduced-motion: reduce)",
    }, (context) => {
      if (context.conditions?.reduceMotion) return;
      const desktop = Boolean(context.conditions?.desktop);
      gsap.fromTo(".agent-topbar", { autoAlpha: 0, y: -10 }, {
        autoAlpha: 1, y: 0, duration: 0.38, ease: "power2.out", clearProps: "transform,opacity,visibility",
      });
      if (desktop) {
        gsap.fromTo(".agent-sidebar", { autoAlpha: 0, x: -14 }, {
          autoAlpha: 1, x: 0, duration: 0.46, delay: 0.04, ease: "power2.out", clearProps: "transform,opacity,visibility",
        });
      }
      gsap.fromTo(".conversation-head, .agent-composer", { autoAlpha: 0, y: 10 }, {
        autoAlpha: 1, y: 0, duration: 0.42, delay: 0.08, stagger: 0.06, ease: "power2.out", clearProps: "transform,opacity,visibility",
      });
      gsap.fromTo(".session-row", { autoAlpha: 0, x: -7 }, {
        autoAlpha: 1, x: 0, duration: 0.3, delay: 0.12, stagger: 0.035, ease: "power1.out", clearProps: "transform,opacity,visibility",
      });
    }, workspaceRef.current ?? undefined);
    return () => media.revert();
  }, { scope: workspaceRef });

  useGSAP(() => {
    const backdrop = workspaceRef.current?.querySelector<HTMLElement>(".modal-backdrop");
    const panel = backdrop?.querySelector<HTMLElement>(".modal");
    if (!backdrop || !panel) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(backdrop, { autoAlpha: 0 }, {
        autoAlpha: 1, duration: 0.2, ease: "power1.out", clearProps: "opacity,visibility",
      });
      gsap.fromTo(panel, { autoAlpha: 0, y: 14, scale: 0.985 }, {
        autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "power2.out", clearProps: "transform,opacity,visibility",
      });
    }, backdrop);
    return () => media.revert();
  }, { dependencies: [promptOpen, reviewTask?.id], scope: workspaceRef, revertOnUpdate: true });

  const refresh = useCallback(async () => {
    try {
      const [nextAgents, nextInstances, nextSessions, nextTasks] = await Promise.all([
        api<Agent[]>("/agents"),
        api<ServerProfile[]>("/instances"),
        api<ConversationSession[]>("/sessions"),
        api<TaskRecord[]>("/tasks"),
      ]);
      setAgents(nextAgents);
      setInstances(nextInstances);
      setSessions(nextSessions);
      setTasks(nextTasks);
      setCloudOnline(true);
      setSelectedInstance((value) => value || nextSessions[0]?.instance_ref || nextInstances[0]?.instance_id || "");
      setActiveSessionId((value) => value || nextSessions[0]?.id || "");
    } catch (cause) {
      setCloudOnline(false);
      setError(cause instanceof Error ? cause.message : "无法连接 Cloud");
    }
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    if (!sessionId) return setMessages([]);
    try {
      setMessages(await api<ConversationMessage[]>(`/sessions/${sessionId}/messages`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载会话");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    followLatestRef.current = true;
    setShowScrollToLatest(false);
    void loadMessages(activeSessionId);
  }, [activeSessionId, loadMessages]);

  useEffect(() => {
    if (!activeSessionId) return;
    const timer = setInterval(() => void loadMessages(activeSessionId), 3000);
    return () => clearInterval(timer);
  }, [activeSessionId, loadMessages]);

  const activeSession = sessions.find((session) => session.id === activeSessionId && (!selectedInstance || session.instance_ref === selectedInstance));
  const current = instances.find((instance) => instance.instance_id === (selectedInstance || activeSession?.instance_ref));
  const linkedTaskIds = new Set(messages.map((message) => message.task_id).filter(Boolean));
  const currentTasks = tasks.filter((task) => linkedTaskIds.has(task.id) || (!activeSession && task.instance_ref === current?.instance_id));
  const activeTask = currentTasks.find((task) => !terminal(task.state)) ?? currentTasks[0];
  const onlineAgents = agents.filter((agent) => agent.status === "online").length;
  const groupedSessions = useMemo(() => sessions.filter((session) => {
    return !selectedInstance || session.instance_ref === selectedInstance;
  }), [sessions, selectedInstance]);

  useEffect(() => {
    if (!followLatestRef.current) return;
    const stream = messageStreamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [messages, planning, streamingMessage]);

  function updateScrollPosition() {
    const stream = messageStreamRef.current;
    if (!stream) return;
    const isNearLatest = stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 80;
    followLatestRef.current = isNearLatest;
    setShowScrollToLatest(!isNearLatest);
  }

  function scrollToLatest() {
    followLatestRef.current = true;
    setShowScrollToLatest(false);
    const stream = messageStreamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  async function createSession() {
    const instanceRef = selectedInstance || instances[0]?.instance_id;
    if (!instanceRef) return;
    setLoading(true);
    try {
      const session = await api<ConversationSession>("/sessions", {
        method: "POST",
        body: JSON.stringify({ instance_ref: instanceRef }),
      });
      setSessions((value) => [session, ...value]);
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setMessages([]);
      setSidebarOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建会话");
    } finally {
      setLoading(false);
    }
  }

  async function selectSession(session: ConversationSession) {
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setSelectedInstance(session.instance_ref);
    setSidebarOpen(false);
  }

  function selectInstance(instanceRef: string) {
    const nextSession = sessions.find((session) => session.instance_ref === instanceRef);
    setSelectedInstance(instanceRef);
    activeSessionIdRef.current = nextSession?.id ?? "";
    setActiveSessionId(nextSession?.id ?? "");
    setMessages([]);
    setStreamingMessage(null);
    streamRouteRef.current = null;
    setPlanning(false);
  }

  async function sendMessage() {
    if (!intent.trim() || sendingRef.current) return;
    const outgoing = intent.trim();
    const requestId = createRequestId();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 65_000);
    sendingRef.current = true;
    sendAbortRef.current = controller;
    let sessionId = activeSession?.id ?? "";
    followLatestRef.current = true;
    setShowScrollToLatest(false);
    setPlanning(true);
    setPendingSessionId(sessionId);
    setLoading(true);
    setSending(true);
    setStreamingMessage(null);
    setError("");
    try {
      if (!sessionId) {
        const instanceRef = selectedInstance || instances[0]?.instance_id;
        if (!instanceRef) throw new Error("请先选择实例");
        const session = await api<ConversationSession>("/sessions", {
          method: "POST",
          body: JSON.stringify({ instance_ref: instanceRef }),
        });
        sessionId = session.id;
        setPendingSessionId(session.id);
        activeSessionIdRef.current = session.id;
        setActiveSessionId(session.id);
      }
      const content = outgoing;
      setIntent("");
      setMessages((value) => [...value, {
        id: `optimistic-${Date.now()}`, session_id: sessionId, role: "user", content, created_at: new Date().toISOString(),
      }]);
      const streamId = `streaming-${Date.now()}`;
      let result: { message: ConversationMessage; task?: TaskRecord } | undefined;
      await apiStream<ConversationStreamEvent>(`/sessions/${sessionId}/messages/stream`, {
        method: "POST",
        body: JSON.stringify({ content, request_id: requestId }),
        signal: controller.signal,
      }, (event) => {
        if (event.type === "route") {
          streamRouteRef.current = event.route;
          setPlanning(event.route === "tool");
          if (event.route === "tool") setStreamingMessage(null);
        } else if (event.type === "delta") {
          if (streamRouteRef.current === "tool") return;
          setPlanning(false);
          setStreamingMessage((value) => ({
            id: streamId,
            session_id: sessionId,
            role: "assistant",
            content: `${value?.content ?? ""}${event.text}`,
            route: "direct",
            created_at: value?.created_at ?? new Date().toISOString(),
          }));
        } else if (event.type === "reset") {
          setStreamingMessage(null);
          setPlanning(streamRouteRef.current === "tool" || streamRouteRef.current === null);
        } else if (event.type === "done") {
          result = event.result;
          setPlanning(false);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      });
      if (!result) throw new Error("流式回答未正常结束");
      setMessages((value) => activeSessionIdRef.current !== sessionId || value.some((message) => message.id === result?.message.id) ? value : [...value, result!.message]);
      setStreamingMessage(null);
      await refresh();
      if (result.task?.state === "WAITING_CONFIRMATION") setReviewTask(result.task);
    } catch (cause) {
      setStreamingMessage(null);
      setError(cause instanceof DOMException && cause.name === "AbortError" ? "消息发送已停止，请重新发送。" : cause instanceof Error ? cause.message : "消息发送失败");
      if (activeSessionIdRef.current === sessionId) await loadMessages(sessionId);
    } finally {
      window.clearTimeout(timeout);
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
      sendingRef.current = false;
      setLoading(false);
      setSending(false);
      setPlanning(false);
      streamRouteRef.current = null;
      setPendingSessionId("");
    }
  }

  function cancelMessage() {
    sendAbortRef.current?.abort();
  }

  function openPrompt() {
    if (!activeSession) return;
    setPromptDraft(activeSession.system_prompt);
    setPromptOpen(true);
  }

  async function savePrompt() {
    if (!activeSession || !promptDraft.trim()) return;
    setLoading(true);
    try {
      const updated = await api<ConversationSession>(`/sessions/${activeSession.id}`, {
        method: "PATCH",
        body: JSON.stringify({ system_prompt: promptDraft }),
      });
      setSessions((value) => value.map((session) => session.id === updated.id ? updated : session));
      setPromptOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "系统提示词保存失败");
    } finally {
      setLoading(false);
    }
  }

  async function deleteSession(sessionId: string) {
    await api(`/sessions/${sessionId}`, { method: "DELETE" });
    const next = sessions.filter((session) => session.id !== sessionId);
    setSessions(next);
    if (activeSessionId === sessionId) {
      setActiveSessionId(next[0]?.id ?? "");
      setMessages([]);
    }
  }

  async function confirmTask() {
    if (!reviewTask || !current) return;
    if (reviewTask.risk === "high" && highRiskText !== current.name) return;
    setLoading(true);
    try {
      const confirmation = await api<{ token: string }>(`/tasks/${reviewTask.id}/confirmation`, { method: "POST" });
      await api(`/tasks/${reviewTask.id}/confirm`, { method: "POST", body: JSON.stringify({ token: confirmation.token }) });
      setReviewTask(null);
      setHighRiskText("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认失败");
    } finally {
      setLoading(false);
    }
  }

  return <main ref={workspaceRef} className={`agent-shell paper-ops ${activeTask ? "with-inspector" : "conversation-only"}`}>
    <header className="agent-topbar">
      <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开会话"><Menu size={19} /></button>
      <div className="brand"><span className="brand-symbol"><img src="/brand/mcai-symbol.png" alt="" /></span><strong>MCAI</strong><span>Agent 工作台</span></div>
      <div className="agent-context">{current ? <><Server size={15} /><strong>{current.name}</strong><span>{instanceMeta(current)}</span></> : "未选择实例"}</div>
      <div className={`cloud-state ${cloudOnline ? "online" : "offline"}`}><Cloud size={15} /><span>{cloudOnline ? "本地云在线" : "本地云离线"}</span></div>
      <button className="icon-button" onClick={() => void refresh()} aria-label="刷新"><RefreshCw size={17} /></button>
      <button className="icon-button" onClick={onLogout} aria-label="退出"><LogOut size={18} /></button>
    </header>

    <aside className={`agent-sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="agent-card">
        <span className={`agent-orb ${onlineAgents ? "online" : ""}`}><Bot size={19} /></span>
        <div><strong>Sidecar Agent</strong><small>{onlineAgents}/{agents.length} 节点在线</small></div>
        <span className="agent-live">{onlineAgents ? "LIVE" : "WAIT"}</span>
      </div>
      <div className="instance-switcher">
        <label>当前实例</label>
        <div><Server size={15} /><select value={selectedInstance} onChange={(event) => selectInstance(event.target.value)}>{instances.map((instance) => <option key={instance.instance_id} value={instance.instance_id}>{instance.name}</option>)}</select><ChevronDown size={14} /></div>
      </div>
      <div className="session-section-head"><span>会话</span><button onClick={() => void createSession()} aria-label="新建会话"><Plus size={16} /></button></div>
      <div className="session-list">
        {groupedSessions.map((session) => <div key={session.id} className={`session-row ${session.id === activeSessionId ? "selected" : ""}`}>
          <button onClick={() => void selectSession(session)}><MessageSquare size={15} /><span><strong>{session.title}</strong><small>{new Date(session.updated_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></span></button>
          <button className="session-more" onClick={() => void deleteSession(session.id)} aria-label="删除会话"><Trash2 size={14} /></button>
        </div>)}
        {!groupedSessions.length && <div className="session-empty"><MessageSquare size={19} /><span>为这个实例创建第一个会话</span></div>}
      </div>
      <button className="new-session-button" onClick={() => void createSession()}><Plus size={16} />新会话</button>
    </aside>

    <section className="agent-conversation">
      {error && <div className="error-banner" role="alert"><AlertTriangle size={16} /><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误提示"><X size={14} /></button></div>}
      <div className="conversation-head">
        <div className="instance-status-strip">
          <span>实例：<strong>{current?.name ?? "未选择"}</strong></span>
          <span>状态：<strong>{current?.state === "running" ? "运行中" : current?.state === "stopped" ? "已停止" : "同步中"}</strong><i className={`status-dot ${current?.state ?? "unknown"}`} /></span>
          <span>Java {current?.java?.major ?? 25}</span>
          <span>{current ? instanceMeta(current) : "MCSManager"}</span>
        </div>
        <button className="prompt-button" onClick={openPrompt} disabled={!activeSession}><Settings2 size={16} /><span>会话设置</span></button>
      </div>
      <div
        className="message-stream"
        ref={messageStreamRef}
        onScroll={updateScrollPosition}
        onWheel={(event) => {
          if (event.deltaY < 0) followLatestRef.current = false;
        }}
      >
        {!messages.length && <div className="agent-welcome"><span><Sparkles size={23} /></span><p className="welcome-label">MCAI / OPERATIONS</p><h2>今天要处理什么？</h2><p>直接提问或描述操作，MCAI 会使用当前实例的信息完成任务。</p><div className="suggestions"><button onClick={() => setIntent("启动服务器")}>启动实例</button><button onClick={() => setIntent("分析最近一次崩服的原因")}>分析崩服</button><button onClick={() => setIntent("把视距调整为 10")}>调整配置</button></div></div>}
        {messages.map((message) => <MessageBubble key={message.id} message={message} task={message.task_id ? tasks.find((task) => task.id === message.task_id) : undefined} instanceName={current?.name} onReview={(task) => setReviewTask(task)} />)}
        {streamingMessage?.session_id === activeSessionId && <MessageBubble message={streamingMessage} streaming onReview={(task) => setReviewTask(task)} />}
        {planning && pendingSessionId === activeSessionId && !streamingMessage && <div className="thinking-row" role="status" aria-live="polite"><span className="bot-avatar"><Bot size={16} /></span><div className="thinking-status"><strong>思考中</strong><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></div></div>}
      </div>
      {showScrollToLatest && <button className="scroll-latest-button" onClick={scrollToLatest} aria-label="回到最新消息" title="回到最新消息"><ChevronDown size={19} /></button>}
      <div className="agent-composer">
        <textarea value={intent} onChange={(event) => setIntent(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="询问知识、诊断问题，或描述你想完成的操作…" rows={2} />
        <button onClick={sending ? cancelMessage : () => void sendMessage()} disabled={!sending && (loading || !intent.trim())} aria-label={sending ? "停止发送" : "发送"} title={sending ? "停止发送" : "发送"}>{sending ? <Square size={17} /> : <Send size={19} />}</button>
        <div className="composer-hint"><ShieldCheck size={13} />工具调用仍需策略校验，高风险操作必须确认</div>
      </div>
    </section>

    {activeTask && <aside className="agent-inspector">
      <div className="inspector-head"><span>执行上下文</span>{activeTask && <span className={`risk ${activeTask.risk}`}>{riskLabel(activeTask.risk)}</span>}</div>
      <div className="instance-health"><span className={`status-dot ${current?.state ?? "unknown"}`} /><div><strong>{current?.state === "running" ? "实例运行中" : current?.state ?? "未知状态"}</strong><small>{current ? instanceMeta(current) : "等待实例信息"}</small></div></div>
      <>
        <div className="task-summary"><small>当前任务</small><strong>{activeTask.intent}</strong><span>{stateLabel(activeTask.state)}</span></div>
        <section className="inspector-section"><h2><ClipboardCheck size={15} />调用工具</h2>{activeTask.plan.steps.map((step) => <div className="plan-step" key={step.id}><span><Wrench size={12} /></span><div><strong>{toolLabel(step.tool)}</strong><small>{step.requires_confirmation ? "执行前需要确认" : "自动执行"}</small></div></div>)}</section>
        <section className="inspector-section"><h2><FileClock size={15} />最新证据</h2>{activeTask.evidence.slice(-4).reverse().map((item, index) => <div className="evidence" key={`${item.at}-${index}`}><span /><p>{item.summary}<small>{new Date(item.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></p></div>)}</section>
      </>
    </aside>}

    {promptOpen && activeSession && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPromptOpen(false); }}><div className="modal prompt-modal" role="dialog" aria-modal="true">
      <div className="modal-head"><div><span className="eyebrow">SESSION INSTRUCTIONS</span><h2>系统提示词</h2></div><button className="icon-button" onClick={() => setPromptOpen(false)} aria-label="关闭系统提示词设置"><X size={18} /></button></div>
      <p>只影响当前会话的语气、目标和工作偏好，不能覆盖安全策略与确认规则。</p>
      <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} rows={10} maxLength={4000} />
      <div className="prompt-meta"><span>{promptDraft.length}/4000</span><span><ShieldCheck size={13} />安全规则始终优先</span></div>
      <div className="modal-actions"><button className="secondary" onClick={() => setPromptOpen(false)}>取消</button><button className="primary" onClick={() => void savePrompt()} disabled={loading || !promptDraft.trim()}>保存提示词</button></div>
    </div></div>}

    {reviewTask && current && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewTask(null); }}><div className="modal" role="dialog" aria-modal="true">
      <div className="modal-head"><div><span className={`risk ${reviewTask.risk}`}>{riskLabel(reviewTask.risk)}</span><h2>确认执行计划</h2></div><button className="icon-button" onClick={() => setReviewTask(null)} aria-label="关闭执行确认"><X size={18} /></button></div>
      <div className="scope-line"><Server size={16} /><span>{current.name}</span><span>{current.loader} {current.minecraft_version}</span></div>
      <p className="intent-review">{reviewTask.intent}</p>
      <div className="review-steps">{reviewTask.plan.steps.map((step, index) => <div key={step.id}><span>{index + 1}</span><div><strong>{toolLabel(step.tool)}</strong><code>{JSON.stringify(step.args)}</code></div></div>)}</div>
      <div className="snapshot-note"><RotateCcw size={17} /><div><strong>执行前创建恢复点</strong><span>失败时按策略恢复并再次验证。</span></div></div>
      {reviewTask.risk === "high" && <label className="danger-confirm">输入实例名 <strong>{current.name}</strong> 以确认<input value={highRiskText} onChange={(event) => setHighRiskText(event.target.value)} /></label>}
      <div className="modal-actions"><button className="secondary" onClick={() => setReviewTask(null)}>取消</button><button className="primary" onClick={() => void confirmTask()} disabled={loading || (reviewTask.risk === "high" && highRiskText !== current.name)}>{loading ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}确认并执行</button></div>
    </div></div>}
  </main>;
}

function MessageBubble({ message, task, instanceName, streaming = false, onReview }: { message: ConversationMessage; task?: TaskRecord; instanceName?: string; streaming?: boolean; onReview: (task: TaskRecord) => void }) {
  const messageRef = useRef<HTMLElement>(null);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(messageRef.current, { autoAlpha: 0, y: 9 }, {
        autoAlpha: 1, y: 0, duration: 0.34, ease: "power2.out", clearProps: "transform,opacity,visibility",
      });
    }, messageRef.current ?? undefined);
    return () => media.revert();
  }, { scope: messageRef });
  if (message.role === "user") return <article ref={messageRef} className="chat-message user"><span className="user-avatar"><UserRound size={15} /></span><div><small>你</small><p>{message.content}</p></div></article>;
  const isTaskRequest = message.task_phase === "request";
  if (isTaskRequest) {
    return <article ref={messageRef} className="chat-message assistant task-request"><span className="bot-avatar"><Bot size={16} /></span><div><div className="message-meta"><strong>MCAI</strong></div><TaskActivity content={message.content} task={task} instanceName={instanceName} onReview={onReview} /></div></article>;
  }
  const completedTask = task && terminal(task.state);
  const failedTask = completedTask && task.state !== "SUCCEEDED";
  return <article ref={messageRef} className={`chat-message assistant ${streaming ? "streaming" : ""} ${completedTask ? "has-result" : ""}`} aria-busy={streaming || undefined}>
    <span className="bot-avatar"><Bot size={16} /></span>
    <div>
      <div className="message-meta"><strong>MCAI</strong>{streaming && <span>正在回答</span>}</div>
      {completedTask ? <section className={`answer-result ${failedTask ? "failed" : "success"}`}>
        <header>
          <span className="answer-result-icon">{failedTask ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}</span>
          <div><strong>{failedTask ? "任务未完成" : "任务已完成"}</strong><small>{task.plan.steps.map((step) => toolLabel(step.tool)).join("、")}</small></div>
          <time>{new Date(task.updated_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
        </header>
        <RichText content={message.content} />
        <TaskOutcome task={task} />
      </section> : <RichText content={message.content} />}
    </div>
  </article>;
}

function TaskActivity({ content, task, instanceName, onReview }: { content: string; task?: TaskRecord; instanceName?: string; onReview: (task: TaskRecord) => void }) {
  const diagnosis = task ? [...task.evidence].reverse().find((item) => item.kind === "diagnosis") : undefined;
  const recovery = task ? [...task.evidence].reverse().find((item) => item.kind === "decision") : undefined;
  const failedTask = Boolean(task && terminal(task.state) && task.state !== "SUCCEEDED");
  const isComplete = Boolean(task && terminal(task.state));
  return <details className={`task-activity ${failedTask ? "failed" : ""}`}>
    <summary>
      <span className="task-activity-title">{isComplete ? <CheckCircle2 size={14} /> : <LoaderCircle className="spin" size={14} />}<span><strong>{isComplete ? "查看思考过程" : "思考中"}</strong><small>{isComplete ? taskActivityLabel(task!.state) : "展开查看工具调用"}</small></span></span>
      <ChevronDown className="task-activity-chevron" size={15} aria-hidden="true" />
    </summary>
    <div className="task-activity-content">
      {content.trim() && <section className="task-activity-copy"><span>任务说明</span><RichText content={content} /></section>}
      {task && <section className="process-list" aria-label="工具执行记录">
        {task.plan.steps.map((step, index) => <div className="process-row" key={step.id}>
          <span className="process-index">{index + 1}</span>
          <div><strong>{toolLabel(step.tool)}</strong><code>{step.tool}</code></div>
          <span className={`process-state ${failedTask ? "failed" : task.state === "SUCCEEDED" ? "success" : "pending"}`}>{failedTask ? "未完成" : task.state === "SUCCEEDED" ? "完成" : "等待"}</span>
        </div>)}
        <div className="process-target"><span>目标实例</span><strong>{instanceName ?? task.instance_ref}</strong><time>{new Date(task.updated_at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div>
      </section>}
      {failedTask && <div className="failure-analysis">
        <div><strong>失败原因</strong><p>{diagnosis?.summary ?? "未收到可识别的诊断证据，请检查实例控制台日志。"}</p></div>
        <div><strong>下一步</strong><p>{recovery?.summary ?? "诊断证据已保存；请修复原因后再重试任务。"}</p></div>
      </div>}
      {task?.state === "WAITING_CONFIRMATION" && <button className="confirm-inline" onClick={() => onReview(task)}>检查并确认执行</button>}
    </div>
  </details>;
}

function TaskOutcome({ task }: { task: TaskRecord }) {
  const evidence = task.evidence.filter((item) => item.summary.trim()).slice(-3);
  if (!evidence.length) return null;
  return <details className="result-evidence">
    <summary><span>查看执行记录</span><small>{evidence.length} 条证据</small><ChevronDown size={14} aria-hidden="true" /></summary>
    <div>{evidence.map((item, index) => <p key={`${item.at}-${index}`}><span />{item.summary}<time>{new Date(item.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></p>)}</div>
  </details>;
}

function RichText({ content }: { content: string }) {
  const blocks = content.trim().split(/\n{2,}/);
  return <div className="rich-message">{blocks.map((block, blockIndex) => {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length && lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      return <ul key={blockIndex}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inlineText(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    }
    return <p key={blockIndex}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{inlineText(line)}{lineIndex < lines.length - 1 && <br />}</Fragment>)}</p>;
  })}</div>;
}

function inlineText(value: string): ReactNode[] {
  return value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
    part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part
  ));
}

function terminal(state: string) { return ["SUCCEEDED", "FAILED", "ROLLED_BACK", "REJECTED", "CANCELLED", "EXPIRED", "MANUAL_INTERVENTION"].includes(state); }
function taskActivityLabel(state: string) {
  if (state === "WAITING_CONFIRMATION") return "待确认";
  if (state === "SUCCEEDED") return "已完成";
  if (terminal(state)) return "未完成";
  return "处理中";
}
function riskLabel(risk: string) { return ({ read: "只读", low: "低风险", medium: "中风险", high: "高风险", forbidden: "禁止" } as Record<string, string>)[risk] ?? risk; }
function stateLabel(state: string) { return ({ DRAFTED: "正在生成计划", POLICY_CHECKED: "策略已校验", WAITING_CONFIRMATION: "等待确认", SNAPSHOTTING: "准备执行", EXECUTING: "正在执行", VERIFYING: "正在验证", SUCCEEDED: "操作成功", FAILED: "执行失败", REJECTED: "策略已拒绝", ROLLING_BACK: "正在回滚", ROLLED_BACK: "已恢复", MANUAL_INTERVENTION: "需要人工处理" } as Record<string, string>)[state] ?? state; }
function toolLabel(tool: string) { return ({ "logs.query": "读取相关日志", "files.list": "列出目录文件", "file.download": "下载官方 Paper 服务端", "server.install": "安装 Minecraft 服务端", "config.patch": "修改服务器配置", "console.command": "发送控制台命令", "plugin.resolve": "解析插件兼容性", "plugin.install": "安装已校验插件", "instance.start": "启动服务器", "instance.stop": "停止服务器", "instance.restart": "重启并等待稳定", "snapshot.restore": "恢复快照" } as Record<string, string>)[tool] ?? tool; }
function instanceMeta(instance: ServerProfile) {
  const values = [instance.loader, instance.minecraft_version]
    .filter((value): value is string => Boolean(value && value.toLowerCase() !== "unknown"));
  if (values.length) return values.join(" · ");
  return instance.provider_type === "mcsmanager" ? "MCSManager" : "Pterodactyl";
}

function createRequestId() {
  const cryptoApi = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;
  if (globalThis.isSecureContext && typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const entropy = new Uint32Array(3);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(entropy);
  else entropy.set([Date.now(), Math.floor(Math.random() * 0xffffffff), Math.floor(Math.random() * 0xffffffff)]);
  return `request_${Date.now().toString(36)}_${Array.from(entropy, (value) => value.toString(36)).join("_")}`;
}
