import { RESOURCE_PRESSURE_POLICY, type GoalPredicate, type GoalPredicateOperand, type GoalRequirement, type TaskRecord } from "@mcai/contracts";

export interface TypedGoalResult {
  available: boolean;
  observed?: unknown;
  capacity?: number;
  summary: string;
  diagnostics: string[];
  reason?: "missing_fact" | "conflicting_authoritative_facts" | "invalid_operands";
}

type Evidence = TaskRecord["evidence"][number];

export function adaptGoalResult(goal: GoalRequirement, evidence: Evidence[], options: { expectedLogQueryDigest?: string } = {}): TypedGoalResult {
  const diagnostics = evidence.flatMap((item) => diagnosticLines(item.summary));
  if (!evidence.length) return unavailable(goal, diagnostics, "missing_fact");
  if (goal.target === "version") return adaptServerVersion(goal, evidence, diagnostics);
  if (goal.domain === "config") return adaptConfigValue(goal, evidence, diagnostics);
  if (goal.domain === "plugin" && evidence.some((item) => item.tool === "plugin.resolve" || item.kind === "plugin")) return adaptPluginResolve(goal, evidence, diagnostics);
  if (goal.domain === "diagnosis" && goal.target === "recent-logs") return adaptLogDiagnostic(goal, evidence, diagnostics, options.expectedLogQueryDigest);
  if (goal.domain === "access" && goal.target === "whitelist") return adaptWhitelistRoster(goal, evidence, diagnostics);
  if (goal.domain === "players" && ["online", "occupancy"].includes(goal.target)) return adaptOnlinePlayers(goal, evidence, diagnostics);
  if (goal.domain === "players" && goal.target === "conditional-first-online") return adaptConditionalPlayerInspection(goal, evidence, diagnostics);
  if (goal.domain === "gamerule") return adaptGameruleValue(goal, evidence, diagnostics);
  if (goal.domain === "world") return adaptWorldRuntime(goal, evidence, diagnostics);
  if (goal.domain === "performance" && ["uptime", "cpu", "memory", "resource-pressure"].includes(goal.target)) return adaptResourceMetric(goal, evidence, diagnostics);
  if (goal.domain === "plugin" && goal.target === "loaded") return adaptLoadedPlugins(goal, evidence, diagnostics);
  if (goal.result_kind === "collection" || goal.result_kind === "filtered_count") {
    const entries = stableUnique(evidence.flatMap((item) => listingEntries(item.summary)));
    if (goal.result_kind === "collection") {
      return available(goal, goal.filter ? entries.filter((entry) => matchesFilter(entry, goal.filter!)) : entries, diagnostics);
    }
    if (!goal.filter) return unavailable(goal, diagnostics, "invalid_operands");
    return available(goal, entries.filter((entry) => matchesFilter(entry, goal.filter!)).length, diagnostics);
  }
  if (goal.result_kind === "count") {
    const summaries = evidence.map((item) => item.summary).join("\n");
    const explicit = summaries.match(/(?:plugins?\s*\(|there\s+(?:are|is)\s+)(\d+)/i)?.[1];
    const observed = explicit !== undefined ? Number(explicit)
      : goal.domain === "diagnosis" ? (summaries.match(/\b(?:error|crash|fatal)\b/gi) ?? []).length
        : listingEntries(summaries).length;
    return available(goal, observed, diagnostics);
  }
  if (goal.target === "tps" || goal.target === "mspt") {
    const label = goal.target.toUpperCase();
    const candidates = evidence.flatMap((item) => {
      // Paper reports labels such as "TPS from last 1m, 5m, 15m: 19.98, ...".
      // Bind the observation to the value after the label's colon so window
      // durations cannot be mistaken for the metric itself.
      const labelled = [...item.summary.matchAll(new RegExp(`\\b${label}\\b[^\\r\\n:]{0,120}:\\s*(-?\\d+(?:\\.\\d+)?)`, "gi"))]
        .map((match) => Number(match[1]));
      if (labelled.length) return labelled;
      return [...item.summary.matchAll(new RegExp(`\\b${label}\\b\\s*(?:=|:)?\\s*(-?\\d+(?:\\.\\d+)?)`, "gi"))]
        .map((match) => Number(match[1]));
    });
    return candidates.length ? available(goal, candidates[0], diagnostics) : unavailable(goal, diagnostics, "missing_fact");
  }
  const raw = evidence.map((item) => item.observed ?? item.summary).filter((value) => value !== undefined);
  return raw.length ? available(goal, raw.length === 1 ? raw[0] : raw, diagnostics) : unavailable(goal, diagnostics, "missing_fact");
}

function adaptLoadedPlugins(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const summary = evidence.map((item) => item.summary).join("\n");
  const plain = summary.match(/\bplugins?\s*:\s*([^\r\n]+)/i);
  const plainEntries = plain?.[1].split(/\s*,\s*/).filter(Boolean) ?? [];
  const match = summary.match(/(?:server\s+)?plugins?\s*\((\d+)\)\s*:\s*([^\r\n]*)/i)
    ?? summary.match(/(?:there\s+(?:are|is)\s+)(\d+)\s+(?:loaded\s+)?plugins?\s*:\s*([^\r\n]*)/i)
    ?? (plain ? [plain[0], String(plainEntries.length), plain[1]] : null);
  if (!match) return unavailable(goal, diagnostics, "missing_fact");
  const declared = Number(match[1]);
  const entries = (match[2] ?? "").split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  if (!Number.isSafeInteger(declared) || declared < 0 || entries.length !== declared) return unavailable(goal, diagnostics, "conflicting_authoritative_facts");
  return available(goal, goal.result_kind === "collection" ? entries : declared, diagnostics);
}

function adaptOnlinePlayers(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const summary = evidence.map((item) => item.summary).join("\n");
  const matches = [...summary.matchAll(/There\s+(?:are|is)\s+(\d+)\s+of\s+a\s+max\s+of\s+(\d+)\s+players?\s+online(?:\s*:\s*([^\r\n]*))?/gi)];
  const facts = stableUnique(matches.map((match) => JSON.stringify({ count: Number(match[1]), max: Number(match[2]), names: splitRosterNames(match[3] ?? "") }))).map((item) => JSON.parse(item) as { count: number; max: number; names: string[] });
  if (facts.length !== 1) return unavailable(goal, diagnostics, facts.length > 1 ? "conflicting_authoritative_facts" : "missing_fact", "没有取得一致的在线玩家与容量读数");
  const fact = facts[0];
  if (!Number.isSafeInteger(fact.count) || !Number.isSafeInteger(fact.max) || fact.count < 0 || fact.max <= 0 || fact.count > fact.max || fact.names.length && fact.names.length !== fact.count) {
    return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "在线玩家数量、名单与容量互相不一致");
  }
  if (goal.target === "occupancy") return { ...available(goal, fact.count / fact.max, diagnostics), summary: `在线占用比例：${fact.count}/${fact.max}（${(fact.count / fact.max * 100).toFixed(1)}%）` };
  if (goal.result_kind === "count") return { ...available(goal, fact.count, diagnostics), summary: `在线玩家人数：${fact.count}` };
  return { ...available(goal, fact.names, diagnostics), summary: fact.names.length ? `在线玩家：${fact.names.join("、")}` : "当前没有在线玩家" };
}

