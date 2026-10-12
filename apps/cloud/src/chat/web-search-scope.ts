import type { AgentLoopDecision } from "./agent-loop";

// User source restrictions are part of tool inputs, even when the model omits
// them. Restrict discovery and rendering; do not weaken a site rule on failure.
export function requestedWebSearchSite(message: string) {
  const explicit = message.match(/\bsite:([^\s，。；、]+)/iu)?.[1];
  const only = message.match(/(?:只|仅)(?:参考|使用|搜索|查找|查询|访问)\s*(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?:\/[^\s，。；、]*)?)/iu)?.[1]
    ?? message.match(/only\s+(?:use|search|reference|consult)\s+(?:https?:\/\/)?([a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s,;]*)?)/iu)?.[1];
  const value = explicit ?? only;
  if (!value) return undefined;
  try {
    const url = new URL(`https://${value.replace(/[)\]"'.;]+$/u, "")}`);
    if (url.username || url.password || url.port || !url.hostname.includes(".")) return undefined;
    return url.hostname.toLowerCase() + url.pathname.replace(/\/$/u, "");
  } catch { return undefined; }
}

export function applyUserWebSearchScope(decision: AgentLoopDecision, message: string): AgentLoopDecision {
  const site = requestedWebSearchSite(message);
  if (decision.action !== "tool_call" || decision.tool !== "web.search" || typeof decision.arguments.query !== "string") return decision;
  let query = site ? decision.arguments.query.replace(/\bsite:[^\s]+/giu, "").trim() : decision.arguments.query;
  // Preserve a backup goal explicitly requested in Chinese when translation
  // otherwise drops it. This expands a read-only query; it authorizes no action.
  if (message.includes("备份") && !/\bback(?:up|ups|ing)?\b/iu.test(query)) query += " backup";
  return { ...decision, arguments: { ...decision.arguments, query: site ? `${query} site:${site}` : query } };
}

export function webSearchUrlWithinScope(url: string, message: string) {
  const site = requestedWebSearchSite(message);
  if (!site) return true;
  try {
    const rule = new URL(`https://${site}`), candidate = new URL(url);
    const host = candidate.hostname.toLowerCase();
    const path = rule.pathname.replace(/\/$/u, "");
    return (host === rule.hostname || host.endsWith(`.${rule.hostname}`))
      && (!path || candidate.pathname === path || candidate.pathname.startsWith(`${path}/`));
  } catch { return false; }
}
