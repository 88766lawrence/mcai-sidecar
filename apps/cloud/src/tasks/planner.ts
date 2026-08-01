import { randomUUID } from "node:crypto";
import type { RiskLevel, TaskPlan } from "@mcai/contracts";
import { TASK_PLAN_SCHEMA_VERSION } from "@mcai/contracts";

interface DraftPlanOptions {
  preferredTool?: string;
  platform?: string;
  minecraftVersion?: string;
  loader?: string;
}

export function draftPlan(instanceRef: string, inventoryRevision: string, intent: string, options: DraftPlanOptions = {}): TaskPlan {
  const id = `task_${randomUUID()}`;
  const normalized = intent.toLowerCase();
  if (/\b(?:stop|shutdown)\b|\u505c\u6b62|\u5173\u95ed|\u5173\u670d/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "instance.stop",
      args: { timeout_seconds: 120 },
      risk: "high",
      requires_confirmation: true,
    }], [{ type: "instance_state", expected: "stopped" }]);
  }
  const install = parseServerInstallIntent(normalized);
  if (install) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "server.install",
      args: {
        platform: install.platform,
        minecraft_version: install.minecraftVersion,
        target: "/server.jar",
        accept_eula: acceptsMinecraftEula(normalized),
      },
      risk: "low",
    }], [
      // A current Minecraft ready signal is stronger than the panel's
      // asynchronous process-status transition and is the actual user goal.
      { type: "server_ready" },
    ]);
  }
  if (/shell|ssh|私钥|任意命令/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "forbidden.shell", args: {}, risk: "forbidden" }], []);
  }
  if (options.preferredTool === "files.list") {
    const path = /(?:\/plugins\b|plugins[\\/]|插件目录)/i.test(intent) ? "/plugins" : "/";
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "files.list", args: { path }, risk: "read" }], []);
  }
  if (options.preferredTool === "logs.query") {
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "logs.query", args: { window_minutes: 60, max_lines: 500 }, risk: "read" }], []);
  }
  const consoleCommand = extractConsoleCommandIntent(intent);
  if (consoleCommand) {
    const risk = consoleCommandRisk(consoleCommand);
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "console.command",
      args: { command: consoleCommand },
      risk,
      ...(risk === "medium" || risk === "high" ? { requires_confirmation: true } : {}),
    }], []);
  }
  if (/(下载|download).*(paper|1\.21\.1|server\.jar)|(paper|1\.21\.1|server\.jar).*(下载|download)/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "logs.query",
      args: {
        url: "https://fill-data.papermc.io/v1/objects/39bd8c00b9e18de91dcabd3cc3dcfa5328685a53b7187a2f63280c22e2d287b9/paper-1.21.1-133.jar",
        target: "/server.jar",
      },
      risk: "low",
    }], []);
  }
  if (/视距|view-distance|配置|config/.test(normalized)) {
    const value = Number(intent.match(/(?:视距|view-distance)\D*(\d+)/i)?.[1] ?? 10);
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "config.patch",
      args: { path: "server.properties", patch: [{ op: "replace", key: "view-distance", value }], expected_revision: inventoryRevision },
      risk: "medium",
      requires_confirmation: true,
      rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" },
    }], [{ type: "config_semantics", expected: `view-distance=${value}` }]);
  }
  const pluginProject = parsePluginProject(intent);
  if (pluginProject && (options.preferredTool === "plugin.install" || options.preferredTool === "plugin.resolve" || /安装|部署|更新|升级|install|deploy|update/i.test(intent))) {
    return plan(id, instanceRef, inventoryRevision, intent, [
      { id: "s1", tool: "plugin.resolve", args: {
        project: pluginProject,
        source: "modrinth",
        platform: options.platform ?? "unknown",
        minecraft_version: options.minecraftVersion ?? "unknown",
        loader: options.loader ?? options.platform ?? "unknown",
      }, risk: "low" },
      { id: "s2", tool: "plugin.install", args: { project: pluginProject, artifact_ref: "${s1.artifact}", expected_sha256: "${s1.sha256}" }, risk: "medium", requires_confirmation: true, rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" } },
      { id: "s3", tool: "instance.restart", args: { timeout_seconds: 120 }, risk: "high", requires_confirmation: true },
    ], [
      { type: "instance_state", expected: "running" },
      { type: "plugin_enabled", name: pluginProject },
    ]);
  }
  if (/根目录|目录|文件|文件夹|list.*file|files?.*list|directory/.test(normalized)) {
    const path = /(?:\/plugins\b|plugins[\\/]|插件目录)/i.test(intent) ? "/plugins" : "/";
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "files.list",
      args: { path },
      risk: "read",
    }], []);
  }
  if (/启动|开机|开启|运行服务器|\bstart\b/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "instance.start",
      args: { timeout_seconds: 120 },
      risk: "low",
    }], [
      { type: "instance_state", expected: "running" },
    ]);
  }
  if (/重启|restart/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "instance.restart", args: { timeout_seconds: 120 }, risk: "high", requires_confirmation: true }], [
      { type: "instance_state", expected: "running" },
      { type: "log_absence", pattern: "(ERROR|Exception)" },
    ]);
  }
  return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "logs.query", args: { window_minutes: 60, max_lines: 500 }, risk: "read" }], []);
}