function adaptConditionalPlayerInspection(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const facts = stableUnique(evidence.flatMap((item) => [...item.summary.matchAll(/Player inspection v1:\s*online_count=(\d+);\s*selected=([^;]+);\s*gamemode=([^;]+);\s*condition=(no-online-players|player-inspected)/gi)]
    .map((match) => JSON.stringify({ count: Number(match[1]), selected: match[2].trim(), gamemode: match[3].trim(), condition: match[4].toLowerCase() }))));
  if (facts.length !== 1) return unavailable(goal, diagnostics, facts.length > 1 ? "conflicting_authoritative_facts" : "missing_fact", "没有取得一致的玩家检查结果");
  const fact = JSON.parse(facts[0]) as { count: number; selected: string; gamemode: string; condition: string };
  if (!Number.isSafeInteger(fact.count) || fact.count < 0) return unavailable(goal, diagnostics, "invalid_operands", "在线玩家数量无效");
  if (fact.condition === "no-online-players") {
    if (fact.count !== 0 || fact.selected !== "<none>" || fact.gamemode !== "<none>") return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "无人在线结果内部不一致");
    return goal.result_kind === "count"
      ? { ...available(goal, 0, diagnostics), summary: "当前没有在线玩家" }
      : { ...available(goal, { online_count: 0, selected: null, gamemode: null, skipped: true }, diagnostics), summary: "当前没有在线玩家，因此无需读取玩家游戏模式" };
  }
  if (fact.count < 1 || !/^[A-Za-z0-9_]{3,16}$/.test(fact.selected) || !["survival", "creative", "adventure", "spectator"].includes(fact.gamemode)) {
    return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "玩家选择与游戏模式结果不一致");
  }
  return goal.result_kind === "count"
    ? { ...available(goal, fact.count, diagnostics), summary: `当前在线玩家人数：${fact.count}` }
    : { ...available(goal, { online_count: fact.count, selected: fact.selected, gamemode: fact.gamemode }, diagnostics), summary: `首位在线玩家 ${fact.selected} 当前为 ${fact.gamemode} 模式` };
}

