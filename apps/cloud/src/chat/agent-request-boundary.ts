import { intrinsicToolPolicy } from "@mcai/contracts";
import { classifyOperationalLanguage } from "../tasks/operation-intent";
import { compileLogFilterQuery } from "../tasks/log-filter-query";
import type { AgentLoopDecision } from "./agent-loop";

// Configuration ownership, not answer templates. Explicit user file paths
// retain their meaning; otherwise these Java-server settings have one owner.
const properties: Record<string, string[]> = {
  "view-distance": ["视距", "view distance"],
  "simulation-distance": ["模拟距离", "simulation distance"],
  "white-list": ["白名单开关", "白名单是否开启", "白名单是否启用"],
  "online-mode": ["正版验证", "正版校验", "online mode"],
  "enforce-whitelist": [], "motd": ["服务器描述"], "max-players": ["最大玩家数"],
  "difficulty": ["难度"], "allow-flight": [], "spawn-protection": [],
  "enable-command-block": [], "server-port": [], "pvp": [], "gamemode": [],
  "hardcore": [], "level-name": [], "server-ip": [], "resource-pack": [],
  "rcon.password": [], "rcon.port": [], "player-idle-timeout": [],
};
const javaServers = new Set(["paper", "purpur", "spigot", "bukkit", "vanilla", "fabric", "forge", "neoforge", "folia"]);
const explicitConfigPath = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:properties|ya?ml|json|conf)\b/iu;

export function requestAllowsMutation(message: string) {
  if (/(?:只|仅)(?:查询|查看|读取|搜索|浏览|查|看|读)(?:文档|版本|来源|信息|当前|状态)?|\b(?:read[- ]only|lookup only)\b/iu.test(message)) return false;
  return classifyOperationalLanguage(message) === "write";
}

export function constrainAgentRequest(decision: AgentLoopDecision, message: string, platform?: string): AgentLoopDecision {
  if (decision.action !== "tool_call") return decision;
  const allowWrite = requestAllowsMutation(message);
  const knownServer = javaServers.has(String(platform).toLowerCase());
  const explicitPath = message.match(explicitConfigPath)?.[0];
  const query = message.toLowerCase();
  const requestedKeys = knownServer ? Object.entries(properties).filter(([key, aliases]) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_.-])${escaped}(?:$|[^a-z0-9_.-])`, "iu").test(query)
      || aliases.some((alias) => query.includes(alias));
  }).map(([key]) => key) : [];
  const owned = !explicitPath && knownServer;
  // A state question cannot turn into whitelist on/off or another console write
  // after a failed read. Obtain all requested settings through the owner file.
  if (!allowWrite && owned && requestedKeys.length
      && ["console.command", "config.inspect", "config.patch"].includes(decision.tool)) {
    return { action: "tool_call", tool: "config.inspect", arguments: { path: "server.properties", keys: requestedKeys }, reason: "读取所请求配置的当前值。" };
  }
  if (owned && ["config.inspect", "config.patch"].includes(decision.tool)) {
    const keys = decision.tool === "config.inspect" ? decision.arguments.keys
      : Array.isArray(decision.arguments.patch) ? decision.arguments.patch.map((item: { key?: string }) => item?.key) : [];
    if (Array.isArray(keys) && keys.length && keys.every((key) => typeof key === "string" && key in properties)) {
      decision = { ...decision, arguments: { ...decision.arguments, path: "server.properties" } };
    }
  }
  // Properties are text. Canonicalize their scalar values before replay checks
  // so 5 and "5" cannot trigger duplicate successful writes.
  if (decision.tool === "config.patch" && String(decision.arguments.path).endsWith(".properties") && Array.isArray(decision.arguments.patch)) {
    decision = { ...decision, arguments: { ...decision.arguments, patch: decision.arguments.patch.map((item) => ({ ...item,
      value: ["string", "number", "boolean"].includes(typeof item?.value) ? String(item.value) : item?.value })) } };
  }
  if (decision.tool === "logs.query") {
    const query = compileLogFilterQuery(message);
    if (query.groups.some((group) => [...group.all_of, ...group.any_of].some((token) => token !== "all"))) {
      decision = { ...decision, arguments: { ...decision.arguments, filter_query: { groups: query.groups } } };
    }
  }
  if (!allowWrite && intrinsicToolPolicy(decision.tool, decision.arguments).mutates) {
    return { action: "cannot_proceed", answer: "本次请求只允许读取，未执行任何修改。" };
  }
  if (owned && requestedKeys.length && decision.tool === "console.command" && intrinsicToolPolicy(decision.tool, decision.arguments).mutates) {
    return { action: "tool_call", tool: "config.inspect", arguments: { path: "server.properties", keys: requestedKeys }, reason: "核对配置后使用配置修改工具。" };
  }
  return decision;
}
