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
  const messageLoadVersionRef = useRef(0);
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
      setError(cause instanceof Error ? cause.message : "æ— æ³•è¿æ¥ Cloud");
    }
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    const requestVersion = ++messageLoadVersionRef.current;
    if (!sessionId) {
      setMessages([]);
      return;
    }
    try {
      const nextMessages = await api<ConversationMessage[]>(`/sessions/${sessionId}/messages`);
      if (requestVersion !== messageLoadVersionRef.current || activeSessionIdRef.current !== sessionId) return;
      setMessages((currentMessages) => sameMessageList(currentMessages, nextMessages) ? currentMessages : nextMessages);
    } catch (cause) {
      if (requestVersion !== messageLoadVersionRef.current) return;
      setError(cause instanceof Error ? cause.message : "æ— æ³•åŠ è½½ä¼šè¯");
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
  }, [messages, planning, streamingMessage, tasks]);

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
      setError(cause instanceof Error ? cause.message : "æ— æ³•åˆ›å»ºä¼šè¯");
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
        if (!instanceRef) throw new Error("è¯·å…ˆé€‰æ‹©å®ä¾‹");
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
      if (!result) throw new Error("æµå¼å›ç­”æœªæ­£å¸¸ç»“æŸ");
      setMessages((value) => activeSessionIdRef.current !== sessionId || value.some((message) => message.id === result?.message.id) ? value : [...value, result!.message]);
      setStreamingMessage(null);
      await refresh();
      if (result.task?.state === "WAITING_CONFIRMATION") setReviewTask(result.task);
    } catch (cause) {
      setStreamingMessage(null);
      setError(cause instanceof DOMException && cause.name === "AbortError" ? "æ¶ˆæ¯å‘é€å·²åœæ­¢ï¼Œè¯·é‡æ–°å‘é€ã€‚" : cause instanceof Error ? cause.message : "æ¶ˆæ¯å‘é€å¤±è´¥");
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
      setError(cause instanceof Error ? cause.message : "ç³»ç»Ÿæç¤ºè¯ä¿å­˜å¤±è´¥");
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
      await refreshã­9¶‰ËkºwµçqÍÑÉ½¹œùíÑ½½±1…‰•°¡ÍÑ•À¹Ñ½½°¥ôğ½ÍÑÉ½¹œøñ½‘”ùí)M=8¹ÍÑÉ¥¹¥™ä¡ÍÑ•À¹…ÉÌ¥ôğ½½‘”øğ½‘¥Øøğ½‘¥Øø¥ôğ½‘¥Øø(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Í¹…ÁÍ¡½Ğµ¹½Ñ”ˆøñI½Ñ…Ñ•ÜÍ¥é”õìÄİô€¼øñ‘¥ØøñÍÑÉ½¹œûš&Ÿ¢†3–&7–"o–îëš‹–’7
äğ½ÍÑÉ½¹œøñÍÁ…¸û–’Ç¢Ò—š^Ûš2'¶[V—š‹–’7–æÛ–7š²‡¦ª3¢¾ğ½ÍÁ…¸øğ½‘¥Øøğ½‘¥Øø(€€€€€íÉ•Ù¥•İQ…Í¬¹É¥Í¬€ôôô€‰¡¥ ˆ€˜˜€ñ±…‰•°±…ÍÍ9…µ”ô‰‘…¹•Èµ½¹™¥É´ˆû¢úO–—–º{’ú/–B4€ñÍÑÉ½¹œùíÕÉÉ•¹Ğ¹¹…µ•ôğ½ÍÑÉ½¹œøƒ’î—†»¢ºñ¥¹ÁÕĞÙ…±Õ”õí¡¥¡I¥Í­Q•áÑô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÍ•Ñ!¥¡I¥Í­Q•áĞ¡•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”¥ô€¼øğ½±…‰•°ùô(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µ½‘…°µ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ½¹±¥¬õì ¤€ôøÍ•ÑI•Ù¥•İQ…Í¬¡¹Õ±°¥ôû–>[šÚ ğ½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…Éäˆ½¹±¥¬õì ¤€ôøÙ½¥½¹™¥ÉµQ…Í¬ ¥ô‘¥Í…‰±•õí±½…‘¥¹œñğ€¡É•Ù¥•İQ…Í¬¹É¥Í¬€ôôô€‰¡¥ ˆ€˜˜¡¥¡I¥Í­Q•áĞ€„ôôÕÉÉ•¹Ğ¹¹…µ”¥ôùí±½…‘¥¹œ€ü€ñ1½…‘•É¥É±”±…ÍÍ9…µ”ô‰ÍÁ¥¸ˆÍ¥é”õìÄİô€¼ø€è€ñM¡¥•±‘¡•¬Í¥é”õìÄİô€¼ù÷†»¢º“–æÛš&Ÿ¢†0ğ½‰ÕÑÑ½¸øğ½‘¥Øø(€€€€ğ½‘¥Øøğ½‘¥Øùô(€€ğ½µ…¥¸øì)ô()™Õ¹Ñ¥½¸5•ÍÍ…•	Õ‰‰±”¡ìµ•ÍÍ…”°Ñ…Í¬°¥¹ÍÑ…¹•9…µ”°ÍÑÉ•…µ¥¹œ€ô™…±Í”°½¹I•Ù¥•Üôèìµ•ÍÍ…”è½¹Ù•ÉÍ…Ñ¥½¹5•ÍÍ…”ìÑ…Í¬üèQ…Í­I•½Éì¥¹ÍÑ…¹•9…µ”üèÍÑÉ¥¹œìÍÑÉ•…µ¥¹œüè‰½½±•…¸ì½¹I•Ù¥•Üè€¡Ñ…Í¬èQ…Í­I•½É¤€ôøÙ½¥ô¤ì(€½¹ÍĞµ•ÍÍ…•I•˜€ôÕÍ•I•˜ñ!Q51±•µ•¹Ğø¡¹Õ±°¤ì(€ÕÍ•M@  ¤€ôøì(€€€½¹ÍĞµ•‘¥„€ôÍ…À¹µ…Ñ¡5•‘¥„ ¤ì(€€€µ•‘¥„¹…‘ ˆ¡ÁÉ•™•ÉÌµÉ•‘Õ•µµ½Ñ¥½¸è¹¼µÁÉ•™•É•¹”¤ˆ°€ ¤€ôøì(€€€€€Í…À¹™É½µQ¼¡µ•ÍÍ…•I•˜¹ÕÉÉ•¹Ğ°ì…ÕÑ½±Á¡„è€À°äè€äô°ì(€€€€€€€…ÕÑ½±Á¡„è€Ä°äè€À°‘ÕÉ…Ñ¥½¸è€À¸ÌĞ°•…Í”è€‰Á½İ•ÈÈ¹½ÕĞˆ°±•…ÉAÉ½ÁÌè€‰ÑÉ…¹Í™½É´±½Á…¥Ñä±Ù¥Í¥‰¥±¥Ñäˆ°(€€€€€ô¤ì(€€€ô°µ•ÍÍ…•I•˜¹ÕÉÉ•¹Ğ€üüÕ¹‘•™¥¹•¤ì(€€€É•ÑÕÉ¸€ ¤€ôøµ•‘¥„¹É•Ù•ÉĞ ¤ì(€ô°ìÍ½Á”èµ•ÍÍ…•I•˜ô¤ì(€¥˜€¡µ•ÍÍ…”¹É½±”€ôôô€‰ÕÍ•Èˆ¤É•ÑÕÉ¸€ñ…ÉÑ¥±”É•˜õíµ•ÍÍ…•I•™ô±…ÍÍ9…µ”ô‰¡…Ğµµ•ÍÍ…”ÕÍ•Èİ½É­‰•¹ µÉ•½ÉˆøñÍÁ…¸±…ÍÍ9…µ”ô‰ÕÍ•Èµ…Ù…Ñ…ÈˆøñUÍ•ÉI½Õ¹Í¥é”õìÄÕô€¼øğ½ÍÁ…¸øñ‘¥Øøñ‘¥Ø±…ÍÍ9…µ”ô‰µ•ÍÍ…”µµ•Ñ„ˆøñÍÑÉ½¹œù=559ğ½ÍÑÉ½¹œøñÑ¥µ”ùí¹•Ü…Ñ”¡µ•ÍÍ…”¹É•…Ñ•‘}…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ğˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ğˆô¥ôğ½Ñ¥µ”øğ½‘¥ØøñÀùíµ•ÍÍ…”¹½¹Ñ•¹Ñôğ½Àøğ½‘¥Øøğ½…ÉÑ¥±”øì(€½¹ÍĞ¥ÍQ…Í­I•ÅÕ•ÍĞ€ôµ•ÍÍ…”¹Ñ…Í­}Á¡…Í”€ôôô€‰É•ÅÕ•ÍĞˆì(€¥˜€¡¥ÍQ…Í­I•ÅÕ•ÍĞ€˜˜Ñ…Í¬€˜˜Ñ•Éµ¥¹…°¡Ñ…Í¬¹ÍÑ…Ñ”¤¤É•ÑÕÉ¸¹Õ±°ì(€¥˜€¡¥ÍQ…Í­I•ÅÕ•ÍĞ¤ì(€€€É•ÑÕÉ¸€ñ…ÉÑ¥±”É•˜õíµ•ÍÍ…•I•™ô±…ÍÍ9…µ”ô‰¡…Ğµµ•ÍÍ…”…ÍÍ¥ÍÑ…¹ĞÑ…Í¬µÉ•ÅÕ•ÍĞİ½É­‰•¹ µÉ•½ÉˆøñÍÁ…¸±…ÍÍ9…µ”ô‰‰½Ğµ…Ù…Ñ…Èˆøñ	½ĞÍ¥é”õìÄÙô€¼øğ½ÍÁ…¸øñ‘¥Øøñ‘¥Ø±…ÍÍ9…µ”ô‰µ•ÍÍ…”µµ•Ñ„ˆøñÍÑÉ½¹œùQ==1Lğ½ÍÑÉ½¹œøñÑ¥µ”ùí¹•Ü…Ñ”¡µ•ÍÍ…”¹É•…Ñ•‘}…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ğˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ğˆô¥ôğ½Ñ¥µ”øğ½‘¥ØøñQ…Í­Ñ¥Ù¥Ñä½¹Ñ•¹Ğõíµ•ÍÍ…”¹½¹Ñ•¹ÑôÑ…Í¬õíÑ…Í­ô¥¹ÍÑ…¹•9…µ”õí¥¹ÍÑ…¹•9…µ•ô½¹I•Ù¥•Üõí½¹I•Ù¥•İô€¼øğ½‘¥Øøğ½…ÉÑ¥±”øì(€ô(€½¹ÍĞ½µÁ±•Ñ•‘Q…Í¬€ôÑ…Í¬€˜˜Ñ•Éµ¥¹…°¡Ñ…Í¬¹ÍÑ…Ñ”¤ì(€½¹ÍĞ™…¥±•‘Q…Í¬€ô½µÁ±•Ñ•‘Q…Í¬€˜˜Ñ…Í¬¹ÍÑ…Ñ”€„ôô€‰MUˆì(€É•ÑÕÉ¸€ñ…ÉÑ¥±”É•˜õíµ•ÍÍ…•I•™ô±…ÍÍ9…µ”õí¡…Ğµµ•ÍÍ…”…ÍÍ¥ÍÑ…¹Ğ€‘íÍÑÉ•…µ¥¹œ€ü€‰ÍÑÉ•…µ¥¹œˆ€è€ˆ‰ô€‘í½µÁ±•Ñ•‘Q…Í¬€ü€‰¡…ÌµÉ•ÍÕ±Ğˆ€è€ˆ‰õô…É¥„µ‰ÕÍäõíÍÑÉ•…µ¥¹œñğÕ¹‘•™¥¹•‘ôø(€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰‰½Ğµ…Ù…Ñ…Èˆøñ	½ĞÍ¥é”õìÄÙô€¼øğ½ÍÁ…¸ø(€€€€ñ‘¥Øø(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µ•ÍÍ…”µµ•Ñ„ˆøñÍÑÉ½¹œùí½µÁ±•Ñ•‘Q…Í¬€ü€‰=9ˆ€è€‰=UQAUP‰ôğ½ÍÑÉ½¹œøñÑ¥µ”ùí¹•Ü…Ñ”¡µ•ÍÍ…”¹É•…Ñ•‘}…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ğˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ğˆô¥ôğ½Ñ¥µ”ùíÍÑÉ•…µ¥¹œ€˜˜€ñÍÁ…¸û¢úO–ë’â´ğ½ÍÁ…¸ùôğ½‘¥Øø(€€€€€í½µÁ±•Ñ•‘Q…Í¬€ü€ñÍ•Ñ¥½¸±…ÍÍ9…µ”õí…¹Íİ•ÈµÉ•ÍÕ±Ğ€‘í™…¥±•‘Q…Í¬€ü€‰™…¥±•ˆ€è€‰ÍÕ•ÍÌ‰õôø(€€€€€€€€ñ¡•…‘•Èø(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰…¹Íİ•ÈµÉ•ÍÕ±Ğµ¥½¸ˆùí™…¥±•‘Q…Í¬€ü€ñ¥É±•±•ÉĞÍ¥é”õìÄİô€¼ø€è€ñ¡•­¥É±”ÈÍ¥é”õìÄİô€¼ùôğ½ÍÁ…¸ø(€€€€€€€€€€ñ‘¥ØøñÍÑÉ½¹œùí™…¥±•‘Q…Í¬€ü€‹’îï–*‡šr«–º3š"@ˆ€è€‹’îï–*‡–ŞË–º3š"@‰ôğ½ÍÑÉ½¹œøñÍµ…±°ùíÑ…Í¬¹Á±…¸¹ÍÑ•ÁÌ¹µ…À ¡ÍÑ•À¤€ôøÑ½½±1…‰•°¡ÍÑ•À¹Ñ½½°¤¤¹©½¥¸ ‹ˆ¥ôğ½Íµ…±°øğ½‘¥Øø(€€€€€€€€€€ñÑ¥µ”ùí¹•Ü…Ñ”¡Ñ…Í¬¹ÕÁ‘…Ñ•‘}…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ğˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ğˆô¥ôğ½Ñ¥µ”ø(€€€€€€€€ğ½¡•…‘•Èø(€€€€€€€€ñI¥¡Q•áĞ½¹Ñ•¹Ğõíµ•ÍÍ…”¹½¹Ñ•¹Ñô€¼ø(€€€€€€€€ñQ…Í­=ÕÑ½µ”Ñ…Í¬õíÑ…Í­ô€¼ø(€€€€€€ğ½Í•Ñ¥½¸ø€è€ğøñI¥¡Q•áĞ½¹Ñ•¹Ğõíµ•ÍÍ…”¹½¹Ñ•¹Ñô€¼ùì…ÍÑÉ•…µ¥¹œ€˜˜€…Ñ…Í¬€˜˜€ñI•ÍÁ½¹Í•QÉ…”É½ÕÑ”õíµ•ÍÍ…”¹É½ÕÑ•ôÑÉ…”õíµ•ÍÍ…”¹ÑÉ…•ô€¼ùôğ¼ùô(€€€€ğ½‘¥Øø(€€ğ½…ÉÑ¥±”øì)ô()™Õ¹Ñ¥½¸Q…Í­Ñ¥Ù¥Ñä¡ì½¹Ñ•¹Ğ°Ñ…Í¬°¥¹ÍÑ…¹•9…µ”°½¹I•Ù¥•Üôèì½¹Ñ•¹ĞèÍÑÉ¥¹œìÑ…Í¬üèQ…Í­I•½Éì¥¹ÍÑ…¹•9…µ”üèÍÑÉ¥¹œì½¹I•Ù¥•Üè€¡Ñ…Í¬èQ…Í­I•½É¤€ôøÙ½¥ô¤ì(€½¹ÍĞ‘¥…¹½Í¥Ì€ôÑ…Í¬€ül¸¸¹Ñ…Í¬¹•Ù¥‘•¹•t¹É•Ù•ÉÍ” ¤¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹­¥¹€ôôô€‰‘¥…¹½Í¥Ìˆ¤€èÕ¹‘•™¥¹•ì(€½¹ÍĞÉ•½Ù•Éä€ôÑ…Í¬€ül¸¸¹Ñ…Í¬¹•Ù¥‘•¹•t¹É•Ù•ÉÍ” ¤¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹­¥¹€ôôô€‰‘•¥Í¥½¸ˆ¤€èÕ¹‘•™¥¹•ì(€½¹ÍĞ™…¥±•‘Q…Í¬€ô	½½±•…¸¡Ñ…Í¬€˜˜Ñ•Éµ¥¹…°¡Ñ…Í¬¹ÍÑ…Ñ”¤€˜˜Ñ…Í¬¹ÍÑ…Ñ”€„ôô€‰MUˆ¤ì(€½¹ÍĞ¥Í½µÁ±•Ñ”€ô	½½±•…¸¡Ñ…Í¬€˜˜Ñ•Éµ¥¹…°¡Ñ…Í¬¹ÍÑ…Ñ”¤¤ì(€½¹ÍĞ±¥Ù•Ù¥‘•¹”€ôÑ…Í¬ü¹•Ù¥‘•¹”¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÕµµ…Éä¹ÑÉ¥´ ¤¤¹Í±¥” ´Ô¤€üümtì(€É•ÑÕÉ¸€ñ‘•Ñ…¥±Ì±…ÍÍ9…µ”õíÑ…Í¬µ…Ñ¥Ù¥Ñä€‘í™…¥±•‘Q…Í¬€ü€‰™…¥±•ˆ€è€ˆ‰ô€‘ì…¥Í½µÁ±•Ñ”€ü€‰±¥Ù”ˆ€è€ˆ‰õô½Á•¸õì…¥Í½µÁ±•Ñ•ô…É¥„µ±¥Ù”ô‰Á½±¥Ñ”ˆø(€€€€ñÍÕµµ…Éäø(€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ…Í¬µ…Ñ¥Ù¥ÑäµÑ¥Ñ±”ˆùí¥Í½µÁ±•Ñ”€ü€ñ¡•­¥É±”ÈÍ¥é”õìÄÑô€¼ø€è€ñ1½…‘•É¥É±”±…ÍÍ9…µ”ô‰ÍÁ¥¸ˆÍ¥é”õìÄÑô€¼ùôñÍÁ…¸øñÍÑÉ½¹œùí¥Í½µÁ±•Ñ”€ü€‹š&Ÿ¢†3¢ºÃ–öTˆ€èÑ…Í¬€üÍÑ…Ñ•1…‰•°¡Ñ…Í¬¹ÍÑ…Ñ”¤€è€‹š¶–r£¢–"H‰ôğ½ÍÑÉ½¹œøñÍµ…±°ùí¥Í½µÁ±•Ñ”€üÑ…Í­Ñ¥Ù¥Ñå1…‰•°¡Ñ…Í¬„¹ÍÑ…Ñ”¤€èÑ…Í¬€ü€‹–º{š^ÛšnÓšZÃ–Ş—–ß¢ÂR£’â;–n{¢Âˆ€è€‹š¶–r£Rš"Cš&Ÿ¢†3¢º‡–"H‰ôğ½Íµ…±°øğ½ÍÁ…¸øğ½ÍÁ…¸ø(€€€€€€ñ¡•ÙÉ½¹½İ¸±…ÍÍ9…µ”ô‰Ñ…Í¬µ…Ñ¥Ù¥Ñäµ¡•ÙÉ½¸ˆÍ¥é”õìÄÕô…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼ø(€€€€ğ½ÍÕµµ…Éäø(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ñ…Í¬µ…Ñ¥Ù¥Ñäµ½¹Ñ•¹Ğˆø(€€€€€í½¹Ñ•¹Ğ¹ÑÉ¥´ ¤€˜˜€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰Ñ…Í¬µ…Ñ¥Ù¥Ñäµ½ÁäˆøñÍÁ…¸û’îï–*‡¢¾Óšb8ğ½ÍÁ…¸øñI¥¡Q•áĞ½¹Ñ•¹Ğõí½¹Ñ•¹Ñô€¼øğ½Í•Ñ¥½¸ùô(€€€€€íÑ…Í¬€˜˜€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰ÁÉ½•ÍÌµ±¥ÍĞˆ…É¥„µ±…‰•°ô‹–Ş—–ßš&Ÿ¢†3¢ºÃ–öTˆø(€€€€€€€íÑ…Í¬¹Á±…¸¹ÍÑ•ÁÌ¹µ…À ¡ÍÑ•À°¥¹‘•à¤€ôøì(€€€€€€€€€½¹ÍĞÁÉ½É•ÍÌ€ôÑ…Í­MÑ•ÁAÉ½É•ÍÌ¡Ñ…Í¬°¥¹‘•à¤ì(€€€€€€€€€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”õíÁÉ½•ÍÌµÉ½Ü€‘íÁÉ½É•ÍÌ¹±…ÍÍ9…µ•õô­•äõíÍÑ•À¹¥‘ôø(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰ÁÉ½•ÍÌµ¥¹‘•àˆùí¥¹‘•à€¬€Åôğ½ÍÁ…¸ø(€€€€€€€€€€ñ‘¥ØøñÍÑÉ½¹œùíÑ½½±1…‰•°¡ÍÑ•À¹Ñ½½°¥ôğ½ÍÑÉ½¹œøñ½‘”ùíÍÑ•À¹Ñ½½±ôğ½½‘”øğ½‘¥Øø(€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õíÁÉ½•ÍÌµÍÑ…Ñ”€‘íÁÉ½É•ÍÌ¹±…ÍÍ9…µ•õôùíÁÉ½É•ÍÌ¹±…‰•±ôğ½ÍÁ…¸ø(€€€€€€€€ğ½‘¥Øùô¥ô(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰ÁÉ½•ÍÌµÑ…É•ĞˆøñÍÁ…¸ûn»š‚–º{’ú,ğ½ÍÁ…¸øñÍÑÉ½¹œùí¥¹ÍÑ…¹•9…µ”€üüÑ…Í¬¹¥¹ÍÑ…¹•}É•™ôğ½ÍÑÉ½¹œøñÑ¥µ”ùí¹•Ü…Ñ”¡Ñ…Í¬¹ÕÁ‘…Ñ•‘}…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈÄÈè™…±Í”ô¥ôğ½Ñ¥µ”øğ½‘¥Øø(€€€€€€ğ½Í•Ñ¥½¸ùô(€€€€€ì…¥Í½µÁ±•Ñ”€˜˜±¥Ù•Ù¥‘•¹”¹±•¹Ñ €ø€À€˜˜€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰±¥Ù”µ•Ù¥‘•¹”ˆ…É¥„µ±…‰•°ô‹–º{š^Û–n{¢Âˆø(€€€€€€€€ñÍÑÉ½¹œûšršZÃ–n{¢Âğ½ÍÑÉ½¹œø(€€€€€€€í±¥Ù•Ù¥‘•¹”¹µ…À ¡¥Ñ•´°¥¹‘•à¤€ôø€ñÀ­•äõí€‘í¥Ñ•´¹…Ñô´‘í¥¹‘•áõôøñÍÁ…¸€¼ø€ñˆùí¥Ñ•´¹ÍÕµµ…Éåôğ½ˆøñ½‘”ùí•Ù¥‘•¹•1…‰•°¡¥Ñ•´¹­¥¹¥ôğ½½‘”øñÑ¥µ”ùí¹•Ü…Ñ”¡¥Ñ•´¹…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ğˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ğˆô¥ôğ½Ñ¥µ”øğ½Àø¥ô(€€€€€€ğ½Í•Ñ¥½¸ùô(€€€€€í™…¥±•‘Q…Í¬€˜˜€ñ‘¥Ø±…ÍÍ9…µ”ô‰™…¥±ÕÉ”µ…¹…±åÍ¥Ìˆø(€€€€€€€€ñ‘¥ØøñÍÑÉ½¹œû–’Ç¢Ò—–:–n€ğ½ÍÑÉ½¹œøñÀùí‘¥…¹½Í¥Ìü¹ÍÕµµ…Éä€üü€‹šr«šRÛ–"Ã–>¿¢¾–"¯j¢¾+šZ·¢¾š6»¾ò3¢¾ßšš~—–º{’ú/š:Ÿ–"Û–>Ãš^—–ş_‰ôğ½Àøğ½‘¥Øø(€€€€€€€€ñ‘¥ØøñÍÑÉ½¹œû’â/’âš¶”ğ½ÍÑÉ½¹œøñÀùíÉ•½Ù•Éäü¹ÍÕµµ…Éä€üü€‹¢¾+šZ·¢¾š6»–ŞË’şw–¶c¾òo¢¾ß’ş»–’7–:–nƒ–B;–7¦7¢¾W’îï–*‡‰ôğ½Àøğ½‘¥Øø(€€€€€€ğ½‘¥Øùô(€€€€€íÑ…Í¬ü¹ÍÑ…Ñ”€ôôô€‰]%Q%9}=9%I5Q%=8ˆ€˜˜€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰½¹™¥É´µ¥¹±¥¹”ˆ½¹±¥¬õì ¤€ôø½¹I•Ù¥•Ü¡Ñ…Í¬¥ôûšš~—–æÛ†»¢º“š&Ÿ¢†0ğ½‰ÕÑÑ½¸ùô(€€€€ğ½‘¥Øø(€€ğ½‘•Ñ…¥±Ìøì)ô()™Õ¹Ñ¥½¸Q…Í­=ÕÑ½µ”¡ìÑ…Í¬ôèìÑ…Í¬èQ…Í­I•½Éô¤ì(€½¹ÍĞ•Ù¥‘•¹”€ôÑ…Í¬¹•Ù¥‘•¹”¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÕµµ…Éä¹ÑÉ¥´ ¤¤¹Í±¥” ´ÄÈ¤ì(€½¹ÍĞ™…¥±•€ôÑ…Í¬¹ÍÑ…Ñ”€„ôô€‰MUˆì(€É•ÑÕÉ¸€ñ‘•Ñ…¥±Ì±…ÍÍ9…µ”ô‰É•ÍÕ±Ğµ•Ù¥‘•¹”ˆø(€€€€ñÍÕµµ…ÉäøñÍÁ…¸û–ÆW–ò¢–"K’â;š&Ÿ¢†3¢ö£¢şäğ½ÍÁ…¸øñÍµ…±°ùíÑ…Í¬¹Á±…¸¹ÍÑ•ÁÌ¹±•¹Ñ¡ôƒ’â«–Ş—–Üƒ
Üí•Ù¥‘•¹”¹±•¹Ñ¡ôƒšv‡¢ºÃ–öTğ½Íµ…±°øñ¡•ÙÉ½¹½İ¸Í¥é”õìÄÑô…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼øğ½ÍÕµµ…Éäø(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É•ÍÕ±ĞµÑÉ…”ˆø(€€€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰É•ÍÕ±ĞµÑÉ…”µÍ•Ñ¥½¸ˆ…É¥„µ±…‰•°ô‹¢–"KšFc¢šˆø(€€€€€€€€ñÍÑÉ½¹œû¢–"Hğ½ÍÑÉ½¹œø(€€€€€€€€ñÀøñÍÁ…¸€¼øñˆùíÑ…Í¬¹¥¹Ñ•¹Ğ¹ÍÁ±¥Ğ ‰q¹q¹•¹Ğ½Á•É…Ñ¥½¸èˆ¥lÁuôğ½ˆøñ½‘”û’îï–*‡n»š‚ğ½½‘”øñ•´±…ÍÍ9…µ”õí™…¥±•€ü€‰™…¥±•ˆ€è€‰ÍÕ•ÍÌ‰ôùí™…¥±•€ü€‹šr«–º3š"@ˆ€è€‹–ŞË–º3š"@‰ôğ½•´øğ½Àø(€€€€€€ğ½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰É•ÍÕ±ĞµÑÉ…”µÍ•Ñ¥½¸ˆ…É¥„µ±…‰•°ô‹–Ş—–ß¢ÂR£¢ş¢,ˆø(€€€€€€€€ñÍÑÉ½¹œû–Ş—–ß¢ÂR ğ½ÍÑÉ½¹œø(€€€€€€€íÑ…Í¬¹Á±…¸¹ÍÑ•ÁÌ¹µ…À ¡ÍÑ•À°¥¹‘•à¤€ôø€ñÀ­•äõíÍÑ•À¹¥‘ôøñÍÁ…¸€¼øñˆùí¥¹‘•à€¬€Åô¸íÑ½½±1…‰•°¡ÍÑ•À¹Ñ½½°¥ôğ½ˆøñ½‘”ùíÍÑ•À¹Ñ½½±ôğ½½‘”øñ•´±…ÍÍ9…µ”õí™…¥±•€ü€‰™…¥±•ˆ€è€‰ÍÕ•ÍÌ‰ôùí™…¥±•€ü€‹šr«–º3š"@ˆ€è€‹–º3š"@‰ôğ½•´øğ½Àø¥ô(€€€€€€ğ½Í•Ñ¥½¸ø(€€€€€í•Ù¥‘•¹”¹±•¹Ñ €ø€À€˜˜€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰É•ÍÕ±ĞµÑÉ…”µÍ•Ñ¥½¸ˆ…É¥„µ±…‰•°ô‹š&Ÿ¢†3¢¾š6¸ˆø(€€€€€€€€ñÍÑÉ½¹œû–n{¢Â–"“šZ·’â;¦ª3¢¾ğ½ÍÑÉ½¹œø(€€€€€€€í•Ù¥‘•¹”¹µ…À ¡¥Ñ•´°¥¹‘•à¤€ôø€ñÀ­•äõí€‘í¥Ñ•´¹…Ñô´‘í¥¹‘•áõôøñÍÁ…¸€¼øñˆùí¥Ñ•´¹ÍÕµµ…Éåôğ½ˆøñ½‘”ùí•Ù¥‘•¹•1…‰•°¡¥Ñ•´¹­¥¹¥ôğ½½‘”øñÑ¥µ”ùí¹•Ü…Ñ”¡¥Ñ•´¹…Ğ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ğˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ğˆô¥ôğ½Ñ¥µ”øğ½Àø¥ô(€€€€€€ğ½Í•Ñ¥½¸ùô(€€€€ğ½‘¥Øø(€€ğ½‘•Ñ…¥±Ìøì)ô()™Õ¹Ñ¥½¸I•ÍÁ½¹Í•QÉ…”¡ìÉ½ÕÑ”°ÑÉ…”ôèìÉ½ÕÑ”üè½¹Ù•ÉÍ…Ñ¥½¹5•ÍÍ…•l‰É½ÕÑ”‰tìÑÉ…”üè½¹Ù•ÉÍ…Ñ¥½¹5•ÍÍ…•l‰ÑÉ…”‰tô¤ì(€½¹ÍĞÍÑ•ÁÌ€ôÑÉ…”ü¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹±…‰•°¹ÑÉ¥´ ¤ñğ¥Ñ•´¹É•ÍÕ±Ğ¹ÑÉ¥´ ¤¤€üümtì(€É•ÑÕÉ¸€ñ‘•Ñ…¥±Ì±…ÍÍ9…µ”ô‰É•ÍÕ±Ğµ•Ù¥‘•¹”É•ÍÁ½¹Í”µÑÉ…”ˆø(€€€€ñÍÕµµ…ÉäøñÍÁ…¸û–ÆW–ò–n{¶S¢ö£¢şäğ½ÍÁ…¸øñÍµ…±°ùíÍÑ•ÁÌ¹±•¹Ñ €ü€‘íÍÑ•ÁÌ¹±•¹Ñ¡ôƒ’â«–Ï¶[¢ºÃ–öU€€è€‹nÓš:—–n{¶Pƒ
Üƒšr«¢ÂR£–Ş—–Ü‰ôğ½Íµ…±°øñ¡•ÙÉ½¹½İ¸Í¥é”õìÄÑô…É¥„µ¡¥‘‘•¸ô‰ÑÉÕ”ˆ€¼øğ½ÍÕµµ…Éäø(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É•ÍÕ±ĞµÑÉ…”ˆø(€€€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰É•ÍÕ±ĞµÑÉ…”µÍ•Ñ¥½¸ˆø(€€€€€€€€ñÍÑÉ½¹œû–’BšFc¢šğ½ÍÑÉ½¹œø(€€€€€€€íÍÑ•ÁÌ¹±•¹Ñ €ø€À(€€€€€€€€€€üÍÑ•ÁÌ¹µ…À ¡¥Ñ•´°¥¹‘•à¤€ôø€ñÀ­•äõí€‘í¥Ñ•´¹ÍÑ…•ô´‘í¥¹‘•áõôøñÍÁ…¸€¼øñˆùí¥Ñ•´¹±…‰•±ôğ½ˆøñ½‘”ùí¥Ñ•´¹É•ÍÕ±Ñôğ½½‘”øñ•´±…ÍÍ9…µ”ô‰ÍÕ•ÍÌˆùíÑÉ…•MÑ…•1…‰•°¡¥Ñ•´¹ÍÑ…”¥ôğ½•´øğ½Àø¤(€€€€€€€€€€è€ñÀøñÍÁ…¸€¼øñˆû¢¾–"¯’âë~—¢¾¦^»¶Pğ½ˆøñ½‘”ùíÉ½ÕÑ”€üü€‰‘¥É•Ğ‰ôğ½½‘”øñ•´±…ÍÍ9…µ”ô‰ÍÕ•ÍÌˆû–ŞË–º3š"@ğ½•´øğ½Àùô(€€€€€€€€ñÀøñÍÁ…¸€¼ûšr³š²‡–n{¶Sšr«’ş»šRç–º{’ú/šZ’îÛš"[šr7–*‡–f£*Ûšğ½Àø(€€€€€€ğ½Í•Ñ¥½¸ø(€€€€ğ½‘¥Øø(€€ğ½‘•Ñ…¥±Ìøì)ô()™Õ¹Ñ¥½¸I¥¡Q•áĞ¡ì½¹Ñ•¹Ğôèì½¹Ñ•¹ĞèÍÑÉ¥¹œô¤ì(€½¹ÍĞ‰±½­Ì€ô½¹Ñ•¹Ğ¹ÑÉ¥´ ¤¹ÍÁ±¥Ğ ½q¹ìÈ±ô¼¤ì(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰É¥ µµ•ÍÍ…”ˆùí‰±½­Ì¹µ…À ¡‰±½¬°‰±½­%¹‘•à¤€ôøì(€€€½¹ÍĞ±¥¹•Ì€ô‰±½¬¹ÍÁ±¥Ğ ‰q¸ˆ¤¹™¥±Ñ•È¡	½½±•…¸¤ì(€€€¥˜€¡±¥¹•Ì¹±•¹Ñ €˜˜±¥¹•Ì¹•Ù•Éä ¡±¥¹”¤€ôø€½yqÌ©l´©uqÌ¬¼¹Ñ•ÍĞ¡±¥¹”¤¤¤ì(€€€€€É•ÑÕÉ¸€ñÕ°­•äõí‰±½­%¹‘•áôùí±¥¹•Ì¹µ…À ¡±¥¹”°±¥¹•%¹‘•à¤€ôø€ñ±¤­•äõí±¥¹•%¹‘•áôùí¥¹±¥¹•Q•áĞ¡±¥¹”¹É•Á±…” ½yqÌ©l´©uqÌ¬¼°€ˆˆ¤¥ôğ½±¤ø¥ôğ½Õ°øì(€€€ô(€€€É•ÑÕÉ¸€ñÀ­•äõí‰±½­%¹‘•áôùí±¥¹•Ì¹µ…À ¡±¥¹”°±¥¹•%¹‘•à¤€ôø€ñÉ…µ•¹Ğ­•äõí±¥¹•%¹‘•áôùí¥¹±¥¹•Q•áĞ¡±¥¹”¥õí±¥¹•%¹‘•à€ğ±¥¹•Ì¹±•¹Ñ €´€Ä€˜˜€ñ‰È€¼ùôğ½É…µ•¹Ğø¥ôğ½Àøì(€ô¥ôğ½‘¥Øøì)ô()™Õ¹Ñ¥½¸¥¹±¥¹•Q•áĞ¡Ù…±Õ”èÍÑÉ¥¹œ¤èI•…Ñ9½‘•mtì(€É•ÑÕÉ¸Ù…±Õ”¹ÍÁ±¥Ğ ¼¡p©p©mx©t­p©p¨¤½œ¤¹™¥±Ñ•È¡	½½±•…¸¤¹µ…À ¡Á…ÉĞ°¥¹‘•à¤€ôø€ (€€€Á…ÉĞ¹ÍÑ…ÉÑÍ]¥Ñ  ˆ¨¨ˆ¤€˜˜Á…ÉĞ¹•¹‘Í]¥Ñ  ˆ¨¨ˆ¤€ü€ñÍÑÉ½¹œ­•äõí¥¹‘•áôùíÁ…ÉĞ¹Í±¥” È°€´È¥ôğ½ÍÑÉ½¹œø€èÁ…ÉĞ(€€¤¤ì)ô()™Õ¹Ñ¥½¸Ñ•Éµ¥¹…°¡ÍÑ…Ñ”èÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸l‰MUˆ°€‰%1ˆ°€‰I=11}	,ˆ°€‰I)Qˆ°€‰911ˆ°€‰aA%Iˆ°€‰59U1}%9QIY9Q%=8‰t¹¥¹±Õ‘•Ì¡ÍÑ…Ñ”¤ìô)™Õ¹Ñ¥½¸Í…µ•5•ÍÍ…•1¥ÍĞ¡±•™Ğè½¹Ù•ÉÍ…Ñ¥½¹5•ÍÍ…•mt°É¥¡Ğè½¹Ù•ÉÍ…Ñ¥½¹5•ÍÍ…•mt¤ì(€É•ÑÕÉ¸±•™Ğ¹±•¹Ñ €ôôôÉ¥¡Ğ¹±•¹Ñ €˜˜±•™Ğ¹•Ù•Éä ¡µ•ÍÍ…”°¥¹‘•à¤€ôøì(€€€½¹ÍĞ…¹‘¥‘…Ñ”€ôÉ¥¡Ñm¥¹‘•átì(€€€É•ÑÕÉ¸…¹‘¥‘…Ñ”(€€€€€€˜˜µ•ÍÍ…”¹¥€ôôô…¹‘¥‘…Ñ”¹¥(€€€€€€˜˜µ•ÍÍ…”¹½¹Ñ•¹Ğ€ôôô…¹‘¥‘…Ñ”¹½¹Ñ•¹Ğ(€€€€€€˜˜µ•ÍÍ…”¹Ñ…Í­}¥€ôôô…¹‘¥‘…Ñ”¹Ñ…Í­}¥(€€€€€€˜˜µ•ÍÍ…”¹Ñ…Í­}Á¡…Í”€ôôô…¹‘¥‘…Ñ”¹Ñ…Í­}Á¡…Í”(€€€€€€˜˜µ•ÍÍ…”¹É•…Ñ•‘}…Ğ€ôôô…¹‘¥‘…Ñ”¹É•…Ñ•‘}…Ğì(€ô¤ì)ô)™Õ¹Ñ¥½¸Ñ…Í­Ñ¥Ù¥Ñå1…‰•°¡ÍÑ…Ñ”èÍÑÉ¥¹œ¤ì(€¥˜€¡ÍÑ…Ñ”€ôôô€‰]%Q%9}=9%I5Q%=8ˆ¤É•ÑÕÉ¸€‹–ú†»¢ºˆì(€¥˜€¡ÍÑ…Ñ”€ôôô€‰MUˆ¤É•ÑÕÉ¸€‹–ŞË–º3š"@ˆì(€¥˜€¡Ñ•Éµ¥¹…°¡ÍÑ…Ñ”¤¤É•ÑÕÉ¸€‹šr«–º3š"@ˆì(€É•ÑÕÉ¸€‹–’B’â´ˆì)ô)™Õ¹Ñ¥½¸Ñ…Í­MÑ•ÁAÉ½É•ÍÌ¡Ñ…Í¬èQ…Í­I•½É°¥¹‘•àè¹Õµ‰•È¤ì(€¥˜€¡Ñ…Í¬¹ÍÑ…Ñ”€ôôô€‰MUˆ¤É•ÑÕÉ¸ì±…ÍÍ9…µ”è€‰ÍÕ•ÍÌˆ°±…‰•°è€‹–º3š"@ˆôì(€¥˜€¡Ñ•Éµ¥¹…°¡Ñ…Í¬¹ÍÑ…Ñ”¤¤É•ÑÕÉ¸ì±…ÍÍ9…µ”è€‰™…¥±•ˆ°±…‰•°è€‹šr«–º3š"@ˆôì(€½¹ÍĞÉ•ÍÕ±Ñ-¥¹‘Ì€ô¹•ÜM•Ğ¡l‰½¹Í½±”ˆ°€‰™¥±•Ìˆ°€‰±½Ìˆ°€‰½¹™¥œˆ°€‰¥¹ÍÑ…¹”ˆ°€‰‘½İ¹±½…ˆ°€‰Á±Õ¥¸ˆ°€‰Ù•É¥™¥…Ñ¥½¸‰t¤ì(€½¹ÍĞ½µÁ±•Ñ•€ôÑ…Í¬¹ÍÑ…Ñ”€ôôô€‰YI%e%9ˆ(€€€€üÑ…Í¬¹Á±…¸¹ÍÑ•ÁÌ¹±•¹Ñ (€€€€è5…Ñ ¹µ¥¸¡Ñ…Í¬¹Á±…¸¹ÍÑ•ÁÌ¹±•¹Ñ °Ñ…Í¬¹•Ù¥‘•¹”¹™¥±Ñ•È ¡¥Ñ•´¤€ôøÉ•ÍÕ±Ñ-¥¹‘Ì¹¡…Ì¡¥Ñ•´¹­¥¹¤¤¹±•¹Ñ ¤ì(€¥˜€¡¥¹‘•à€ğ½µÁ±•Ñ•¤É•ÑÕÉ¸ì±…ÍÍ9…µ”è€‰ÍÕ•ÍÌˆ°±…‰•°è€‹–º3š"@ˆôì(€¥˜€¡¥¹‘•à€ôôô½µÁ±•Ñ•€˜˜l‰M9AM!=QQ%9ˆ°€‰aUQ%9ˆ°€‰YI%e%9‰t¹¥¹±Õ‘•Ì¡Ñ…Í¬¹ÍÑ…Ñ”¤¤É•ÑÕÉ¸ì±…ÍÍ9…µ”è€‰…Ñ¥Ù”ˆ°±…‰•°èÑ…Í¬¹ÍÑ…Ñ”€ôôô€‰YI%e%9ˆ€ü€‹¦ª3¢¾’â´ˆ€è€‹š&Ÿ¢†3’â´ˆôì(€É•ÑÕÉ¸ì±…ÍÍ9…µ”è€‰Á•¹‘¥¹œˆ°±…‰•°è€‹¶'–úˆôì)ô)™Õ¹Ñ¥½¸É¥Í­1…‰•°¡É¥Í¬èÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸€¡ìÉ•…è€‹–>«¢¾ìˆ°±½Üè€‹’ö;¦;¦f¤ˆ°µ•‘¥Õ´è€‹’â·¦;¦f¤ˆ°¡¥ è€‹¦®c¦;¦f¤ˆ°™½É‰¥‘‘•¸è€‹šš¶ˆˆô…ÌI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø¥mÉ¥Í­t€üüÉ¥Í¬ìô)™Õ¹Ñ¥½¸ÍÑ…Ñ•1…‰•°¡ÍÑ…Ñ”èÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸€¡ìIQè€‹š¶–r£Rš"C¢º‡–"Hˆ°A=1%e}!-è€‹¶[V—–ŞËš‚‡¦ª0ˆ°]%Q%9}=9%I5Q%=8è€‹¶'–ú†»¢ºˆ°M9AM!=QQ%9è€‹––’š&Ÿ¢†0ˆ°aUQ%9è€‹š¶–r£š&Ÿ¢†0ˆ°YI%e%9è€‹š¶–r£¦ª3¢¾ˆ°MUè€‹šN7’ösš"C–*|ˆ°%1è€‹š&Ÿ¢†3–’Ç¢Ò”ˆ°I)Qè€‹¶[V—–ŞËš.Kîtˆ°I=11%9}	,è€‹š¶–r£–n{šîhˆ°I=11}	,è€‹–ŞËš‹–’4ˆ°59U1}%9QIY9Q%=8è€‹¦r¢š’êë–Ş—–’Bˆô…ÌI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø¥mÍÑ…Ñ•t€üüÍÑ…Ñ”ìô)™Õ¹Ñ¥½¸Ñ½½±1…‰•°¡Ñ½½°èÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸€¡ì€‰±½Ì¹ÅÕ•Éäˆè€‹¢¾ï–>[nã–Ïš^—–ş\ˆ°€‰™¥±•Ì¹±¥ÍĞˆè€‹–"_–ën»–öWšZ’îØˆ°€‰™¥±”¹‘½İ¹±½…ˆè€‹’â/¢ö÷–ºcšZäA…Á•Èƒšr7–*‡®¼ˆ°€‰Í•ÉÙ•È¹¥¹ÍÑ…±°ˆè€‹–º'¢5¥¹•É…™Ğƒšr7–*‡®¼ˆ°€‰½¹™¥œ¹Á…Ñ ˆè€‹’ş»šRçšr7–*‡–f£¦7ö¸ˆ°€‰½¹Í½±”¹½µµ…¹ˆè€‹–>G¦š:Ÿ–"Û–>Ã–F÷’îˆ°€‰Á±Õ¥¸¹É•Í½±Ù”ˆè€‹¢šzCš>K’îÛ–ó–ºçšœˆ°€‰Á±Õ¥¸¹¥¹ÍÑ…±°ˆè€‹–º'¢–ŞËš‚‡¦ª3š>K’îØˆ°€‰¥¹ÍÑ…¹”¹ÍÑ…ÉĞˆè€‹–B¿–*£šr7–*‡–f ˆ°€‰¥¹ÍÑ…¹”¹ÍÑ½Àˆè€‹–sš¶‹šr7–*‡–f ˆ°€‰¥¹ÍÑ…¹”¹É•ÍÑ…ÉĞˆè€‹¦7–B¿–æÛ¶'–ú¢Ï–ºhˆ°€‰Í¹…ÁÍ¡½Ğ¹É•ÍÑ½É”ˆè€‹š‹–’7–ş¯œˆô…ÌI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø¥mÑ½½±t€üüÑ½½°ìô)™Õ¹Ñ¥½¸•Ù¥‘•¹•1…‰•°¡­¥¹èÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸€¡ìÍÑ…Ñ”è€‹*Ûšˆ°Ñ½½°è€‹–Ş—–Üˆ°½¹Í½±”è€‹š:Ÿ–"Û–>Ã–n{¢Âˆ°™¥±•Ìè€‹šZ’îÛ–n{¢Âˆ°Ù•É¥™¥…Ñ¥½¸è€‹¦ª3¢¾ˆ°‘¥…¹½Í¥Ìè€‹–’Ç¢Ò—–"šz@ˆ°‘•¥Í¥½¸è€‹–Ï¶Xˆ°¥¹ÍÑ…¹”è€‹–º{’ú/*Ûšˆ°Á±Õ¥¸è€‹š>K’îÛ¢¾š6¸ˆô…ÌI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø¥m­¥¹‘t€üü­¥¹ìô)™Õ¹Ñ¥½¸ÑÉ…•MÑ…•1…‰•°¡ÍÑ…”èÍÑÉ¥¹œ¤ìÉ•ÑÕÉ¸€¡ìÉ½ÕÑ¥¹œè€‹¢Ş¿RÄˆ°‘•±•…Ñ¥½¸è€‹–SšÒøˆ°Ñ½½°è€‹–Ş—–Üˆ°É•Ù¥•Üè€‹šš~”ˆ°É•Ù¥Í¥½¸è€‹’ş»š¶Œˆ°™¥¹…°è€‹–º3š"@ˆô…ÌI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø¥mÍÑ…•t€üüÍÑ…”ìô)™Õ¹Ñ¥½¸¥¹ÍÑ…¹•5•Ñ„¡¥¹ÍÑ…¹”èM•ÉÙ•ÉAÉ½™¥±”¤ì(€½¹ÍĞÙ…±Õ•Ì€ôm¥¹ÍÑ…¹”¹±½…‘•È°¥¹ÍÑ…¹”¹µ¥¹•É…™Ñ}Ù•ÉÍ¥½¹t(€€€€¹™¥±Ñ•È ¡Ù…±Õ”¤èÙ…±Õ”¥ÌÍÑÉ¥¹œ€ôø	½½±•…¸¡Ù…±Õ”€˜˜Ù…±Õ”¹Ñ½1½İ•É…Í” ¤€„ôô€‰Õ¹­¹½İ¸ˆ¤¤ì(€¥˜€¡Ù…±Õ•Ì¹±•¹Ñ ¤É•ÑÕÉ¸Ù…±Õ•Ì¹©½¥¸ ˆƒ
Ü€ˆ¤ì(€É•ÑÕÉ¸¥¹ÍÑ…¹”¹ÁÉ½Ù¥‘•É}ÑåÁ”€ôôô€‰µÍµ…¹…•Èˆ€ü€‰5M5…¹…•Èˆ€è€‰AÑ•É½‘…Ñå°ˆì)ô()™Õ¹Ñ¥½¸É•…Ñ•I•ÅÕ•ÍÑ% ¤ì(€½¹ÍĞÉåÁÑ½Á¤€ôÑåÁ•½˜±½‰…±Q¡¥Ì¹ÉåÁÑ¼€ôôô€‰½‰©•Ğˆ€ü±½‰…±Q¡¥Ì¹ÉåÁÑ¼€èÕ¹‘•™¥¹•ì(€¥˜€¡±½‰…±Q¡¥Ì¹¥ÍM•ÕÉ•½¹Ñ•áĞ€˜˜ÑåÁ•½˜ÉåÁÑ½Á¤ü¹É…¹‘½µUU%€ôôô€‰™Õ¹Ñ¥½¸ˆ¤É•ÑÕÉ¸ÉåÁÑ½Á¤¹É…¹‘½µUU% ¤ì(€½¹ÍĞ•¹ÑÉ½Áä€ô¹•ÜU¥¹ĞÌÉÉÉ…ä Ì¤ì(€¥˜€¡ÉåÁÑ½Á¤ü¹•ÑI…¹‘½µY…±Õ•Ì¤ÉåÁÑ½Á¤¹•ÑI…¹‘½µY…±Õ•Ì¡•¹ÑÉ½Áä¤ì(€•±Í”•¹ÑÉ½Áä¹Í•Ğ¡m…Ñ”¹¹½Ü ¤°5…Ñ ¹™±½½È¡5…Ñ ¹É…¹‘½´ ¤€¨€Áá™™™™™™™˜¤°5…Ñ ¹™±½½È¡5…Ñ ¹É…¹‘½´ ¤€¨€Áá™™™™™™™˜¥t¤ì(€É•ÑÕÉ¸É•ÅÕ•ÍÑ|‘í…Ñ”¹¹½Ü ¤¹Ñ½MÑÉ¥¹œ ÌØ¥õ|‘íÉÉ…ä¹™É½´¡•¹ÑÉ½Áä°€¡Ù…±Õ”¤€ôøÙ…±Õ”¹Ñ½MÑÉ¥¹œ ÌØ¤¤¹©½¥¸ ‰|ˆ¥õ€ì)ô