function adaptWorldRuntime(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const summaries = evidence.map((item) => item.summary).join("\n");
  if (goal.target === "world.seed") {
    // Minecraft seeds are signed 64-bit integers. Keep the canonical decimal
    // representation as a string because JSON numbers cannot represent every
    // valid seed without losing precision above Number.MAX_SAFE_INTEGER.
    const values = stableUnique([...summaries.matchAll(/\bSeed:\s*\[(-?\d+)\]/gi)].map((match) => canonicalInteger(match[1])));
    return singleWorldFact(goal, values, diagnostics, "没有取得可核对的世界种子值");
  }
  if (goal.target === "world.difficulty") {
    const values = stableUnique([...summaries.matchAll(/\b(?:The\s+)?difficulty\s+(?:is|:)\s*(Peaceful|Easy|Normal|Hard)\b/gi)].map((match) => match[1].toLowerCase()));
    return singleWorldFact(goal, values, diagnostics, "没有取得可核对的当前难度");
  }
  if (goal.target === "world.daytime") {
    const values = stableUnique([...summaries.matchAll(/\bThe\s+time\s+is\s+(-?\d+)\b/gi)].map((match) => Number(match[1])));
    if (values.some((value) => value < 0 || value >= 24000)) return unavailable(goal, diagnostics, "invalid_operands", "世界时间刻数不在有效范围内");
    return singleWorldFact(goal, values, diagnostics, "没有取得可核对的世界时间刻数");
  }
  if (goal.target === "world.gametime") {
    const values = stableUnique([...summaries.matchAll(/\bThe\s+time\s+is\s+(\d+)\b/gi)].map((match) => canonicalInteger(match[1])));
    return singleWorldFact(goal, values, diagnostics, "没有取得可核对的累计游戏刻数");
  }
  if (goal.target === "world.border-diameter") {
    const values = stableUnique([...summaries.matchAll(/\bworld\s+border\s+is\s+currently\s+([0-9]+(?:\.[0-9]+)?(?:e[+-]?\d+)?)\s+(?:blocks?|block\(s\))\s+wide\b/gi)].map((match) => Number(match[1])));
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) return unavailable(goal, diagnostics, "invalid_operands", "世界边界直径不是有效正数");
    return singleWorldFact(goal, values, diagnostics, "没有取得可核对的世界边界直径");
  }
  if (goal.target === "world.datapacks-enabled") {
    const parsed = evidence.flatMap((item) => item.summary.split(/\r?\n/).map(parseEnabledDatapacks).filter((value): value is NonNullable<ReturnType<typeof parseEnabledDatapacks>> => Boolean(value)));
    const identities = stableUnique(parsed.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item) as string[]);
    if (identities.length !== 1) return unavailable(goal, diagnostics, identities.length > 1 ? "conflicting_authoritative_facts" : "missing_fact", "没有取得一致的已启用数据包名单");
    const packs = identities[0];
    if (goal.result_kind === "count") return { ...available(goal, packs.length, diagnostics), summary: `已启用数据包数量：${packs.length}` };
    if (goal.result_kind === "collection") return { ...available(goal, packs, diagnostics), summary: packs.length ? `已启用数据包：${packs.join("、")}` : "当前没有已启用数据包" };
  }
  const rosterKind = ({
    "world.datapacks-available": "available-data-packs",
    "world.banned-players": "banned-players",
    "world.teams": "teams",
    "world.scoreboard-objectives": "scoreboard-objectives",
    "world.forceload": "forceload",
  } as Record<string, string>)[goal.target];
  if (rosterKind) {
    const parsed = evidence.flatMap((item) => item.summary.split(/\r?\n/).map((line) => parseRuntimeRoster(rosterKind, line)).filter((value): value is string[] => Boolean(value)));
    const identities = stableUnique(parsed.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item) as string[]);
    if (identities.length !== 1) return unavailable(goal, diagnostics, identities.length > 1 ? "conflicting_authoritative_facts" : "missing_fact", "没有取得一致的只读名单结果");
    const items = identities[0];
    if (goal.result_kind === "count") return { ...available(goal, items.length, diagnostics), summary: `数量：${items.length}` };
    if (goal.result_kind === "collection") return { ...available(goal, items, diagnostics), summary: items.length ? `名单：${items.join("、")}` : "名单为空" };
  }
  return unavailable(goal, diagnostics, "invalid_operands");
}

function parseRuntimeRoster(kind: string, line: string): string[] | undefined {
  const text = line.trim();
  const definitions: Record<string, { empty: RegExp; list: RegExp }> = {
    "available-data-packs": { empty: /(?:there\s+(?:are|is)\s+(?:0|no(?:\s+more)?)\s+data\s+pack(?:\(s\)|s)?\s+available|no\s+data\s+packs?\s+(?:are\s+)?available)/i, list: /(?:there\s+(?:are|is)\s+)?(\d+)\s+data\s+pack(?:\(s\)|s)?\s+available\s*:\s*(.*)/i },
    "banned-players": { empty: /(?:there\s+(?:are|is)\s+(?:no|0)\s+(?:player\s+)?bans?|no\s+players?\s+(?:are\s+)?banned)/i, list: /(?:there\s+(?:are|is)\s+)?(\d+)\s+(?:player\s+)?ban(?:\(s\)|s)?\s*:\s*(.*)/i },
    teams: { empty: /(?:there\s+(?:are|is)\s+(?:no|0)\s+teams?|no\s+teams?\s+exist)/i, list: /(?:there\s+(?:are|is)\s+)?(\d+)\s+team(?:\(s\)|s)?\s*:\s*(.*)/i },
    "scoreboard-objectives": { empty: /(?:there\s+(?:are|is)\s+(?:no|0)\s+(?:scoreboard\s+)?objectives?|no\s+objectives?\s+exist)/i, list: /(?:there\s+(?:are|is)\s+)?(\d+)\s+(?:scoreboard\s+)?objective(?:\(s\)|s)?\s*:\s*(.*)/i },
    forceload: { empty: /(?:no\s+force[- ]?loaded\s+chunks?\s+(?:were\s+)?found|there\s+(?:are|is)\s+(?:no|0)\s+force[- ]?loaded\s+chunks?)/i, list: /(?:force[- ]?loaded\s+chunks?(?:\s+in\s+[^:]+)?|there\s+(?:are|is)\s+(\d+)\s+force[- ]?loaded\s+chunks?)\s*:\s*(.*)/i },
  };
  const definition = definitions[kind];
  if (!definition) return undefined;
  if (definition.empty.test(text)) return [];
  const match = text.match(definition.list);
  if (!match) return undefined;
  const body = match[2] ?? match[1] ?? "";
  const items = kind === "available-data-packs"
    ? [...body.matchAll(/\[([^\]]+)\]/g)].map((item) => item[1].trim()).filter(Boolean)
    : body.split(/[,，]/).map((item) => item.trim().replace(/^\[|\]$/g, "")).filter(Boolean);
  const declared = Number(match[1] ?? items.length);
  return Number.isSafeInteger(declared) && declared === items.length ? items : undefined;
}

