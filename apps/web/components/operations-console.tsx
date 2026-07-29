"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, Bot, Check, ChevronRight, CircleDot, ClipboardCheck,
  Cloud, FileClock, KeyRound, LoaderCircle, LockKeyhole, LogOut, Menu,
  MessageSquareText, RefreshCw, RotateCcw, Send, Server, ShieldCheck, UserRound, X,
} from "lucide-react";
import type { ServerProfile, TaskRecord } from "@mcai/contracts";
import { api } from "../lib/api";
import { AgentWorkspace } from "./agent-workspace";

type Agent = { id: string; displayName: string; status: "online" | "offline" | "pending"; version: string; lastSeen: string; tenantId?: string };
type Screen = "checking" | "setup" | "login" | "console" | "unavailable";
type SetupStatus = { configured: boolean; username?: string; configuredAt?: string };

export function OperationsConsole() {
  const [screen, setScreen] = useState<Screen>("checking");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [instances, setInstances] = useState<ServerProfile[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selected, setSelected] = useState("");
  const [intent, setIntent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cloudOnline, setCloudOnline] = useState(false);
  const [reviewTask, setReviewTask] = useState<TaskRecord | null>(null);
  const [highRiskText, setHighRiskText] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:23333");
  const [apiKey, setApiKey] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextAgents, nextInstances, nextTasks] = await Promise.all([
        api<Agent[]>("/agents"), api<ServerProfile[]>("/instances"), api<TaskRecord[]>("/tasks"),
      ]);
      setAgents(nextAgents); setInstances(nextInstances); setTasks(nextTasks); setCloudOnline(true); setError("");
      setSelected((current) => current || nextInstances[0]?.instance_id || "");
    } catch (cause) {
      setCloudOnline(false); setError(cause instanceof Error ? cause.message : "无法连接云端");
    }
  }, []);

  useEffect(() => {
    api<SetupStatus>("/setup/status")
      .then((status) => {
        setCloudOnline(true);
        if (status.username) setUsername(status.username);
        if (!status.configured) setScreen("setup");
        else setScreen(sessionStorage.getItem("mcai_token") ? "console" : "login");
      })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : "无法读取系统状态"); setScreen("unavailable"); });
    const unauthorized = () => setScreen("login");
    window.addEventListener("mcai:unauthorized", unauthorized);
    return () => window.removeEventListener("mcai:unauthorized", unauthorized);
  }, []);

  useEffect(() => {
    if (screen !== "console") return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, screen]);
  const current = instances.find((item) => item.instance_id === selected);
  const currentTasks = useMemo(() => tasks.filter((task) => task.instance_ref === selected), [tasks, selected]);
  const activeTask = currentTasks.find((task) => !terminal(task.state)) ?? currentTasks[0];
  async function configure() {
    setError("");
    if (password !== confirmPassword) return setError("两次输入的管理员密码不一致");
    setLoading(true);
    try {
      await api("/setup", { method: "POST", body: JSON.stringify({ username, password, endpoint, apiKey }) });
      setApiKey(""); setConfirmPassword(""); setPassword(""); setScreen("login");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "初始化失败"); }
    finally { setLoading(false); }
  }

  async function login() {
    setError(""); setLoading(true);
    try {
      const session = await api<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      sessionStorage.setItem("mcai_token", session.token);
      setPassword(""); setScreen("console");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setLoading(false); }
  }

  function logout() {
    sessionStorage.removeItem("mcai_token");
    setAgents([]); setInstances([]); setTasks([]); setSelected(""); setScreen("login");
  }

  async function submitIntent() {
    if (!current || !intent.trim()) return;
    setLoading(true);
    try {
      const task = await api<TaskRecord>("/tasks", { method: "POST", body: JSON.stringify({ instance_ref: current.instance_id, intent }) });
      setIntent(""); await refresh();
      if (task.state === "WAITING_CONFIRMATION") setReviewTask(task);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "任务创建失败"); }
    finally { setLoading(false); }
  }

  async function confirmTask() {
    if (!reviewTask || !current) return;
    if (reviewTask.risk === "high" && highRiskText !== current.name) return;
    setLoading(true);
    try {
      const confirmation = await api<{ token: string }>(`/tasks/${reviewTask.id}/confirmation`, { method: "POST" });
      await api(`/tasks/${reviewTask.id}/confirm`, { method: "POST", body: JSON.stringify({ token: confirmation.token }) });
      setReviewTask(null); setHighRiskText(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "确认失败"); }
    finally { setLoading(false); }
  }

  if (screen === "checking") {
    return <main className="splash-screen"><img src="/brand/mcai-logo-primary.png" alt="MCAI Sidecar" /><LoaderCircle className="spin" size={20} /><span>正在读取系统状态</span></main>;
  }

  if (screen === "setup") {
    return <main className="setup-shell">
      <section className="setup-panel" aria-labelledby="setup-title">
        <img className="setup-logo" src="/brand/mcai-logo-primary.png" alt="MCAI Sidecar" />
        <div className="setup-kicker"><ShieldCheck size={15} /> 首次安装向导</div>
        <h1 id="setup-title">配置你的<br className="desktop-break" /> MCAI Sidecar</h1>
        <p className="setup-lead">验证 MCSManager 连接并创建本地管理员。完成后 Agent 会自动登记，不再需要配对码。</p>
        <ol className="setup-steps">
          <li className="setup-step active"><span>01</span><div><strong>连接 MCSManager</strong><small>验证地址与 API Key 权限</small></div></li>
          <li className="setup-step active"><span>02</span><div><strong>创建管理员</strong><small>管理员密码只保存为安全哈希</small></div></li>
          <li className="setup-step"><span>03</span><div><strong>自动启动 Agent</strong><small>发现节点并同步实例档案</small></div></li>
        </ol>
        <div className="install-form">
          <label><span>MCSManager 地址</span><div className="input-with-icon"><Server size={16} /><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:23333" autoComplete="url" /></div><small>同机安装时保留默认地址即可</small></label>
          <label><span>MCSManager API Key</span><div className="input-with-icon"><KeyRound size={16} /><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value.trim())} placeholder="仅用于本机 Agent" autoComplete="off" /></div><small>写入服务器本地凭据文件，不会再次显示</small></label>
          <div className="form-row">
            <label><span>管理员账号</span><div className="input-with-icon"><UserRound size={16} /><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="admin" autoComplete="username" /></div></label>
            <label><span>管理员密码</span><div className="input-with-icon"><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 位" autoComplete="new-password" /></div></label>
          </div>
          <label><span>确认管理员密码</span><div className="input-with-icon"><LockKeyhole size={16} /><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" autoComplete="new-password" /></div></label>
          <button className="primary install-submit" onClick={() => void configure()} disabled={loading || !apiKey || username.length < 3 || password.length < 10 || !confirmPassword}>{loading ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}验证并完成安装</button>
        </div>
        {error && <div className="setup-error" role="alert"><AlertTriangle size={16} />{error}</div>}
        <p className="setup-footnote"><ShieldCheck size={14} /> API Key 只保存在服务器本机；高风险操作仍必须由管理员确认。</p>
      </section>
      <aside className="setup-aside">
        <div className="aside-symbol"><img src="/brand/mcai-symbol.png" alt="" /></div>
        <div className="aside-copy"><span className="eyebrow">SECURE CONTROL PLANE</span><h2>每次变更，<br />都清晰可追溯。</h2><p>计划、快照、验证和审计证据都在同一条任务链上。</p></div>
        <div className="trust-list"><div><ShieldCheck size={17} /><span><strong>受控执行</strong><small>不开放任意 Shell</small></span></div><div><RotateCcw size={17} /><span><strong>失败可恢复</strong><small>写操作关联快照</small></span></div></div>
        <div className="setup-status"><span className={`status-dot ${cloudOnline ? "running" : "starting"}`} /> {cloudOnline ? "Cloud API 已连接" : "正在连接 Cloud API"}</div>
      </aside>
    </main>;
  }

  if (screen === "unavailable") {
    return <main className="splash-screen" role="alert">
      <img src="/brand/mcai-logo-primary.png" alt="MCAI Sidecar" />
      <AlertTriangle size={22} />
      <strong>暂时无法连接 Cloud API</strong>
      <span>{error || "请检查服务状态后重试"}</span>
      <button className="primary" onClick={() => window.location.reload()}>重新连接</button>
    </main>;
  }

  if (screen === "login") {
    return <main className="login-shell">
      <section className="login-panel">
        <img className="login-logo" src="/brand/mcai-logo-primary.png" alt="MCAI Sidecar" />
        <div className="setup-kicker"><LockKeyhole size={15} /> 管理员入口</div>
        <h1>欢迎回来</h1>
        <p>登录后管理实例、任务计划与审计证据。</p>
        <div className="login-form">
          <label><span>管理员账号</span><div className="input-with-icon"><UserRound size={17} /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></div></label>
          <label><span>管理员密码</span><div className="input-with-icon"><LockKeyhole size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void login(); }} autoComplete="current-password" /></div></label>
          {error && <div className="setup-error" role="alert"><AlertTriangle size={16} />{error}</div>}
          <button className="primary login-submit" onClick={() => void login()} disabled={loading || !username || !password}>{loading ? <LoaderCircle className="spin" size={18} /> : <LogOut size={18} />}登录控制台</button>
        </div>
        <div className="login-security"><ShieldCheck size={15} /><span>会话保存在当前标签页，关闭后自动退出</span></div>
      </section>
      <aside className="login-aside"><div className="aside-symbol"><img src="/brand/mcai-symbol.png" alt="" /></div><span>安全、可审计、可回滚</span></aside>
    </main>;
  }

  if (screen === "console") return <AgentWorkspace onLogout={logout} />;

  return (
    <main className="shell">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开实例列表"><Menu size={19} /></button>
        <div className="brand"><span className="brand-symbol"><img src="/brand/mcai-symbol.png" alt="" /></span><strong>MCAI</strong><span>SIDECAR</span></div>
        <div className="topbar-context">{current ? <><Server size={15} /><span>{current.name}</span><span className="slash">/</span><span>{current.loader} {current.minecraft_version}</span></> : "未选择实例"}</div>
        <div className={`cloud-state ${cloudOnline ? "online" : "offline"}`}><Cloud size={15} /><span>{cloudOnline ? "云端已连接" : "云端离线"}</span></div>
        <button className="icon-button" onClick={logout} aria-label="退出登录"><LogOut size={18} /></button>
      </header>

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-head"><span>实例</span><button className="icon-button" onClick={() => void refresh()} aria-label="刷新"><RefreshCw size={16} /></button><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <div className="instance-list">
          {instances.map((instance) => <button key={instance.instance_id} className={`instance-row ${selected === instance.instance_id ? "selected" : ""}`} onClick={() => { setSelected(instance.instance_id); setSidebarOpen(false); }}>
            <span className={`status-dot ${instance.state}`} /><span className="instance-copy"><strong>{instance.name}</strong><small>{instance.provider_type} · {instance.state}</small></span><ChevronRight size={16} />
          </button>)}
          {!instances.length && <div className="empty-compact"><Server size={20} /><span>尚未发现实例</span></div>}
        </div>
        <div className="agent-status-block">
          <span className={`status-dot ${agents.some((agent) => agent.status === "online") ? "running" : "starting"}`} />
          <div><strong>{agents.some((agent) => agent.status === "online") ? "Agent 已连接" : "Agent 正在连接"}</strong><small>{agents.length ? `${agents.filter((agent) => agent.status === "online").length}/${agents.length} 个节点在线` : "配置完成后会自动登记"}</small></div>
        </div>
      </aside>

      <section className="workspace">
        {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError("")} aria-label="关闭"><X size={15} /></button></div>}
        {current ? <>
          <div className="session-head">
            <div><span className="eyebrow">实例会话</span><h1>{current.name}</h1><p>{current.platform} · Minecraft {current.minecraft_version} · 档案 {current.profile_revision.slice(0, 8)}</p></div>
            <div className={`state-badge ${current.state}`}><CircleDot size={14} />{current.state === "running" ? "运行中" : current.state}</div>
          </div>

          <div className="conversation">
            {!currentTasks.length && <div className="empty-session"><MessageSquareText size={26} /><h2>开始一次受控运维</h2><p>提出诊断或变更目标。写操作会先展示计划、风险与恢复点。</p><div className="suggestions"><button onClick={() => setIntent("昨晚为什么崩服？")}>诊断最近崩服</button><button onClick={() => setIntent("把视距改成 10，先不要重启")}>修改视距</button><button onClick={() => setIntent("安装适配当前版本的 LuckPerms")}>安装插件</button></div></div>}
            {currentTasks.map((task) => <TaskTimeline key={task.id} task={task} onReview={() => setReviewTask(task)} />)}
          </div>
          <div className="composer"><textarea value={intent} onChange={(event) => setIntent(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitIntent(); } }} placeholder="描述你的运维目标…" rows={2} /><button className="send-button" onClick={() => void submitIntent()} disabled={loading || !intent.trim()} aria-label="发送任务">{loading ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}</button><div className="composer-meta"><ShieldCheck size={14} /> 计划通过策略校验后才会下发</div></div>
        </> : <div className="no-instance"><Server size={30} /><h1>连接第一台服务器</h1><p>启动 Agent、完成配对并授权实例后，实例会显示在这里。</p></div>}
      </section>

      <aside className="evidence-rail">
        <div className="rail-heading"><span>当前任务</span>{activeTask && <span className={`risk ${activeTask.risk}`}>{riskLabel(activeTask.risk)}</span>}</div>
        {activeTask ? <>
          <div className="task-summary"><strong>{activeTask.intent}</strong><span>{stateLabel(activeTask.state)}</span></div>
          <section className="rail-section"><h2><ClipboardCheck size={15} /> 执行计划</h2>{activeTask.plan.steps.map((step, index) => <div className="plan-step" key={step.id}><span>{index + 1}</span><div><strong>{toolLabel(step.tool)}</strong><small>{step.tool}</small></div></div>)}</section>
          <section className="rail-section"><h2><FileClock size={15} /> 证据</h2>{activeTask.evidence.slice(-5).reverse().map((item, index) => <div className="evidence" key={`${item.at}-${index}`}><span /><p>{item.summary}<small>{new Date(item.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></p></div>)}</section>
        </> : <div className="rail-empty"><Activity size={21} /><span>暂无进行中的任务</span></div>}
      </aside>

      {reviewTask && current && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setReviewTask(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <div className="modal-head"><div><span className={`risk ${reviewTask.risk}`}>{riskLabel(reviewTask.risk)}</span><h2 id="review-title">确认执行计划</h2></div><button className="icon-button" onClick={() => setReviewTask(null)} aria-label="关闭"><X size={18} /></button></div>
        <div className="scope-line"><Server size={16} /><span>{current.name}</span><span>{current.loader} {current.minecraft_version}</span></div>
        <p className="intent-review">{reviewTask.intent}</p>
        <div className="review-steps">{reviewTask.plan.steps.map((step, index) => <div key={step.id}><span>{index + 1}</span><div><strong>{toolLabel(step.tool)}</strong><code>{JSON.stringify(step.args)}</code></div></div>)}</div>
        <div className="snapshot-note"><RotateCcw size={17} /><div><strong>执行前创建恢复点</strong><span>失败时按工具策略恢复，并再次验证实例状态。</span></div></div>
        {reviewTask.risk === "high" && <label className="danger-confirm">输入实例名 <strong>{current.name}</strong> 以二次确认<input value={highRiskText} onChange={(event) => setHighRiskText(event.target.value)} /></label>}
        <div className="modal-actions"><button className="secondary" onClick={() => setReviewTask(null)}>取消</button><button className="primary" onClick={() => void confirmTask()} disabled={loading || (reviewTask.risk === "high" && highRiskText !== current.name)}>{loading ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}确认并执行</button></div>
      </div></div>}
    </main>
  );
}

function TaskTimeline({ task, onReview }: { task: TaskRecord; onReview: () => void }) {
  return <article className="task-message"><div className="user-intent"><span>你</span><p>{task.intent}</p></div><div className="system-response"><span className="bot-icon"><Bot size={16} /></span><div><div className="response-title"><strong>{task.model_status === "answered" ? "MCAI 助手" : stateLabel(task.state)}</strong><span className={`risk ${task.risk}`}>{riskLabel(task.risk)}</span></div><p>{task.assistant_response ?? task.evidence.at(-1)?.summary ?? "正在等待本地模型云回答…"}</p>{task.state === "WAITING_CONFIRMATION" && <button className="review-button" onClick={onReview}><ClipboardCheck size={16} />审阅计划</button>}{terminal(task.state) && <div className="result-line"><Check size={15} />{task.state === "SUCCEEDED" ? "验收完成，审计记录已保存" : "任务已结束，请查看证据"}</div>}</div></div></article>;
}

function terminal(state: string) { return ["SUCCEEDED", "FAILED", "ROLLED_BACK", "REJECTED", "CANCELLED", "EXPIRED", "MANUAL_INTERVENTION"].includes(state); }
function riskLabel(risk: string) { return ({ read: "只读", low: "低风险", medium: "中风险", high: "高风险", forbidden: "禁止" } as Record<string, string>)[risk] ?? risk; }
function stateLabel(state: string) { return ({ DRAFTED: "正在生成计划", POLICY_CHECKED: "策略已校验", WAITING_CONFIRMATION: "等待你的确认", SNAPSHOTTING: "正在创建快照", EXECUTING: "正在执行", VERIFYING: "正在验证", SUCCEEDED: "操作成功", FAILED: "执行失败", REJECTED: "策略已拒绝", ROLLING_BACK: "正在回滚", ROLLED_BACK: "已恢复", MANUAL_INTERVENTION: "需要人工处理" } as Record<string, string>)[state] ?? state; }
function toolLabel(tool: string) { return ({ "logs.query": "读取相关日志", "config.patch": "修改服务器配置", "plugin.resolve": "解析插件兼容性", "plugin.install": "安装已校验插件", "instance.restart": "重启并等待稳定", "snapshot.restore": "恢复快照" } as Record<string, string>)[tool] ?? tool; }
