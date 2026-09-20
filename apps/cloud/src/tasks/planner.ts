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
  if (isReadonlyHealthInspection(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [
      { id: "s1", tool: "console.command", args: { command: "version" }, risk: "read" },
      { id: "s2", tool: "console.command", args: { command: "plugins" }, risk: "read" },
      { id: "s3", tool: "logs.query", args: { window_minutes: 60, max_lines: 500 }, risk: "read" },
    ], []);
  }
  const stopPattern = /\b(?:stop|shutdown)\b|\u505c\u6b62|\u5173\u95ed|\u5173\u670d/;
  const constrainedTool = options.preferredTool;
  const originalIntent = intent.split(/\n\s*\nAgent operation:\s*/i)[0];
  const namedProject = parsePluginProject(intent);
  const pluginContext = /插件|\bplugins?\b/i.test(intent) ||
    Boolean(namedProject && !["paper", "fabric"].includes(namedProject));
  if ((!constrainedTool || constrainedTool === "instance.stop") && stopPattern.test(normalized) &&
      !deniesAction(originalIntent, /\b(?:stop|shutdown|shut\s+down)\b|停止|关闭|关服/)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "instance.stop",
      args: { timeout_seconds: 120 },
      risk: "high",
      requires_confirmation: true,
    }], [{ type: "instance_state", expected: "stopped" }]);
  }
  const install = (!constrainedTool || constrainedTool === "server.install") &&
    !pluginContext &&
    !deniesAction(originalIntent, /安装|下载|部署|创建|\b(?:install|download|setup|deploy|create)\b/)
    ? parseServerInstallIntent(normalized) : undefined;
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
    const path = isPluginDirectoryIntent(intent) ? "/plugins" : "/";
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "files.list", args: { path }, risk: "read" }], []);
  }
  if (options.preferredTool === "logs.query") {
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "logs.query", args: { window_minutes: 60, max_lines: 500 }, risk: "read" }], []);
  }
  const configPath = extractConfigurationPath(intent);
  if (options.preferredTool === "config.inspect" && configPath) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1", tool: "config.inspect", args: { path: configPath }, risk: "read",
    }], []);
  }
  const configPatch = parseConfigurationPatch(intent);
  if (options.preferredTool === "config.patch" && configPatch &&
      !deniesAction(originalIntent, /修改|设置|改为|配置|\b(?:change|set|modify|update)\b/)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "config.patch",
      args: {
        path: configPatch.path,
        patch: [{ op: "replace", key: configPatch.key, value: configPatch.value }],
        expected_revision: inventoryRevision,
      },
      risk: "medium",
      requires_confirmation: true,
      rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" },
    }], [{ type: "config_semantics", expected: `${configPatch.key}=${String(configPatch.value)}` }]);
  }
  if (options.preferredTool === "config.patch" && configPath) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1", tool: "config.inspect", args: { path: configPath }, risk: "read",
    }], []);
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
  if (/视距|view-distance|配置|config|server\.properties/.test(normalized)) {
    const requestedValue = intent.match(/(?:视距|view-distance)\s*(?:设置为|设为|改为|调整为|调为|to|=|:)\s*(\d+)\b/i)?.[1];
    if (!requestedValue || options.preferredTool === "config.inspect" ||
        deniesAction(originalIntent, /修改|设置|改为|配置|\b(?:change|set|modify|update)\b/)) {
      return plan(id, instanceRef, inventoryRevision, intent, [{
        id: "s1", tool: "config.inspect", args: { path: configPath ?? "server.properties" }, risk: "read",
      }], []);
    }
    const value = Number(requestedValue);
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "config.patch",
      args: { path: "server.properties", patch: [{ op: "replace", key: "view-distance", value }], expected_revision: inventoryRevision },
      risk: "medium",
      requires_confirmation: true,
      rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" },
    }], [{ type: "config_semantics", expected: `view-distance=${value}` }]);
  }
  const pluginProject = !pluginContext && parseServerInstallIntent(normalized)
    ? undefined : namedProject;
  if (pluginProject && (options.preferredTool === "plugin.resolve" ||
      deniesAction(originalIntent, /安装|部署|更新|升级|\b(?:install|deploy|update|upgrade)\b/))) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "plugin.resolve",
      args: {
        project: pluginProject,
        source: "modrinth",
        platform: options.platform ?? "unknown",
        minecraft_version: options.minecraftVersion ?? "unknown",
        loader: options.loader ?? options.platform ?? "unknown",
      },
      risk: "low",
    }], []);
  }
  if (pluginProject && (options.preferredTool === "plugin.install" || options.preferredTool === "plugin.resolve" || /安装|部署|更新|升级|install|deploy|update/i.test(intent))) {
    const skipRestart = deniesAction(originalIntent, /重启|\brestart\b/);
    const steps: TaskPlan["steps"] = [
      { id: "s1", tool: "plugin.resolve", args: {
        project: pluginProject,
        source: "modrinth",
        platform: options.platform ?? "unknown",
        minecraft_version: options.minecraftVersion ?? "unknown",
        loader: options.loader ?? options.platform ?? "unknown",
      }, risk: "low" },
      { id: "s2", tool: "plugin.install", args: { project: pluginProject, artifact_ref: "${s1.artifact}", expected_sha256: "${s1.sha256}" }, risk: "medium", requires_confirmation: true, rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" } },
    ];
    if (skipRestart) {
      return plan(id, instanceRef, inventoryRevision, intent, steps, []);
    }
    steps.push({ id: "s3", tool: "instance.restart", args: { timeout_seconds: 120 }, risk: "high", requires_confirmation: true });
    return plan(id, instanceRef, inventoryRevision, intent, steps, [
      { type: "instance_state", expected: "running" },
      { type: "plugin_enabled", name: pluginProject },
    ]);
  }
  if (/根目录|目录|文件|文件夹|list.*file|files?.*list|directory/.test(normalized)) {
    const path = isPluginDirectoryIntent(intent) ? "/plugins" : "/";
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "files.list",
      args: { path },
      risk: "read",
    }], []);
  }
  if (/启动|开机|开启|运行服务器|\bstart\b/.test(normalized) &&
      !deniesAction(originalIntent, /启动|开机|开启|运行服务器|\bstart\b/)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "instance.start",
      args: { timeout_seconds: 120 },
      risk: "low",
    }], [
      { type: "instance_state", expected: "running" },
    ]);
  }
  if (/重启|restart/.test(normalized) && !deniesAction(originalIntent, /重启|\brestart\b/)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "instance.restart", args: { timeout_seconds: 120 }, risk: "high", requires_confirmation: true }], [
      { type: "instance_state", expected: "running" },
      { type: "log_absence", pattern: "(ERROR|Exception)" },
    ]);
  }
  return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "logs.query", args: { window_minutes: 60, max_lines: 500 }, risk: "read" }], []);
}

