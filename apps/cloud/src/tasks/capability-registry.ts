import type { ClauseRoleEntry, SourceGoal } from "@mcai/contracts";
import { canonicalizeLogFilterGroups, logEventFilters, type LogFilterQueryV1 } from "./log-filter-query";

export type RegisteredCapability =
  | {
    id: "logs.registered-observation";
    tool: "logs.query";
    risk: "read";
    requiresConfirmation: false;
    resultKinds: ["collection", "count", "judgement"];
    sourceSpans: Array<{ start: number; end: number; text: string; concept: string }>;
    args: { window_minutes: number; max_lines: number; filters: string[]; filter_query: LogFilterQueryV1 };
  }
  | {
    id: "plugins.loaded-inventory";
    tool: "console.command";
    risk: "read";
    requiresConfirmation: false;
    resultKinds: ["collection", "count"];
    sourceSpans: Array<{ start: number; end: number; text: string; concept: string }>;
    args: { command: "plugins" };
  };

type LogConcept = {
  id: string;
  aliases: RegExp[];
  group: { all_of: string[]; any_of: string[] };
};

// Data, not routing code, owns the vocabulary of registered executable
// observations. Unknown language remains available to the bounded AI compiler.
const logConcepts: LogConcept[] = [
  { id: "memory-exhaustion", aliases: [/\u5185\u5b58(?:\u4e0d\u8db3|\u8017\u5c3d|\u6ea2\u51fa)/i, /(?:out[ -]?of[ -]?memory|memory exhaustion|memory allocation fail(?:ed|ure)?)/i], group: { all_of: ["memory_resource"], any_of: ["out_of_memory"] } },
  { id: "server-falling-behind", aliases: [/(?:\u670d\u52a1\u5668|\u670d\u52a1\u7aef)(?:\u8fd0\u884c)?\u8ddf\u4e0d\u4e0a|\u6765\u4e0d\u53ca\u5904\u7406/i, /(?:server (?:cannot|can't) keep up|server (?:is )?falling behind|running behind)/i], group: { all_of: ["server_lag"], any_of: ["cannot_keep_up"] } },
  { id: "authentication-rejection", aliases: [/\u8ba4\u8bc1(?:\u5931\u8d25|\u88ab\u62d2)|\u9274\u6743(?:\u5931\u8d25|\u88ab\u62d2)|\u767b\u5f55\u8ba4\u8bc1\u5931\u8d25/i, /(?:authentication|auth) (?:failed|failure|rejected|denied)/i], group: { all_of: ["client_connection"], any_of: ["authentication_failure"] } },
  { id: "world-storage-corruption", aliases: [/\u4e16\u754c(?:\u5feb\u7167|\u533a\u5757|\u5b58\u6863)(?:\u635f\u574f|\u5f02\u5e38)/i, /(?:world snapshot|world chunk|world storage) (?:corrupt(?:ed|ion)?|failure)/i], group: { all_of: ["world_storage"], any_of: ["chunk_corruption"] } },
];

const pluginInventoryAliases = [
  /(?:\u5f53\u524d|\u73b0\u6709|\u5df2\u52a0\u8f7d|\u6b63\u5728\u52a0\u8f7d).{0,12}(?:\u63d2\u4ef6)(?:\u540d\u79f0|\u540d\u5355|\u5217\u8868|\u6e05\u5355|\u603b\u6570|\u6570\u91cf|\u6709\u54ea\u4e9b|\u52a0\u8f7d\u4e86\u54ea\u4e9b)?/i,
  /(?:\u5217\u51fa|\u67e5\u770b|\u67e5\u8be2|\u544a\u8bc9).{0,10}(?:\u5df2\u52a0\u8f7d|\u5f53\u524d)?(?:\u7684)?\u63d2\u4ef6(?:\u540d\u79f0|\u540d\u5355|\u5217\u8868|\u6e05\u5355|\u603b\u6570|\u6570\u91cf)?/i,
  /\b(?:loaded|active) plugins?\b|\bplugin inventory\b/i,
];
const readCue = /(?:\u53ea\u8bfb|\u67e5\u770b|\u67e5\u8be2|\u5217\u51fa|\u544a\u8bc9|\u7ed9\u51fa|\u540d\u79f0|\u540d\u5355|\u5217\u8868|\u6e05\u5355|\u603b\u6570|\u6570\u91cf|read|show|list|tell|give|names?|count|inventory)/i;
const pluginMutation = /(?:\u5b89\u88c5|\u4e0b\u8f7d|\u5378\u8f7d|\u5220\u9664|\u66f4\u65b0|\u542f\u7528|\u505c\u7528|install|download|uninstall|remove|update|enable|disable)/i;

export function matchRegisteredCapability(intent: string): RegisteredCapability | undefined {
  const plugin = firstMatch(intent, pluginInventoryAliases);
  if (plugin && readCue.test(intent) && !pluginMutation.test(intent)
    && !/(?:\u65e5\u5fd7|\u62a5\u9519|\u5f02\u5e38|logs?|errors?|\u670d\u52a1\u7aef\u7248\u672c|server version)/i.test(intent)) {
    return {
      id: "plugins.loaded-inventory", tool: "console.command", risk: "read", requiresConfirmation: false,
      resultKinds: ["collection", "count"],
      sourceSpans: [{ start: plugin.index, end: plugin.index + plugin.text.length, text: plugin.text, concept: "loaded-plugin-inventory" }],
      args: { command: "plugins" },
    };
  }

  if (!/(?:\u65e5\u5fd7|\u8bb0\u5f55|\u62a5\u9519|\u5f02\u5e38|logs?|log entries|errors?)/i.test(intent)) return undefined;
  const branchMatches = logConcepts.flatMap((concept) => {
    const match = firstMatch(intent, concept.aliases);
    return match ? [{ concept, ...match }] : [];
  }).sort((left, right) => left.index - right.index);
  if (branchMatches.length < 1) return undefined;
  const explicitOrCount = [...intent.matchAll(/(?:\u6216\u8005|\u6216\u662f|\u8981\u4e48|\bor\b)/gi)].length;
  if (explicitOrCount > 0 && branchMatches.length !== explicitOrCount + 1) return undefined;
  if (explicitOrCount > 0 && !branchMatches.slice(0, -1).every((left, index) => {
    const between = intent.slice(left.index + left.text.length, branchMatches[index + 1].index);
    return /(?:\u6216\u8005|\u6216\u662f|\u8981\u4e48|\bor\b)/i.test(between);
  })) return undefined;
  const canonical = canonicalizeLogFilterGroups(branchMatches.map(({ concept }) => concept.group));
  if (!canonical.ok) return undefined;
  const windowMinutes = logWindowMinutes(intent);
  return {
    id: "logs.registered-observation", tool: "logs.query", risk: "read", requiresConfirmation: false,
    resultKinds: ["collection", "count", "judgement"],
    sourceSpans: branchMatches.map(({ concept, index, text }) => ({ start: index, end: index + text.length, text, concept: concept.id })),
    args: { window_minutes: windowMinutes, max_lines: Math.min(1000, Math.max(100, windowMinutes * 8)), filters: logEventFilters(canonical.query), filter_query: canonical.query },
  };
}

export function projectRegisteredCapabilityClauses(intent: string, extracted: ClauseRoleEntry[], goals: SourceGoal[]): ClauseRoleEntry[] {
  const required = goals.filter((goal) => goal.required && goal.status === "mapped");
  if (!required.length) return extracted;
  const start = Math.min(...required.map((goal) => goal.source_start));
  const end = Math.max(...required.map((goal) => goal.source_end));
  const intentRunes = [...intent];
  const overlapsGoal = (clause: ClauseRoleEntry) => required.some((goal) => clause.source_start < goal.source_end && clause.source_end > goal.source_start);
  const retained = extracted
    .filter((clause) => clause.role !== "domain_goal" && clause.role !== "unknown_business_goal" && !(clause.role === "safety_constraint" && overlapsGoal(clause)))
    .map((clause) => ({ ...clause, source_atom_ids: [], source_goal_ids: [] }));
  retained.push({
    id: "clause-registered-capability",
    source_text: intentRunes.slice(start, end).join(""),
    source_start: start,
    source_end: end,
    role: "domain_goal",
    polarity: "positive",
    status: "mapped",
    reason: "registered_capability_projection",
    source_atom_ids: [],
    source_goal_ids: [],
    constraint_actions: [],
  });
  return retained.sort((left, right) => left.source_start - right.source_start || left.source_end - right.source_end);
}

function firstMatch(value: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return { index: match.index, text: match[0] };
  }
  return undefined;
}

function logWindowMinutes(intent: string) {
  if (/(?:\u534a\u5c0f\u65f6|half\s+(?:an?\s+)?hour)/i.test(intent)) return 30;
  const hours = intent.match(/(?:\u6700\u8fd1|\u8fd1\u671f|\u8fc7\u53bb|last|past|previous)?\s*(\d{1,3})\s*(?:\u5c0f\u65f6|hours?|hrs?)/i)?.[1];
  if (hours) return Math.min(1440, Math.max(1, Number(hours) * 60));
  const minutes = intent.match(/(?:\u6700\u8fd1|\u8fd1\u671f|\u8fc7\u53bb|last|past|previous)?\s*(\d{1,4})\s*(?:\u5206\u949f|minutes?|mins?)/i)?.[1];
  return minutes ? Math.min(1440, Math.max(1, Number(minutes))) : 60;
}