function canonicalInteger(value: string) {
  try {
    return BigInt(value).toString(10);
  } catch {
    return value;
  }
}

function singleWorldFact(goal: GoalRequirement, values: Array<string | number>, diagnostics: string[], missing: string) {
  if (values.length !== 1) return unavailable(goal, diagnostics, values.length > 1 ? "conflicting_authoritative_facts" : "missing_fact", missing);
  return available(goal, values[0], diagnostics);
}

function parseEnabledDatapacks(line: string) {
  const match = line.match(/(?:There\s+(?:are|is)\s+)?(\d+)\s+data\s+pack(?:\(s\)|s)?\s+enabled\s*:\s*(.*)$/i)
    ?? line.match(/Enabled\s+data\s+packs?\s*(?:\((\d+)\))?\s*:\s*(.*)$/i);
  if (!match) return undefined;
  const packs = [...match[2].matchAll(/\[([^\]]+)\]/g)].map((item) => item[1].trim()).filter(Boolean);
  const count = Number(match[1] ?? packs.length);
  return Number.isSafeInteger(count) && count === packs.length ? packs : undefined;
}

function adaptGameruleValue(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const expected = goal.target;
  const structured: string[] = [];
  const raw: string[] = [];
  for (const item of evidence) {
    for (const line of item.summary.split(/\r?\n/)) {
      const record = line.match(/^Gamerule read result:\s*rule=([A-Za-z][A-Za-z0-9]{0,63});\s*value=([^;\r\n]{1,128})$/i);
      if (record) {
        if (record[1].toLowerCase() !== expected.toLowerCase()) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "游戏规则回调与请求的规则不一致");
        structured.push(record[2].trim());
        continue;
      }
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(`Gamerule\\s+${escaped}\\s+is\\s+currently\\s+set\\s+to:\\s*([^\\s;]+)`, "i"),
        new RegExp(`(?:value\\s+of\\s+gamerule\\s+${escaped}|${escaped})\\s+(?:is|=)\\s*([^\\s;]+)`, "i"),
      ];
      const match = patterns.map((pattern) => line.match(pattern)).find(Boolean);
      if (match?.[1]) raw.push(match[1].trim());
    }
  }
  const canonical = (value: string) => /^(?:true|false)$/i.test(value) ? value.toLowerCase() : /^-?\d+(?:\.\d+)?$/.test(value) ? String(Number(value)) : value;
  const structuredValues = stableUnique(structured.map(canonical));
  const rawValues = stableUnique(raw.map(canonical));
  if (structuredValues.length !== 1 || rawValues.length !== 1) return unavailable(goal, diagnostics, structuredValues.length > 1 || rawValues.length > 1 ? "conflicting_authoritative_facts" : "missing_fact", "没有取得完整且可核对的游戏规则当前值");
  if (structuredValues[0] !== rawValues[0]) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "游戏规则结构化结果与原始回调不一致");
  const value = structuredValues[0] === "true" ? true : structuredValues[0] === "false" ? false : /^-?\d+(?:\.\d+)?$/.test(structuredValues[0]) ? Number(structuredValues[0]) : structuredValues[0];
  return { ...available(goal, value, diagnostics), summary: `${expected} 当前值为 ${String(value)}` };
}