function parsePluginProject(intent: string) {
  const known = intent.match(/\b(essentialsx?|luckperms|viaversion|viabackwards|geyser|floodgate|spark|worldedit|worldguard|placeholderapi|vault)\b/i)?.[1];
  if (known) return known.toLowerCase() === "essentials" ? "essentialsx" : known.toLowerCase();
  const explicit = intent.match(/(?:安装|部署|更新|升级|install|deploy|update)\s+(?:the\s+)?([a-z0-9][a-z0-9_-]{1,63})(?:\s+(?:插件|plugin))?/i)?.[1];
  if (!explicit || /^(?:a|an|the|plugin|插件)$/i.test(explicit)) return undefined;
  return explicit.toLowerCase();
}

function parseServerInstallIntent(intent: string) {
  const isInstallAction = /(?:download|install|setup|deploy|launch|start|create|\u4e0b\u8f7d|\u5b89\u88c5|\u90e8\u7f72|\u542f\u52a8|\u5f00\u670d|\u521b\u5efa|\u8fd0\u884c)/i.test(intent);
  if (!isInstallAction) return undefined;
  const platform = /\bpaper\b/i.test(intent) ? "paper" : /\bfabric\b/i.test(intent) ? "fabric" : undefined;
  const minecraftVersion = intent.match(/(?:minecraft|mc|\u7248\u672c|version)?\s*(\d+\.\d+(?:\.\d+)?(?:-[a-z0-9._-]+)?)/i)?.[1];
  if (!platform || !minecraftVersion) return undefined;
  return { platform, minecraftVersion };
}

function acceptsMinecraftEula(intent: string) {
  const consent = /(?:\b(?:i\s+)?accept\b|\bagree\b|同意|接受)/i;
  const eula = /(?:minecraft\s+)?eula/i;
  const consentMatch = intent.match(consent);
  const eulaMatch = intent.match(eula);
  return Boolean(consentMatch && eulaMatch && Math.abs((consentMatch.index ?? 0) - (eulaMatch.index ?? 0)) <= 80);
}

export function extractConsoleCommandIntent(intent: string) {
  const patterns = [
    /(?:控制台|console)[^\r\n:：]{0,12}?(?:执行|输入|发送|运行|command|cmd)\s*[:：]?\s*(.+)$/i,
    /(?:执行|输入|发送|运行)\s*(?:到|至|在)?\s*(?:服务器|minecraft|mc)?\s*(?:控制台|console)(?:命令)?\s*[:：]?\s*(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = intent.match(pattern);
    if (!match) continue;
    const command = match[1].trim().replace(/^\//, "").replace(/^`(.+)`$/, "$1");
    if (command && command.length <= 256 && !/[\r\n]/.test(command)) return command;
  }

  // Common read-only operations should stay available even when the model
  // gateway is busy. They map to the same audited console tool as explicit
  // commands and never bypass the instance binding or risk policy.
  if (/\b(?:online players?|player count)\b|\u5728\u7ebf.{0,8}\u73a9\u5bb6|\u73a9\u5bb6.{0,8}\u5728\u7ebf|\u591a\u5c11.{0,4}\u73a9\u5bb6|\u5728\u7ebf.{0,4}\u4eba\u6570/i.test(intent)) {
    return "list";
  }
  if (/\b(?:tps|mspt)\b/i.test(intent)) return /\bmspt\b/i.test(intent) ? "mspt" : "tps";
  if (/\b(?:server version|minecraft version)\b|\u670d\u52a1\u7aef.{0,4}\u7248\u672c|\u670d\u52a1\u5668.{0,4}\u7248\u672c/i.test(intent)) {
    return "version";
  }
  if (/\b(?:plugin list|installed plugins?)\b|\u63d2\u4ef6.{0,4}\u5217\u8868|\u5df2\u5b89\u88c5.{0,4}\u63d2\u4ef6/i.test(intent)) {
    return "plugins";
  }
  return undefined;
}

export function extractRealtimeLogIntent(intent: string) {
  const message = intent.trim();
  const logSubject = /日志|崩服|崩溃|报错|错误|异常|卡服|无响应|logs?|crash(?:ed|es)?|errors?|exceptions?|stack\s*trace/i;
  if (!message || !logSubject.test(message)) return undefined;
  const realtimeSignal = /读取|查看|查询|检查|调取|获取|排查|诊断|最近|刚才|当前|实时|这台|这个实例|原因|为什么|read|show|query|check|inspect|fetch|recent|current|live|diagnos|why|cause/i;
  return realtimeSignal.test(message) ? message : undefined;
}

function consoleCommandRisk(command: string): RiskLevel {
  const rawVerb = command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const verb = rawVerb.replace(/^minecraft:/, "");
  if (["list", "help", "version", "plugins", "pl", "tps", "mspt", "seed"].includes(verb)) return "read";
  if (["say", "me"].includes(verb)) return "low";
  if (["time", "weather", "difficulty", "gamerule", "gamemode", "give", "clear", "tp", "teleport", "effect", "enchant", "xp", "experience", "setworldspawn", "spawnpoint"].includes(verb)) return "medium";
  return "high";
}

function plan(
  id: string,
  instanceRef: string,
  inventoryRevision: string,
  intent: string,
  steps: TaskPlan["steps"],
  acceptance: TaskPlan["acceptance"],
): TaskPlan {
  return { schema_version: TASK_PLAN_SCHEMA_VERSION, task_id: id, instance_ref: instanceRef, intent, inventory_revision: inventoryRevision, steps, acceptance };
}