const readonlyHealthSkillIntent = [
  "对当前实例完成一次只读健康检查：",
  "1. 在 Minecraft 控制台执行 version，确认服务端类型和 Minecraft 版本；",
  "2. 在 Minecraft 控制台执行 plugins，列出已加载插件；",
  "3. 读取最近 60 分钟日志，检查 ERROR、WARN、崩溃、Watchdog、Can't keep up 或卡顿证据；",
  "4. 等待每个工具的真实回调后再继续，最后给出综合健康结论和证据摘要。",
  "不得修改配置、安装内容、重启或停止服务器。",
].join("\n");

export function expandOperationalSkill(intent: string) {
  const message = intent.trim();
  if (!message || /(?:怎么|如何|原理|教程|一般|是什么|what\s+is|how\s+to)/i.test(message)) return undefined;
  const explicitHealth = /(?:健康检查|健康巡检|(?:服务|服务器|服务端|实例).{0,4}巡检|全面体检|只读巡检|health\s*check)/i.test(message);
  const shortHealthRequest = /(?:检查|查看|看看|查查|诊断|评估).{0,10}(?:当前|这台|这个)?(?:服务|实例|服务器|服务端).{0,8}(?:健康|状态|情况|问题|异常|故障|正常)|(?:当前|这台|这个)?(?:服务|实例|服务器|服务端).{0,8}(?:健康吗|正常吗|有没有问题|有问题吗|是否异常|有无异常|是否故障)/i.test(message);
  return explicitHealth || shortHealthRequest ? readonlyHealthSkillIntent : undefined;
}

function isReadonlyHealthInspection(intent: string) {
  if (expandOperationalSkill(intent)) return true;
  const asksForInspection = /(?:只读|健康检查|健康巡检|综合检查|完整检查|health\s*check|inspection)/i.test(intent);
  const asksForVersion = /(?:\bversion\b|版本|服务端类型)/i.test(intent);
  const asksForPlugins = /(?:\bplugins?\b|插件)/i.test(intent);
  const asksForLogs = /(?:日志|\blogs?\b|error|warn|崩溃|卡顿)/i.test(intent);
  return asksForInspection && asksForVersion && asksForPlugins && asksForLogs;
}

function parsePluginProject(intent: string) {
  const reserved = /^(?:a|an|the|agent|operation|plugin|server|current|resolve|install|deploy|update|query|search)$/i;
  const normalize = (candidate: string | undefined) => {
    if (!candidate || reserved.test(candidate)) return undefined;
    return candidate.toLowerCase() === "essentials" ? "essentialsx" : candidate.toLowerCase();
  };
  // The exact user sentence is kept before the model's normalized
  // "Agent operation" suffix.  Search it first so a negated clause such as
  // "先别安装\n\nAgent operation: ..." cannot turn the word Agent into a
  // plugin project.  The same generic rules then cover model-normalized input.
  const separator = /\n\s*\nAgent operation:\s*/i;
  const segments = intent.split(separator);
  for (const segment of segments) {
    const candidates = [
      segment.match(/\b([a-z0-9][a-z0-9_-]{1,63})\s*(?:插件|plugin)/i)?.[1],
      segment.match(/(?:解析|查询|查找|搜索|安装|部署|更新|升级|resolve|query|search|install|deploy|update)\s+(?:the\s+)?([a-z0-9][a-z0-9_-]{1,63})/i)?.[1],
      segment.match(/\b([a-z0-9][a-z0-9_-]{1,63})\s*(?:能不能|是否|能否|可不可以|可以)?\s*(?:安装|装|部署|更新|升级)/i)?.[1],
    ];
    for (const candidate of candidates) {
      const project = normalize(candidate);
      if (project) return project;
    }
  }
  return undefined;
}