function adaptResourceMetric(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const parsed = evidence.flatMap((item) => item.summary.split(/\r?\n/).map(parseResourceMetrics).filter((value): value is NonNullable<ReturnType<typeof parseResourceMetrics>> => Boolean(value)));
  if (!parsed.length) return unavailable(goal, diagnostics, "missing_fact", "没有取得完整的实例资源读数");
  const identities = stableUnique(parsed.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item) as NonNullable<ReturnType<typeof parseResourceMetrics>>);
  if (identities.length !== 1) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "实例资源回调包含冲突读数");
  const value = identities[0];
  if (!Number.isFinite(value.cpuPercent) || value.cpuPercent < 0 || value.cpuPercent > 100
    || !Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < 0
    || !Number.isSafeInteger(value.memoryLimitBytes) || value.memoryLimitBytes <= 0
    || value.memoryBytes > value.memoryLimitBytes) {
    return unavailable(goal, diagnostics, "invalid_operands", "实例资源读数缺失或超出有效范围");
  }
  if (goal.target === "uptime") return value.uptimeSeconds === undefined
    ? unavailable(goal, diagnostics, "missing_fact", "没有取得进程运行时长")
    : { ...available(goal, value.uptimeSeconds, diagnostics), summary: `进程已运行 ${formatDuration(value.uptimeSeconds)}` };
  if (goal.target === "cpu") return { ...available(goal, value.cpuPercent, diagnostics), summary: `CPU 占用：${value.cpuPercent.toFixed(2)}%` };
  if (goal.target === "memory") return {
    ...available(goal, value.memoryBytes, diagnostics),
    capacity: value.memoryLimitBytes,
    summary: `内存占用：${formatBytes(value.memoryBytes)} / ${formatBytes(value.memoryLimitBytes)}`,
  };
  if (goal.target === "resource-pressure") {
    const ratio = value.memoryBytes / value.memoryLimitBytes;
    const high = value.cpuPercent >= RESOURCE_PRESSURE_POLICY.cpu_high_percent || ratio >= RESOURCE_PRESSURE_POLICY.memory_high_ratio;
    const elevated = !high && (value.cpuPercent >= RESOURCE_PRESSURE_POLICY.cpu_elevated_percent || ratio >= RESOURCE_PRESSURE_POLICY.memory_elevated_ratio);
    const label = high ? "高" : elevated ? "中等" : "较低";
    return { ...available(goal, high, diagnostics), summary: `资源压力：${label}（CPU ${value.cpuPercent.toFixed(2)}%，内存 ${(ratio * 100).toFixed(1)}%）` };
  }
  return unavailable(goal, diagnostics, "invalid_operands");
}

function parseResourceMetrics(line: string) {
  const match = line.match(/^Instance metrics v2:\s*(?:uptime_seconds=(\d+);\s*)?cpu_percent=(-?\d+(?:\.\d+)?);\s*memory_bytes=(\d+);\s*memory_limit_bytes=(\d+);\s*pressure_policy=(resource-pressure\/v1)$/i);
  if (!match) return undefined;
  return { uptimeSeconds: match[1] === undefined ? undefined : Number(match[1]), cpuPercent: Number(match[2]), memoryBytes: Number(match[3]), memoryLimitBytes: Number(match[4]), policy: match[5] };
}

function formatBytes(value: number) {
  return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [days ? `${days}天` : "", hours ? `${hours}小时` : "", minutes || (!days && !hours) ? `${minutes}分钟` : ""].filter(Boolean).join("");
}

function adaptWhitelistRoster(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const parsed = evidence.flatMap((item) => item.summary.split(/\r?\n/).map(parseWhitelistRoster).filter((value): value is NonNullable<ReturnType<typeof parseWhitelistRoster>> => Boolean(value)));
  if (!parsed.length) return unavailable(goal, diagnostics, "missing_fact", "没有取得可确认的白名单成员结果");
  const identities = stableUnique(parsed.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item) as NonNullable<ReturnType<typeof parseWhitelistRoster>>);
  if (identities.length !== 1) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "白名单回调包含互相冲突的结果");
  const observed = identities[0];
  if (observed.count !== observed.names.length) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "白名单人数与成员名单不一致");
  if (goal.result_kind === "count") return { ...available(goal, observed.count, diagnostics), summary: `白名单人数：${observed.count}` };
  if (goal.result_kind === "collection") return {
    ...available(goal, observed.names, diagnostics),
    summary: observed.names.length ? `白名单成员：${observed.names.join("、")}` : "白名单成员：无",
  };
  return unavailable(goal, diagnostics, "invalid_operands");
}

function parseWhitelistRoster(line: string) {
  const text = line.trim();
  if (!text) return undefined;
  if (/(?:there\s+(?:are|is)\s+no\s+whitelisted\s+players?|no\s+players?\s+(?:are\s+)?whitelisted|白名单(?:中|里)?(?:没有|无)\s*(?:玩家|成员|用户)?)/i.test(text)) return { names: [] as string[], count: 0 };
  const english = text.match(/there\s+(?:are|is)\s+(\d+)\s+whitelisted\s+players?(?:\s*[:：]\s*(.*))?/i)
    ?? text.match(/whitelisted\s+players?\s*(?:\((\d+)\))?\s*[:：]\s*(.*)/i);
  if (english) {
    const names = splitRosterNames(english[2] ?? "");
    const count = english[1] === undefined ? names.length : Number(english[1]);
    return Number.isFinite(count) ? { names, count } : undefined;
  }
  const chinese = text.match(/白名单(?:中|里)?(?:有)?\s*(\d+)\s*(?:名|个)?(?:玩家|成员|用户)?\s*[:：]?\s*(.*)/i)
    ?? text.match(/白名单(?:玩家|成员|用户)?\s*[:：]\s*(.*)/i);
  if (chinese) {
    const namesText = chinese.length > 2 ? chinese[2] : chinese[1];
    const names = splitRosterNames(namesText ?? "");
    const count = chinese.length > 2 ? Number(chinese[1]) : names.length;
    return Number.isFinite(count) ? { names, count } : undefined;
  }
  return undefined;
}

