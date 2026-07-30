import { randomUUID } from "node:crypto";
import type { RiskLevel, TaskPlan } from "@mcai/contracts";
import { TASK_PLAN_SCHEMA_VERSION } from "@mcai/contracts";

export function draftPlan(instanceRef: string, inventoryRevision: string, intent: string): TaskPlan {
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
  const consoleCommand = extractConsoleCommand(intent);
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
  if (/luckperms|安装.*插件|install.*plugin/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [
      { id: "s1", tool: "plugin.resolve", args: { project: "luckperms", source: "modrinth" }, risk: "low" },
      { id: "s2", tool: "plugin.install", args: { artifact_ref: "${s1.artifact}", expected_sha256: "${s1.sha256}" }, risk: "medium", requires_confirmation: true, rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" } },
      { id: "s3", tool: "instance.restart", args: { timeout_seconds: 120 }, risk: "high", requires_confirmation: true },
    ], [
      { type: "instance_state", expected: "running" },
      { type: "plugin_enabled", name: "LuckPerms" },
    ]);
  }
  if (/根目录|目录|文件|文件夹|list.*file|files?.*list|directory/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "files.list",
      args: { path: "/" },
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

function extractConsoleCommand(intent: string) {
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
  return undefined;
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