function extractConfigurationPath(intent: string) {
  const marker = intent.match(/\bMCAI_CONFIG\s+path=([^\s]+\.(?:ya?ml|json|properties|conf))\b/i)?.[1];
  const natural = intent.match(/\b((?:plugins|config)\/[A-Za-z0-9_.\/-]+\.(?:ya?ml|json|properties|conf)|server\.properties)\b/i)?.[1];
  return (marker ?? natural)?.replace(/^\//, "");
}

function parseConfigurationPatch(intent: string): { path: string; key: string; value: unknown } | undefined {
  const path = extractConfigurationPath(intent);
  if (!path) return undefined;
  const marker = intent.match(/\bMCAI_CONFIG\s+path=[^\s]+\s+key=([A-Za-z0-9_.-]+)\s+value_json=([^\r\n]+)/i);
  if (marker) {
    try {
      return { path, key: marker[1], value: JSON.parse(marker[2].trim()) };
    } catch {
      return undefined;
    }
  }
  const natural = intent.match(/(?:配置项|键|key)\s*[：:=]\s*([A-Za-z0-9_.-]+)[^\r\n]{0,32}?(?:设为|设置为|改为|value\s*[：:=]|to)\s*["“]?([^"”\r\n]+)["”]?/i);
  if (!natural) return undefined;
  const raw = natural[2].trim();
  let value: unknown = raw;
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(raw)) {
    try { value = JSON.parse(raw.toLowerCase()); } catch { value = raw; }
  }
  return { path, key: natural[1], value };
}

function parseServerInstallIntent(intent: string) {
  const isInstallAction = /(?:download|install|setup|deploy|launch|start|create|\u4e0b\u8f7d|\u5b89\u88c5|\u90e8\u7f72|\u542f\u52a8|\u5f00\u670d|\u521b\u5efa|\u8fd0\u884c)/i.test(intent);
  if (!isInstallAction) return undefined;
  const platform = /\bpaper\b/i.test(intent) ? "paper" : /\bfabric\b/i.test(intent) ? "fabric" : undefined;
  const minecraftVersion = intent.match(/(?:minecraft|mc|\u7248\u672c|version)?\s*(\d+\.\d+(?:\.\d+)?(?:-[a-z0-9._-]+)?)/i)?.[1];
  if (!platform || !minecraftVersion) return undefined;
  return { platform, minecraftVersion };
}

// Keep negation within a clause, and conservatively refuse ambiguous mutations.
// User constraints must not be overridden by the model's appended operation.
function deniesAction(intent: string, action: RegExp) {
  const negative = /不要|不得|禁止|无需|不应|不必|不用|别|不可|避免|不(?:同意|接受)|\b(?:do\s+not|don['’]t|never|without|not)\b/i;
  return intent.split(/[\r\n，。；;,!?！？]/).some(clause => {
    const negation = negative.exec(clause);
    return Boolean(negation && action.test(clause.slice(negation.index)));
  });
}

function acceptsMinecraftEula(intent: string) {
  if (deniesAction(intent, /同意|接受|\b(?:accept|agree)\b/)) return false;
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
  const explicitlyRequestsPluginFiles = isPluginDirectoryIntent(intent);
  if (!explicitlyRequestsPluginFiles && (/\b(?:plugin list|installed plugins?|what plugins?)\b|插件.{0,8}(?:列表|有哪些|有什么|多少|已安装)|(?:查看|查询|列出|显示).{0,10}(?:服务器|服务端|当前)?\s*插件|已安装.{0,4}插件/i.test(intent))) {
    return "plugins";
  }
  return undefined;
}

export function extractFilesListIntent(intent: string) {
  if (!isPluginDirectoryIntent(intent)) return undefined;
  if (!/(?:查看|读取|列出|显示|检查|打开|里面|内容|文件|目录|我说|show|read|list|inspect)/i.test(intent)) return undefined;
  return "列出当前实例 /plugins 目录并返回实际插件文件清单";
}

function isPluginDirectoryIntent(intent: string) {
  return /(?:\/plugins\b|plugins[\\/]|plugins\s*(?:目录|文件夹|folder|directory)|插件\s*(?:目录|文件夹|文件|jar))/i.test(intent);
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