function splitRosterNames(value: string) {
  return value.split(/[,，、]/).map((item) => item.trim()).filter((item) => /^[\p{L}\p{N}_-]{1,32}$/u.test(item));
}

function adaptPluginResolve(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const results = evidence.flatMap((item) => item.summary.split(/\r?\n/).map(parsePluginResolveResult).filter((value): value is NonNullable<ReturnType<typeof parsePluginResolveResult>> => Boolean(value)));
  if (!results.length) return unavailable(goal, diagnostics, "missing_fact", "未取得包含兼容性、可信来源、版本和校验信息的插件解析结果");
  const identities = stableUnique(results.map((item) => JSON.stringify(item)));
  if (identities.length !== 1) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "插件解析回调包含互相冲突的结果");
  const observed = JSON.parse(identities[0]) as NonNullable<ReturnType<typeof parsePluginResolveResult>>;
  if (observed.project.toLowerCase() !== goal.target.toLowerCase()) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "插件解析结果与请求项目不一致");
  if (observed.resolution === "search-incomplete") {
    return { ...available(goal, observed, diagnostics), summary: `${observed.project} 历史版本查询达到上限；查询不完整，不能判定不存在兼容版本` };
  }
  if (observed.resolution === "no-compatible-artifact") {
    return { ...available(goal, observed, diagnostics), summary: `${observed.project} 在 ${observed.checked_source} 未找到适用于 ${observed.requested_loader} ${observed.requested_minecraft_version} 的兼容制品` };
  }
  const artifact = observed as { project: string; version: string; source: string; artifact: string; compatibility: string; sha256?: string; source_sha512?: string };
  const integrity = artifact.sha256 ? `SHA-256：${artifact.sha256}` : `来源 SHA-512：${artifact.source_sha512}`;
  return { ...available(goal, observed, diagnostics), summary: `${artifact.project} ${artifact.version}：兼容 ${artifact.compatibility}；可信来源：${artifact.source}；制品：${artifact.artifact}；${integrity}` };
}

export function parsePluginResolveResult(line: string) {
  if (!line.startsWith("Plugin resolve result:")) return undefined;
  const fields = new Map(line.slice("Plugin resolve result:".length).split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf("=");
    return separator > 0 ? [item.slice(0, separator).trim(), item.slice(separator + 1).trim()] : [item, ""];
  }));
  const project = fields.get("project") ?? "";
  const version = fields.get("version") ?? "";
  const source = fields.get("source") ?? "";
  const artifact = fields.get("artifact") ?? "";
  const compatibility = fields.get("compatibility") ?? "";
  const sha256 = fields.get("sha256") ?? "";
  const sourceSha512 = fields.get("source_sha512") ?? "";
  const resolution = fields.get("resolution") ?? "";
  if (resolution === "no-compatible-artifact" || resolution === "search-incomplete") {
    const checkedSource = fields.get("checked_source") ?? "";
    const requestedLoader = fields.get("requested_loader") ?? "";
    const requestedMinecraftVersion = fields.get("requested_minecraft_version") ?? "";
    if (!project || !["incompatible", "unverified"].includes(fields.get("compatibility") ?? "") || !checkedSource || !requestedLoader || !/^1\.\d+(?:\.\d+)?$/.test(requestedMinecraftVersion)) return undefined;
    return { project, resolution, compatibility: fields.get("compatibility")!, checked_source: checkedSource, requested_loader: requestedLoader, requested_minecraft_version: requestedMinecraftVersion };
  }
  const validSha256 = /^[a-f0-9]{64}$/i.test(sha256);
  const validSourceSha512 = /^[a-f0-9]{128}$/i.test(sourceSha512);
  if (!project || !version || !source || !artifact || !compatibility || (!validSha256 && !validSourceSha512)) return undefined;
  return {
    project,
    version,
    source,
    artifact,
    compatibility,
    ...(validSha256 ? { sha256: sha256.toLowerCase() } : {}),
    ...(validSourceSha512 ? { source_sha512: sourceSha512.toLowerCase() } : {}),
  };
}

function adaptLogDiagnostic(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[], expectedQueryDigest?: string): TypedGoalResult {
  const parsed = evidence.map((item) => parseLogQueryResult(item.summary));
  if (parsed.some((item) => !item)) return unavailable(goal, diagnostics, "missing_fact", "没有可审计的近期事件读取结果");
  const results = parsed.filter((item): item is NonNullable<ReturnType<typeof parseLogQueryResult>> => Boolean(item));
  if (expectedQueryDigest && results.some((item) => item.queryDigest !== expectedQueryDigest)) {
    return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "近期事件回调与原查询条件不一致");
  }
  if (results.some((item) => item.sampleCount !== item.samples.length || item.matches < item.sampleCount || item.matches === 0 && item.sampleCount !== 0)) {
    return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "近期事件回调中的数量与样例元数据互相矛盾");
  }
  const counts = stableUnique(results.map((item) => item.matches));
  if (counts.length !== 1) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", "近期事件回调包含互相冲突的数量");
  if (goal.result_kind === "count") return { ...available(goal, counts[0], diagnostics), summary: `匹配到 ${counts[0]} 条相关事件` };
  if (goal.result_kind === "collection") {
    const samples = stableUnique(results.flatMap((item) => item.samples));
    return { ...available(goal, samples, diagnostics), summary: counts[0] === 0 ? "未发现相应异常迹象" : `发现 ${counts[0]} 条相关事件${samples.length ? `；样例：${samples.slice(0, 3).join("；")}` : ""}` };
  }
  if (goal.result_kind === "fact") return { ...available(goal, counts[0] > 0, diagnostics), summary: counts[0] > 0 ? "发现需要关注的相关事件" : "未发现相应异常迹象" };
  return unavailable(goal, diagnostics, "invalid_operands");
}

function parseLogQueryResult(summary: string) {
  const header = summary.match(/^Log query result:\s*matches=(\d+);\s*window_minutes=(\d+);\s*scanned_lines=(\d+);\s*sample_count=(\d+);\s*(?:query_digest=([a-f0-9]{64});\s*)?filters=([^\r\n]*)/m);
  if (!header) return undefined;
  const marker = summary.indexOf("Matched samples:");
  const tail = marker >= 0 ? summary.slice(marker + "Matched samples:".length).trim() : "";
  const samples = !tail || tail === "<none>" ? [] : tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { matches: Number(header[1]), windowMinutes: Number(header[2]), scannedLines: Number(header[3]), sampleCount: Number(header[4]), queryDigest: header[5], filters: header[6], samples };
}

function adaptConfigValue(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const separator = goal.target.lastIndexOf("#");
  if (separator <= 0 || separator === goal.target.length - 1) return unavailable(goal, diagnostics, "invalid_operands");
  const key = goal.target.slice(separator + 1);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*[:=]\\s*(.*?)\\s*$`, "i");
  const values = evidence.flatMap((item) => item.summary.split(/\r?\n/).map((line) => line.match(pattern)?.[1]).filter((value): value is string => value !== undefined));
  const usable = values.filter((value) => value !== "<MISSING>" && !/^\[REDACTED/i.test(value));
  if (!usable.length) return unavailable(goal, diagnostics, "missing_fact", `Configuration key ${key} is missing or unavailable`);
  const unique = stableUnique(usable);
  if (unique.length > 1) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", `Configuration key ${key} has conflicting authoritative values`);
  return { ...available(goal, unique[0], diagnostics), summary: `${key}=${unique[0]}` };
}

function adaptServerVersion(goal: GoalRequirement, evidence: Evidence[], diagnostics: string[]): TypedGoalResult {
  const facts: Array<{ platform: string; minecraft_version: string; build?: string }> = [];
  for (const item of evidence) {
    for (const line of item.summary.split(/\r?\n/)) {
      if (isDiagnostic(line)) continue;
      const paperLike = line.match(/\b(?:this server is running|server is running)\s+(paper|purpur|spigot|bukkit)\s+version\s+([^\s,;]+)(?:.*?\(MC:\s*([0-9]+(?:\.[0-9]+){1,3})\))?/i);
      if (paperLike) {
        const build = paperLike[2];
        const minecraft = paperLike[3] ?? build.match(/[0-9]+(?:\.[0-9]+){1,3}/)?.[0];
        if (minecraft) facts.push({ platform: paperLike[1].toLowerCase(), minecraft_version: minecraft, build });
        continue;
      }
      const fabric = line.match(/\bfabric(?:\s+loader)?\s+([^\s,;]+).*?\b(?:minecraft|mc)\s+([0-9]+(?:\.[0-9]+){1,3})/i);
      if (fabric) facts.push({ platform: "fabric", minecraft_version: fabric[2], build: fabric[1] });
      const vanilla = line.match(/\bminecraft(?:\s+java)?\s+(?:server\s+)?(?:version\s+)?([0-9]+(?:\.[0-9]+){1,3})\b/i);
      if (vanilla && !/fabric|paper|purpur|spigot|bukkit/i.test(line)) facts.push({ platform: "vanilla", minecraft_version: vanilla[1] });
    }
  }
  const unique = stableUnique(facts.map((fact) => JSON.stringify(fact))).map((fact) => JSON.parse(fact) as typeof facts[number]);
  const identities = new Set(unique.map((fact) => `${fact.platform}:${fact.minecraft_version}`));
  if (identities.size > 1) return unavailable(goal, diagnostics, "conflicting_authoritative_facts", `Conflicting authoritative server facts: ${[...identities].join(", ")}`);
  if (!unique.length) return unavailable(goal, diagnostics, "missing_fact");
  const fact = unique[0];
  return {
    ...available(goal, fact, diagnostics),
    summary: `服务端实现：${displayPlatform(fact.platform)}；Minecraft 版本：${fact.minecraft_version}${fact.build ? `；构建：${fact.build}` : ""}`,
  };
}

function displayPlatform(platform: string) {
  return platform === "paper" ? "Paper"
    : platform === "purpur" ? "Purpur"
      : platform === "spigot" ? "Spigot"
        : platform === "bukkit" ? "Bukkit"
          : platform === "fabric" ? "Fabric"
            : platform === "vanilla" ? "Vanilla"
              : platform;
}

export function evaluateGoalPredicate(predicate: GoalPredicate, values: Map<string, unknown>): {
  available: boolean; observed?: boolean; satisfied: boolean; operands: unknown[]; reason?: string;
} {
  const resolved = predicate.operands.map((operand) => resolveOperand(operand, values));
  if (resolved.some((item) => !item.available)) return { available: false, satisfied: false, operands: resolved.map((item) => item.value), reason: "invalid_or_missing_operand" };
  const operands = resolved.map((item) => item.value);
  let observed: boolean | undefined;
  switch (predicate.operator) {
    case "all_match": observed = Array.isArray(operands[0]) && operands[0].every((item) => matchesFilter(String(item), predicate.operands[0].filter!)); break;
    case "any_match": observed = Array.isArray(operands[0]) && operands[0].some((item) => matchesFilter(String(item), predicate.operands[0].filter!)); break;
    case "equals": observed = comparable(operands[0]) === comparable(operands[1]); break;
    case "not_equals": observed = comparable(operands[0]) !== comparable(operands[1]); break;
    case "lt": case "lte": case "gt": case "gte": {
      const [left, right] = operands.map(Number);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return { available: false, satisfied: false, operands, reason: "numeric_operands_required" };
      observed = predicate.operator === "lt" ? left < right : predicate.operator === "lte" ? left <= right : predicate.operator === "gt" ? left > right : left >= right;
      break;
    }
    case "and": observed = operands.every((item) => item === true); break;
    case "or": observed = operands.some((item) => item === true); break;
    case "not": observed = operands[0] === false; break;
  }
  if (observed === undefined) return { available: false, satisfied: false, operands, reason: "unsupported_predicate" };
  return { available: true, observed, satisfied: observed === predicate.expected, operands };
}

function resolveOperand(operand: GoalPredicateOperand, values: Map<string, unknown>) {
  if (operand.predicate) {
    const nested = evaluateGoalPredicate(operand.predicate, values);
    return { available: nested.available, value: nested.observed };
  }
  if (Object.prototype.hasOwnProperty.call(operand, "value")) return { available: true, value: operand.value };
  if (!operand.goal_id || !values.has(operand.goal_id)) return { available: false, value: undefined };
  const value = values.get(operand.goal_id);
  if (operand.selector === "count") return { available: Array.isArray(value), value: Array.isArray(value) ? value.length : undefined };
  if (operand.selector === "filtered_count") return { available: Array.isArray(value) && Boolean(operand.filter), value: Array.isArray(value) && operand.filter ? value.filter((item) => matchesFilter(String(item), operand.filter!)).length : undefined };
  return { available: value !== undefined, value };
}

function available(goal: GoalRequirement, observed: unknown, diagnostics: string[]): TypedGoalResult {
  return { available: true, observed, diagnostics, summary: `${goal.description}: ${typeof observed === "object" ? JSON.stringify(observed) : String(observed)}` };
}

function unavailable(goal: GoalRequirement, diagnostics: string[], reason: TypedGoalResult["reason"], summary?: string): TypedGoalResult {
  return { available: false, diagnostics, reason, summary: summary ?? `${goal.description}: required fact is missing or not safely parseable` };
}

function diagnosticLines(summary: string) { return summary.split(/\r?\n/).filter(isDiagnostic); }
function isDiagnostic(line: string) { return /(?:warn|error|exception|failed|timeout)/i.test(line) || /^\s*at\s+[\w.$]+\(/i.test(line); }

function listingEntries(summary: string) {
  const line = summary.split(/\r?\n/).find((candidate) => /(?:directory|folder|entries|items|files|:)/i.test(candidate)) ?? summary;
  const content = line.includes("：") ? line.slice(line.lastIndexOf("：") + 1) : line.includes(":") ? line.slice(line.lastIndexOf(":") + 1) : line;
  return content.split(/[、，,\n]/).map((item) => item.trim().replace(/[.。]$/, "")).filter(Boolean);
}

function matchesFilter(value: string, filter: NonNullable<GoalRequirement["filter"]>) {
  const normalized = value.toLowerCase();
  const expected = filter.value.toLowerCase();
  if (filter.operator === "suffix") return normalized.endsWith(expected);
  if (filter.operator === "contains") return normalized.includes(expected);
  return normalized === expected;
}
function stableUnique<T>(values: T[]) { return [...new Set(values)]; }
function comparable(value: unknown) { return typeof value === "string" ? value.trim().toLowerCase() : JSON.stringify(value); }
