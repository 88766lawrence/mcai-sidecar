import type {
  ClauseRoleEntry,
  EvidencePolicy,
  GoalRequirement,
  OperationObjective,
  PlanConstraint,
  ResponsePolicy,
  ResultKind,
  SourceAtom,
  SourceGoal,
  TaskStep,
} from "@mcai/contracts";
import { extractTransientPlayerEffectCommand, isOnlinePlayerReadIntent, isRuntimeVersionReadIntent, performanceReadMetrics, resourcePressureMatch, resourcePressureRequested, resolveBoundedConsoleWrite } from "./operation-intent";
import { compileLogFilterQuery, logEventFilters, type LogFilterQueryV1 } from "./log-filter-query";
import { extractPluginResolveIntent, pluginMetadataSignal } from "./plugin-resolve-intent";
import { extractWhitelistReadIntent } from "./whitelist-read-intent";
import { extractGameruleReadIntent } from "./gamerule-read-intent";
import { extractRuntimeConsoleRead, type RuntimeConsoleReadKind } from "./runtime-console-read";

export interface RequestedGoal {
  key: string;
  description: string;
  domain: string;
  action: OperationObjective["action"];
  target: string;
  tool: string;
  args: Record<string, unknown>;
  order: number;
}

export interface LogQueryIntent {
  window_minutes: number;
  max_lines: number;
  filters: string[];
  filter_query: LogFilterQueryV1;
}

const logSubjectPattern = /(?:日志|记录|报错|错误|异常|崩溃|警告|logs?|log\s+entries|records?|errors?|exceptions?|warnings?|crash(?:es|ed)?)/i;
const logObservationPattern = /(?:翻翻|看看|查查|查|读取|查看|查询|检查|调取|获取|筛选|搜索|找|分析|诊断|read|show|query|check|inspect|fetch|search|find|look\s+through|scan|review|examine|analy[sz]e|diagnos)/i;

export function extractLogQueryIntent(intent: string): LogQueryIntent | undefined {
  // A concrete instance path plus a file suffix and collection/count language
  // is a filesystem observation even when the directory name contains words
  // such as "crash" or "log".  Do not manufacture a parallel log diagnosis.
  if (extractFilesystemPath(intent) && (extractSuffix(intent) || /\.[a-z0-9_-]{1,16}\b/i.test(intent))
    && /(?:目录|文件夹|条目|文件名|文件|数量|个数|多少|directory|folder|entries|file\s*names?|files?|count|how\s+many|number)/i.test(intent)) return undefined;
  if (/(?:目录|文件夹|directory|folder|files?)/i.test(intent)
    && /(?:\.[a-z0-9_-]{1,16}\b|[A-Za-z0-9._-]+-[A-Za-z0-9._-]+\s*(?:目录|文件夹|directory|folder))/i.test(intent)) return undefined;
  if (!logSubjectPattern.test(intent) || !logObservationPattern.test(intent) && !/(?:最近|近期|过去|recent|last)\b/i.test(intent)) return undefined;
  const windowMinutes = logWindowMinutes(intent);
  const filterQuery = compileLogFilterQuery(logFilterScope(intent));
  return { window_minutes: windowMinutes, max_lines: Math.min(1000, Math.max(100, windowMinutes * 8)), filters: logEventFilters(filterQuery).slice(0, 8), filter_query: filterQuery };
}

function logFilterScope(intent: string) {
  const subject = intent.match(logSubjectPattern);
  if (!subject) return intent;
  const subjectIndex = subject.index ?? 0;
  const observationPattern = new RegExp(logObservationPattern.source, "ig");
  const observations = [...intent.matchAll(observationPattern)].filter((match) => (match.index ?? 0) <= subjectIndex);
  const start = observations.at(-1)?.index ?? 0;
  const sentenceEnd = intent.slice(subjectIndex).search(/[；;。\r\n]/);
  const end = sentenceEnd < 0 ? intent.length : subjectIndex + sentenceEnd;
  return intent.slice(start, end);
}

function logWindowMinutes(intent: string) {
  if (/(?:半小时|half\s+(?:an?\s+)?hour)/i.test(intent)) return 30;
  const hours = intent.match(/(?:最近|近|过去|last|past|previous)?\s*(\d{1,3})\s*(?:小时|时|hours?|hrs?)/i)?.[1];
  if (hours) return Math.min(1440, Math.max(1, Number(hours) * 60));
  const minutes = intent.match(/(?:最近|近|过去|last|past|previous)?\s*(\d{1,4})\s*(?:分钟|分|minutes?|mins?)/i)?.[1];
  return minutes ? Math.min(1440, Math.max(1, Number(minutes))) : 60;
}

type SourceCandidate = Omit<SourceGoal, "id" | "depends_on" | "status"> & { status?: SourceGoal["status"] };

function onlinePlayerSourceSpan(text: string) {
  const patterns = [
    /在线[^，,；;。！？.!?\r\n]{0,12}(?:玩家|成员|人数|名单)/i,
    /(?:玩家|成员|人数|名单)[^，,；;。！？.!?\r\n]{0,12}在线/i,
    /\bwho\s+is\s+online\b/i,
    /\bonline\s+(?:players?|members?|roster)\b/i,
    /\b(?:players?|members?|roster)[^,;.!?\r\n]{0,20}\bonline\b/i,
    /\bhow\s+many[^,;.!?\r\n]{0,24}\bonline\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { text: match[0], index: match.index ?? 0 };
  }
  return { text, index: 0 };
}

export function conditionalFirstPlayerGamemodeIntent(text: string) {
  const online = text.match(/(?:在线玩家|在线成员|有人(?:在线|连接)?|(?:存在|有)连接成员|连接中的成员|players?\s+(?:are\s+)?(?:online|connected)|(?:online|connected)\s+(?:players?|members?)|(?:anyone|anybody|someone|somebody)\s+(?:is\s+)?(?:online|connected))/i);
  const gamemode = text.match(/(?:游戏模式|gamemode|game\s*mode)/i);
  const conditional = text.match(/(?:如果|若|假如|有人(?:的话|时)?|if|when|provided\s+that)/i);
  const selection = text.match(/(?:第一(?:个|名|位)|首(?:个|名|位)|任选(?:一个|一名|一位)|随便(?:一个|一名|一位)|first|one\s+of\s+them|any\s+one)/i);
  if (!online || !gamemode || !conditional || !selection) return undefined;
  return { sourceIndex: online.index ?? 0, sourceText: online[0] };
}

const evidenceRequirementPattern = /(?:(?:每|each|every).{0,40}(?:真实|实际|real|actual).{0,12}(?:回调|证据|callback|evidence)|(?:真实|实际|real|actual).{0,12}(?:回调|证据|callback|evidence).{0,40}(?:每|each|every)|independent(?:ly)?\s+(?:verify|recheck)|独立复验|二次核对)/i;
const responseRequirementPattern = /(?:覆盖|包含).{0,12}(?:全部|所有|每(?:个|一项)?)(?:目标|结果)|(?:综合|汇总)(?:回答|结论)|complete\s+answer.{0,20}(?:every|all).{0,8}(?:result|goal)|cover(?:s|ing)?\s+(?:every|all).{0,8}(?:result|goal)|finish\s+with.{0,20}(?:answer|conclusion|summary)|(?:否则|不然|otherwise).{0,28}(?:报告|说明|告诉|report|say|tell).{0,28}(?:没有|无人|none|nobody|no\s+one)/i;
const knownDomainPattern = /(?:服务端|服务器|minecraft|server).{0,24}(?:类型|版本|构建|实现|build|implementation|version)|\b(?:server|minecraft)\s+(?:build|implementation|version)\b|\b(?:tps|mspt|ticks?\s+per\s+second|tick\s+rate|milliseconds?\s+per\s+tick)\b|\btick\s*(?:速率|速度)|(?:每秒|一秒)[^，,。;；\r\n]{0,6}\bticks?\b|(?:内存|运行内存)(?:占用|使用|用了|消耗|用量)?|(?:RAM|memory|heap)\s*(?:usage|use|used|consumption|utilization)?|在线(?:成员|玩家|人数)|online\s+(?:players?|members?|roster)|(?:已加载|loaded|installed).{0,10}(?:插件|plugins?)|(?:插件).{0,6}(?:目录|文件)|plugins?\s+(?:directory|folder|files?)|\b[A-Za-z0-9][A-Za-z0-9._-]{0,63}\s*(?:目录|文件夹|directory|folder)|(?:日志|警告|错误|报错|异常|崩溃|logs?|warnings?|errors?|crash)|(?:最近|近期|recent).{0,12}(?:记录|records?)|(?:权限|授权|permission|authorization).{0,12}(?:记录|日志|record|log)|(?:根目录|root\s+(?:directory|folder))|(?:统计|总数|总量|数量|个数|条目数|文件数|count|total\s+(?:count|number)|filtered\s+count)|\.[a-z0-9_-]+.{0,12}(?:数量|个数|条目数|文件数|count|number)|\/[A-Za-z0-9._\/-]+|(?:难度|difficulty|whitelist|gamerule|gamemode|weather|time|重启|启动|停止|安装|下载|配置|install|download|start|stop|restart|configure|modify|write)/i;
const businessIntentPattern = /(?:量化|测算|计算|分析|诊断|检查|读取|查看|列出|报告|判断|确认|修改|写入|安装|下载|启动|停止|重启|measure|quantify|calculate|analy[sz]e|diagnos|inspect|read|show|list|report|determine|verify|modify|write|install|download|start|stop|restart)/i;

export function buildClauseRoleLedger(intent: string): ClauseRoleEntry[] {
  const semantic = scanAtomicClauses(intent);
  const entries: ClauseRoleEntry[] = [];
  let negativeEnumeration = false;
  let filesystemClauseContext = false;
  let pluginClauseContext = Boolean(extractPluginResolveIntent(intent));
  let previousEnd = 0;
  for (const [index, clause] of semantic.entries()) {
    const gap = intent.slice(previousEnd, clause.start);
    if (/[；;。\n]|\b(?:then|and\s+then)\b|(?:然后|随后|之后|最后)/i.test(gap)) negativeEnumeration = false;
    const sourceStart = [...intent.slice(0, clause.start)].length;
    const sourceEnd = sourceStart + [...clause.text].length;
    let role: ClauseRoleEntry["role"] = "discourse";
    let polarity: ClauseRoleEntry["polarity"] = "neutral";
    let status: ClauseRoleEntry["status"] = "mapped";
    let reason = "discourse_component";
    if (evidenceRequirementPattern.test(clause.text)) {
      role = "evidence_requirement"; polarity = "positive"; reason = "mapped_to_evidence_policy";
    } else if (responseRequirementPattern.test(clause.text)) {
      role = "response_requirement"; polarity = "positive"; reason = "mapped_to_response_policy";
    } else if (isConstraintClause(clause.text) || negativeEnumeration && forbiddenAliases.some(([, pattern]) => pattern.test(clause.text))) {
      role = "safety_constraint"; polarity = "negative"; reason = "mapped_to_plan_constraint";
    } else if (extractTransientPlayerEffectCommand(clause.text) || isOnlinePlayerReadIntent(clause.text) || extractRuntimeConsoleRead(clause.text) || extractGameruleReadIntent(clause.text) || extractPluginResolveIntent(clause.text)
      || pluginClauseContext && pluginMetadataSignal.test(clause.text) || knownDomainPattern.test(clause.text) || isJudgementClause(clause.text)
      || Boolean(extractSuffix(clause.text) && /(?:文件|条目|包|files?|file\s*names?|entries?|packages?|bundles?|archives?)/i.test(clause.text))
      || filesystemClauseContext && /(?:统计|数量|个数|多少|文件名|名称|名单|count|number|how\s+many|names?)/i.test(clause.text)) {
      role = "domain_goal"; polarity = "positive"; reason = "eligible_for_source_goal_mapping";
    } else if (businessIntentPattern.test(clause.text)) {
      role = "unknown_business_goal"; polarity = "positive"; status = "clarify"; reason = "no_registered_domain_mapping";
    }
    entries.push({ id: `clause-${index + 1}`, source_text: clause.text, source_start: sourceStart, source_end: sourceEnd,
      role, polarity, status, reason, source_atom_ids: [], source_goal_ids: [], constraint_actions: [] });
    if (role === "domain_goal" && (extractFilesystemPath(clause.text) || /(?:目录|文件夹|directory|folder).{0,24}(?:条目|文件|entries|files?)/i.test(clause.text))) {
      filesystemClauseContext = true;
    }
    if (extractPluginResolveIntent(clause.text)) pluginClauseContext = true;
    negativeEnumeration = role === "safety_constraint";
    previousEnd = clause.start + clause.text.length;
  }
  const occupied = entries.map((entry) => [entry.source_start, entry.source_end] as const);
  for (const match of intent.matchAll(/\b(?:and\s+then|then|and)\b|(?:然后|随后|并且|以及|同时|最后|之后|再)/ig)) {
    const start = [...intent.slice(0, match.index ?? 0)].length;
    const end = start + [...match[0]].length;
    if (occupied.some(([left, right]) => left < end && right > start)) continue;
    entries.push({ id: `clause-discourse-${entries.length + 1}`, source_text: match[0], source_start: start, source_end: end,
      role: "discourse", polarity: "neutral", status: "mapped", reason: "connector_component", source_atom_ids: [], source_goal_ids: [], constraint_actions: [] });
  }
  return entries.sort((left, right) => left.source_start - right.source_start || left.source_end - right.source_end).map((entry, index) => ({ ...entry, id: `clause-${index + 1}` }));
}

export function deriveMetaPolicies(ledger: ClauseRoleEntry[]): { evidence: EvidencePolicy; response: ResponsePolicy } {
  const evidenceClauses = ledger.filter((entry) => entry.role === "evidence_requirement");
  const responseClauses = ledger.filter((entry) => entry.role === "response_requirement");
  return {
    evidence: {
      require_real_callback_per_goal: evidenceClauses.some((entry) => /(?:回调|callback|evidence)/i.test(entry.source_text)),
      require_independent_verification: evidenceClauses.some((entry) => /(?:独立|二次|independent|recheck)/i.test(entry.source_text)),
      clause_ids: evidenceClauses.map((entry) => entry.id),
    },
    response: {
      cover_all_required_goals: responseClauses.some((entry) => /(?:全部|所有|每|every|all|cover)/i.test(entry.source_text)),
      require_synthesis: responseClauses.some((entry) => /(?:综合|汇总|conclusion|summary|complete\s+answer)/i.test(entry.source_text)),
      clause_ids: responseClauses.map((entry) => entry.id),
    },
  };
}

/**
 * Extracts the user's atomic requested results before the planner is allowed to
 * choose tools.  This is intentionally separate from tool routing: a planner
 * cannot make an omitted goal disappear merely by omitting its step.
 */
export function extractSourceGoals(intent: string, clauseLedger: ClauseRoleEntry[] = buildClauseRoleLedger(intent)): SourceGoal[] {
  const found: SourceCandidate[] = [];
  const configScope = configIdentifierScope(intent);
  const domainIntent = configScope?.maskedIntent ?? intent;
  let filesystemContext: string | undefined;
  // Carry suffixes forward only after their audited source clause is seen.
  // This keeps an explicit unfiltered total distinct from a later filtered
  // count in compound analytical requests.
  let filesystemSuffixContext: string | undefined;
  let diagnosticContext = false;
  let pluginContext: string | undefined = extractPluginResolveIntent(domainIntent)?.project;
  const add = (text: string, codeUnitStart: number, normalized: string, domain: string, entity: string, resultKind: ResultKind,
    filter?: SourceGoal["filter"], itemSchema?: SourceGoal["item_schema"]) => {
    const sourceStart = [...intent.slice(0, codeUnitStart)].length;
    found.push({
      source_text: text, source_start: sourceStart, source_end: sourceStart + [...text].length,
      normalized, domain, entity, result_kind: resultKind, ...(filter ? { filter } : {}), ...(itemSchema ? { item_schema: itemSchema } : {}),
      required: true,
    });
  };

  const gameruleRead = extractGameruleReadIntent(domainIntent);
  if (gameruleRead) {
    add(gameruleRead.rule, gameruleRead.sourceIndex, `gamerule.value:${gameruleRead.rule}`, "gamerule", gameruleRead.rule, "fact");
    const ruleLower = gameruleRead.rule.toLowerCase();
    const judgement = ruleLower === "randomtickspeed"
      ? domainIntent.match(/(?:随机刻|random\s*tick)[^，,；;。.!?\r\n]{0,28}(?:停用|停止|关闭|disabled|stopped|off)|(?:是否|判断|whether|determine)[^，,；;。.!?\r\n]{0,28}(?:停用|停止|disabled|zero)/i)
      : ruleLower === "domobspawning"
        ? domainIntent.match(/(?:生物|怪物|mobs?|creatures?)[^，,；;。.!?\r\n]{0,32}(?:自然生成|自然刷新|spawn\s+naturally|natural\s+spawning)|(?:自然生成|natural\s+spawning)[^，,；;。.!?\r\n]{0,24}(?:是否|whether|enabled|允许)/i)
        : undefined;
    if (judgement) add(judgement[0], judgement.index ?? gameruleRead.sourceIndex, `gamerule.judgement:${gameruleRead.rule}`, "gamerule", gameruleRead.rule, "judgement");
  }

  const runtimeConsoleRead = extractRuntimeConsoleRead(domainIntent);
  if (runtimeConsoleRead) {
    const runtimeAdd = (normalized: string, entity: string, resultKind: ResultKind, text = runtimeConsoleRead.sourceText, index = runtimeConsoleRead.sourceIndex) =>
      add(text, index, normalized, "world", entity, resultKind, resultKind === "collection" ? undefined : undefined,
        resultKind === "collection" ? { name: "string" } : undefined);
    if (runtimeConsoleRead.kind === "seed") runtimeAdd("world.seed", "world.seed", "fact");
    if (runtimeConsoleRead.kind === "difficulty") {
      runtimeAdd("world.difficulty", "world.difficulty", "fact");
        if (runtimeConsoleRead.wantsPeacefulJudgement) runtimeAdd("world.difficulty-peaceful", "world.difficulty", "judgement", runtimeConsoleRead.peacefulText, runtimeConsoleRead.peacefulIndex);
    }
    if (runtimeConsoleRead.kind === "daytime") {
      runtimeAdd("world.daytime", "world.daytime", "fact");
        if (runtimeConsoleRead.wantsPeriodJudgement) runtimeAdd("world.day-period", "world.daytime", "judgement", runtimeConsoleRead.periodText, runtimeConsoleRead.periodIndex);
    }
    if (runtimeConsoleRead.kind === "gametime") {
      runtimeAdd("world.gametime", "world.gametime", "fact");
      if (runtimeConsoleRead.wantsGreaterThanZeroJudgement) runtimeAdd("world.gametime-positive", "world.gametime", "judgement", runtimeConsoleRead.greaterThanZeroText, runtimeConsoleRead.greaterThanZeroIndex);
    }
    if (runtimeConsoleRead.kind === "worldborder") runtimeAdd("world.border-diameter", "world.border-diameter", "fact");
    if (runtimeConsoleRead.kind === "datapacks-enabled") {
      if (runtimeConsoleRead.wantsCollection) runtimeAdd("world.datapacks-enabled", "world.datapacks-enabled", "collection");
      if (runtimeConsoleRead.wantsCount) runtimeAdd(
        "world.datapacks-enabled-count", "world.datapacks-enabled", "count",
        runtimeConsoleRead.countText, runtimeConsoleRead.countIndex,
      );
    }
    const rosterKinds: Partial<Record<RuntimeConsoleReadKind, string>> = {
      "datapacks-available": "world.datapacks-available",
      "banned-players": "world.banned-players",
      teams: "world.teams",
      "scoreboard-objectives": "world.scoreboard-objectives",
      forceload: "world.forceload",
    };
    const rosterTarget = rosterKinds[runtimeConsoleRead.kind];
    if (rosterTarget) {
      if (runtimeConsoleRead.wantsCollection) runtimeAdd(rosterTarget, rosterTarget, "collection");
      if (runtimeConsoleRead.wantsCount) runtimeAdd(`${rosterTarget}-count`, rosterTarget, "count", runtimeConsoleRead.countText, runtimeConsoleRead.countIndex);
    }
  }

  const runtimeVersionOnly = isRuntimeVersionReadIntent(domainIntent)
    && !/(?:玩家|成员|人数|名单|tps|mspt|内存|ram|memory|插件|plugin|日志|logs?|文件|目录|files?|folder|配置|config)/i.test(domainIntent);
  if (runtimeVersionOnly) add(intent, 0, "server.version", "server", "version", "fact");
  const logQuery = extractLogQueryIntent(domainIntent);
  if (logQuery) {
    const logClause = clauseLedger.find((entry) => logSubjectPattern.test(entry.source_text))
      ?? clauseLedger.find((entry) => /(?:异常|超时|失败|error|timeout|failure)/i.test(entry.source_text));
    const subjectMatch = logClause?.source_text.match(logSubjectPattern);
    const subjectOffset = subjectMatch?.index ?? 0;
    const collectionText = logClause ? logClause.source_text.slice(subjectOffset) : intent;
    const collectionStart = logClause ? codeUnitOffset(intent, logClause.source_start) + subjectOffset : 0;
    add(collectionText, collectionStart, "logs.events", "diagnosis", "recent-logs", "collection", undefined, { line: "string" });
    const countSignal = domainIntent.match(/(?:有没有|是否(?:出现|存在|发生|有)|多少(?:次|条)?|数量|条数|count|how\s+many|whether|any\s+(?:matching|such)?)/i);
    const judgementClause = clauseLedger.find((entry) => isJudgementClause(entry.source_text) && isLogAbnormalJudgement(entry.source_text));
    if (countSignal || judgementClause) {
      const sourceText = countSignal?.[0] ?? collectionText;
      const sourceIndex = countSignal?.index ?? collectionStart;
      add(sourceText, sourceIndex, "logs.event-count", "diagnosis", "recent-logs", "count");
    }
    if (judgementClause) add(judgementClause.source_text, codeUnitOffset(intent, judgementClause.source_start), `derived.judgement:${judgementClause.source_start}`, "diagnosis", "recent-logs", "judgement");
  }
  const configRead = configScope?.config;
  if (configRead) {
    for (const key of configRead.keys) {
      const index = intent.toLowerCase().indexOf(key.toLowerCase());
      if (index >= 0) add(intent.slice(index, index + key.length), index, `config.value:${configRead.path}:${key}`, "config", `${configRead.path}#${key}`, "fact");
    }
  }
  const whitelistRead = extractWhitelistReadIntent(domainIntent);
  if (whitelistRead) {
    if (whitelistRead.wantsRoster) {
      const match = intent.slice(whitelistRead.rosterIndex).match(/(?:名单|列表|成员|玩家|用户|roster|names?|members?|players?|users?)/i);
      const text = match?.[0] ?? intent.slice(whitelistRead.sourceIndex, whitelistRead.sourceIndex + 3);
      add(text, whitelistRead.rosterIndex + (match?.index ?? 0), "access.whitelist-roster", "access", "whitelist", "collection", undefined, { name: "string" });
    }
    if (whitelistRead.wantsCount) {
      const match = intent.slice(whitelistRead.countIndex).match(/(?:人数|数量|个数|多少(?:人|个)?|统计|有没有|是否为空|是不是空|count|how\s+many|number\s+of|empty|any\s+(?:members?|players?|users?))/i);
      const text = match?.[0] ?? intent.slice(whitelistRead.sourceIndex, whitelistRead.sourceIndex + 3);
      add(text, whitelistRead.countIndex + (match?.index ?? 0), "access.whitelist-count", "access", "whitelist", "count");
    }
  }

  const onlineRead = !runtimeConsoleRead && isOnlinePlayerReadIntent(domainIntent);
  const conditionalGamemode = conditionalFirstPlayerGamemodeIntent(domainIntent);
  const transientPlayerEffect = extractTransientPlayerEffectCommand(domainIntent);
  const onlineCountSignal = domainIntent.match(/(?:在线|连接(?:中|着)?|online|connected)[^，,；;。.!?\r\n]{0,18}(?:人数|数量|多少|几位|几人|count|how\s+many|number)|(?:人数|数量|多少|几位|几人|count|how\s+many|number)[^，,；;。.!?\r\n]{0,18}(?:在线|连接(?:中|着)?|online|connected)/i);
  const capacitySignal = domainIntent.match(/(?:最大|最多|上限|容量|maximum|max(?:imum)?|capacity|limit)[^，,；;。.!?\r\n]{0,20}(?:玩家|人数|多少人|几人|players?|people|slots?)|(?:玩家|人数|多少人|几人|players?|people|slots?)[^，,；;。.!?\r\n]{0,20}(?:最大|最多|上限|容量|maximum|max(?:imum)?|capacity|limit)/i);
  const ratioSignal = domainIntent.match(/(?:占用|占比|比例|百分比|occupancy|utilization|percentage|ratio)/i);
  const explicitPlayerObservation = /(?:查看|看|查询|查|统计|数|给出|报告|告诉|read|show|check|count|report|tell|how\s+many)/i.test(domainIntent);
  const onlineCapacityRead = onlineRead || Boolean(onlineCountSignal && capacitySignal && explicitPlayerObservation);
  if (onlineCapacityRead && onlineCountSignal) add(onlineCountSignal[0], onlineCountSignal.index ?? 0, "players.online-count", "players", "online", "count");
  if (onlineCapacityRead && capacitySignal) add(capacitySignal[0], capacitySignal.index ?? 0, "config.value:server.properties:max-players", "config", "server.properties#max-players", "fact");
  if (onlineCapacityRead && capacitySignal && ratioSignal) add(ratioSignal[0], ratioSignal.index ?? 0, "players.occupancy-ratio", "players", "occupancy", "fact");
  if (conditionalGamemode) {
    const gamemode = domainIntent.match(/(?:游戏模式|gamemode|game\s*mode)/i)!;
    add(gamemode[0], gamemode.index ?? conditionalGamemode.sourceIndex, "players.first-online-gamemode", "players", "conditional-first-online", "fact");
  }

  const requestedPerformance = logQuery ? [] : performanceReadMetrics(domainIntent);
  const wantsPressure = !logQuery && resourcePressureRequested(domainIntent);
  const requiredRuntimeMetrics = [...new Set([
    ...requestedPerformance.filter((metric) => metric === "uptime" || metric === "cpu" || metric === "memory"),
    ...(wantsPressure ? ["cpu" as const, "memory" as const] : []),
  ])];
  for (const metric of requiredRuntimeMetrics) {
    const pattern = metric === "uptime"
      ? /(?:已|持续)?(?:运行|启动|在线)(?:时长|时间|多久|了多久)|(?:开|启动|运行)了?多长时间|(?:process|server|service)?\s*uptime|how\s+long[^,，;；.。]{0,24}(?:running|up)/i
      : metric === "cpu"
      ? /\bcpu\b|\bprocessor\s*(?:usage|use|utilization|load)?\b|(?:处理器|进程)\s*(?:占用|使用率|负载)/i
      : /(?:内存|运行内存)(?:占用|使用|用了|消耗|用量)?|(?:RAM|memory|heap)\s*(?:usage|use|used|consumption|utilization)?/i;
    const match = domainIntent.match(pattern);
    const rawSourceText = match?.[0] ?? (wantsPressure ? resourcePressureMatch(domainIntent)?.[0] : undefined);
    const sourceText = rawSourceText?.trim();
    if (sourceText) {
      const localOffset = rawSourceText?.indexOf(sourceText) ?? 0;
      add(sourceText, (match?.index ?? domainIntent.indexOf(rawSourceText ?? sourceText)) + localOffset, `performance.${metric}`, "performance", metric, "fact");
    }
  }
  if (wantsPressure) {
    const match = resourcePressureMatch(domainIntent);
    if (match) add(match[0], match.index ?? 0, "performance.pressure", "performance", "resource-pressure", "judgement");
  }

  for (const clause of clauseLedger.filter((entry) => entry.role === "domain_goal" || entry.role === "unknown_business_goal").map((entry) => ({ text: entry.source_text, start: codeUnitOffset(intent, entry.source_start), role: entry.role }))) {
    if (runtimeVersionOnly) continue;
    const text = domainIntent.slice(clause.start, clause.start + clause.text.length);
    // The domain router has enough entity/action evidence to identify this
    // parameter-free observation even when the general clause ledger labelled
    // an unfamiliar phrasing as unknown. Preserve the original clause span and
    // map it to the registered player collection instead of manufacturing an
    // unsupported business goal.
    const playerRead = !runtimeConsoleRead && isOnlinePlayerReadIntent(text);
    const runtimeVersionRead = isRuntimeVersionReadIntent(text);
    const pluginRead = extractPluginResolveIntent(text);
    if (pluginRead && !pluginContext) pluginContext = pluginRead.project;
    const pluginContinuation = !pluginRead && pluginContext && pluginMetadataSignal.test(text);
    const whitelistContinuation = Boolean(whitelistRead && /(?:白名单|允许名单|准入名单|whitelist|allowlist|名单|列表|成员|玩家|用户|人数|数量|个数|多少|统计|count|members?|players?|users?|roster|names?)/i.test(text));
    if (playerRead && !conditionalGamemode && (!onlineCountSignal || /(?:名单|名称|谁|哪些|names?|roster|who|which)/i.test(text))) {
      const span = onlinePlayerSourceSpan(text);
      add(span.text, clause.start + span.index, "players.online", "players", "online", "collection", undefined, { name: "string" });
    }
    if (runtimeVersionRead) {
      add(text, clause.start, "server.version", "server", "version", "fact");
    }
    if (clause.role === "unknown_business_goal") {
      if (configRead) continue;
      if (conditionalGamemode) continue;
      const performanceRead = performanceReadMetrics(text).length > 0 || resourcePressureRequested(text);
      const occupancyRead = /(?:占用|占比|比例|百分比|occupancy|utilization|percentage|ratio)/i.test(text) && onlineRead;
      const playerCapacityRead = onlineRead && /(?:最大|最多|上限|容量|maximum|max(?:imum)?|capacity|limit)/i.test(text);
      if (!playerRead && !playerCapacityRead && !runtimeVersionRead && !pluginRead && !pluginContinuation && !whitelistContinuation && !performanceRead && !occupancyRead && !runtimeConsoleRead && !gameruleRead) add(text, clause.start, "unknown.business", "unknown", text, "fact");
      continue;
    }
    const addFirst = (pattern: RegExp, normalized: string, domain: string, entity: string, resultKind: ResultKind,
      itemSchema?: SourceGoal["item_schema"]) => {
      const match = text.match(pattern);
      if (match) add(match[0], clause.start + (match.index ?? 0), normalized, domain, entity, resultKind, undefined, itemSchema);
    };
    const pluginProject = pluginContext ?? pluginRead?.project;
    if (pluginProject) add(text, clause.start, `plugin.resolve:${pluginProject}`, "plugin", pluginProject, "fact");
    const literalPath = extractFilesystemPath(text);
    const rootTarget = text.match(/(?:根目录|root\s+(?:directory|folder))/i);
    const explicitPath = literalPath ?? (rootTarget ? "/" : undefined);
    if (explicitPath) filesystemContext = explicitPath;
    const refersToFilesystemContext = /(?:\u5176\u4e2d|\u76ee\u5f55|\u6761\u76ee|\u6587\u4ef6|\u540e\u7f00|\u7ed3\u5c3e|\u7edf\u8ba1|\u6570\u91cf|\u4e2a\u6570|\u591a\u5c11|\u6761\u76ee\u6570|entries|items|files?|directory|folder|matching|suffix|ending|ends?|\bcount\b|\bnumber\b|\bhow\s+many\b)/i.test(text);
    const path = explicitPath ?? (filesystemContext && refersToFilesystemContext ? filesystemContext : undefined);
    const explicitSuffix = extractSuffix(text);
    if (explicitSuffix) filesystemSuffixContext = explicitSuffix;
    const suffix = explicitSuffix ?? (filesystemContext && refersToFilesystemContext ? filesystemSuffixContext : undefined);
    const aggregationOnly = /(?:\u7edf\u8ba1|\u6570\u4e00\u6570|\u6570\u91cf|\u4e2a\u6570|\u591a\u5c11|\bcount\b|\bnumber\b|\bhow\s+many\b)/i.test(text);
    const filesystemCollection = Boolean(path && /(?:列出|读取|查看|显示|扫描|检查|目录|条目|文件|list|read|show|scan|inspect|check|entries|files?|directory|folder)/i.test(text));

    if (!runtimeVersionRead) addFirst(/(?:服务端|服务器|实例|游戏服|运行环境|minecraft|mc|server|instance|host|runtime).{0,32}(?:类型|版本|构建(?:号|版本)?|实现(?:版本)?|内核|发行版|平台|build|implementation|platform|distribution|kernel|release)|\b(?:exact|precise|current|live|actual|running)?\s*(?:server|minecraft|runtime)\s+(?:version|build|implementation|platform|distribution|kernel|release)\b/i, "server.version", "server", "version", "fact");
    if (!transientPlayerEffect && !runtimeConsoleRead && !conditionalGamemode && !onlineCountSignal) addFirst(/(?:当前)?在线(?:成员|玩家|人数)(?:名单|列表)?|(?:当前|现有).{0,4}(?:玩家|成员)(?:名单|列表)|(?:current\s+)?online\s+(?:roster|players?|members?)/i, "players.online", "players", "online", "collection", { name: "string" });
    addFirst(/\btps\b|\bticks?\s+per\s+second\b|\btick\s*(?:rate\b|速率|速度)|(?:每秒|一秒)[^，,。;；\r\n]{0,6}\bticks?\b/i, "performance.tps", "performance", "tps", "fact");
    addFirst(/\bmspt\b|\bmilliseconds?\s+per\s+tick\b/i, "performance.mspt", "performance", "mspt", "fact");
    if (!logQuery && !requiredRuntimeMetrics.includes("uptime")) addFirst(/(?:已|持续)?(?:运行|启动|在线)(?:时长|时间|多久|了多久)|(?:开|启动|运行)了?多长时间|(?:process|server|service)?\s*uptime|how\s+long[^,，;；.。]{0,24}(?:running|up)/i, "performance.uptime", "performance", "uptime", "fact");
    if (!logQuery && !requiredRuntimeMetrics.includes("cpu")) addFirst(/\bcpu\b|\bprocessor\s*(?:usage|use|utilization|load)?\b|(?:处理器|进程)\s*(?:占用|使用率|负载)/i, "performance.cpu", "performance", "cpu", "fact");
    if (!logQuery && !requiredRuntimeMetrics.includes("memory")) addFirst(/(?:内存|运行内存)(?:占用|使用|用了|消耗|用量)?|(?:RAM|memory|heap)\s*(?:usage|use|used|consumption|utilization)?/i, "performance.memory", "performance", "memory", "fact");
    if (filesystemCollection && path && !isJudgementClause(text)
      && (!aggregationOnly || /(?:列出|读取|查看|显示|扫描|list|read|show|scan)/i.test(text))) {
      const pathSource = extractFilesystemPathSource(text);
      const span = pathSource ?? rootTarget?.[0] ?? text;
      add(span, clause.start + (pathSource ? text.indexOf(pathSource) : rootTarget?.index ?? 0), `filesystem.collection:${path}`, "filesystem", path, "collection", undefined, { name: "string", path: "string", type: "string" });
    }
    if (path && suffix && /(?:统计|数一数|数量|个数|多少|总数|总量|条目数|文件数|count|number|how\s+many)/i.test(text) && !isJudgementClause(text)) {
      add(text, clause.start, `filesystem.filtered-count:${path}:${suffix}`, "filesystem", path, "filtered_count", { field: "name", operator: "suffix", value: suffix });
    }
    const totalMatch = text.match(/(?:(?:统计|计算|count)?\s*(?:目录|全部|所有)?\s*(?:条目|文件)?\s*(?:总数|总量)|(?:目录|全部|所有)\s*(?:条目|文件)\s*(?:数量|个数)|(?:条目|文件)\s*(?:总数|总量)|(?:count|report|show)\s+(?:the\s+)?total(?:\s+(?:number\s+of\s+)?(?:entries|items|files))?|total\s+(?:number\s+of\s+)?(?:entries|items|files)|number\s+of\s+(?:all\s+)?(?:entries|items|files))/i);
    const explicitUnfilteredTotal = /(?:全部|所有|目录)\s*(?:条目|文件)?\s*(?:总数|总量|数量|个数)|(?:total\s+(?:count|number)|total\s+(?:number\s+of\s+)?(?:entries|items|files)|number\s+of\s+(?:all\s+)?(?:entries|items|files))/i.test(text);
    if (path && totalMatch && (!suffix || explicitUnfilteredTotal) && !isJudgementClause(text)) {
      add(totalMatch[0], clause.start + (totalMatch.index ?? 0), `filesystem.count:${path}`, "filesystem", path, "count");
    }
    if (/(?:已加载|loaded|installed).{0,10}(?:插件|plugins?)/i.test(text)) {
      add(text, clause.start, "plugins.loaded", "plugin", "loaded", /(?:数量|个数|统计|count)/i.test(text) ? "count" : "collection", undefined, { name: "string" });
    }
    if (!path && /(?:plugins?\s+(?:directory|folder|files?)|(?:插件).{0,6}(?:目录|文件))/i.test(text)) {
      addFirst(/(?:plugins?\s+(?:directory|folder|files?)|(?:插件).{0,6}(?:目录|文件))/i, "plugins.files", "plugin", "/plugins", "collection", { name: "string", path: "string", type: "string" });
    }
    const explicitRuntimeDiagnostic = text.match(/(?:check(?:ing)?|inspect|diagnos|query|查|分析|诊断|排查).{0,20}(?:运行)?(?:日志|警告|错误|报错|异常|logs?|warnings?|errors?)/i);
    const permissionAudit = text.match(/(?:检查|审计|查询|inspect|audit|check).{0,30}(?:权限|授权|permission|authorization).{0,12}(?:记录|日志|record|log)?/i);
    const runtimeLogSpan = explicitRuntimeDiagnostic ?? text.match(/(?:最近|近期|recent|过去|分钟|minutes?).{0,20}(?:运行)?(?:日志|记录|错误|报错|异常|崩溃|logs?|records?|errors?|crash)/i);
    const diagnosticSpan = runtimeLogSpan ?? permissionAudit;
    if (!logQuery && (!path || explicitRuntimeDiagnostic) && diagnosticSpan) {
      add(diagnosticSpan[0], clause.start + (diagnosticSpan.index ?? 0), "logs.events", "diagnosis", "recent-logs", /(?:条数|数量|count)/i.test(text) ? "count" : "collection", undefined, { line: "string", level: "string" });
      diagnosticContext = true;
    } else if (diagnosticContext && /(?:统计|汇总|数量|条数|count)(?:\s+(?:them|those|events?|lines?))?/i.test(text)) {
      add(text, clause.start, "logs.event-count", "diagnosis", "recent-logs", "count");
    }
    // A log-existence question is already represented by logs.event-count, and
    // a requested log-health conclusion is represented by the typed diagnosis
    // judgement above. Keep unrelated business conclusions (for example,
    // migration suitability) as explicit unsupported goals instead of silently
    // swallowing them into the log query.
    const typedJudgementAlreadyMapped = found.some((candidate) => candidate.result_kind === "judgement"
      && (candidate.normalized.startsWith("gamerule.judgement:") || candidate.normalized.startsWith("world.")));
    if (!runtimeConsoleRead && !pluginProject && !typedJudgementAlreadyMapped
      && !(conditionalGamemode && /(?:连接成员|在线(?:玩家|成员)|有人|connected\s+(?:players?|members?)|(?:players?|members?)\s+(?:online|connected))/i.test(text))
      && isJudgementClause(text) && !isQualitativePerformanceSynthesis(text) && !resourcePressureRequested(text)
      && !(logQuery && (isLogAbnormalJudgement(text) || isLogExistenceQuestion(text)))) {
      add(text, clause.start, `derived.judgement:${clause.start}`, path ? "filesystem" : "derived", path ?? "judgement", "judgement");
    }
  }

  // An explicit analytical atom that no registered domain understands remains
  // authoritative and unmapped; it is never silently deleted by known steps.
  for (const aggregate of found.filter((item) => item.domain === "filesystem" && (item.result_kind === "filtered_count" || item.result_kind === "count"))) {
    if (found.some((item) => item.result_kind === "collection" && item.domain === aggregate.domain && item.entity === aggregate.entity)) continue;
    found.push({
      source_text: aggregate.source_text,
      source_start: aggregate.source_start,
      source_end: aggregate.source_end,
      normalized: `support.collection:${aggregate.entity}`,
      domain: aggregate.domain,
      entity: aggregate.entity,
      result_kind: "collection",
      item_schema: { name: "string", path: "string", type: "string" },
      required: false,
      status: "mapped",
    });
  }

  if (/(?:文件名|条目名|名称|名单|列出|逐个|names?|file\s*names?|list)/i.test(intent)) {
    for (const filtered of found.filter((item) => item.domain === "filesystem" && item.result_kind === "filtered_count" && item.filter)) {
      const collection = found.find((item) => item.domain === filtered.domain && item.entity === filtered.entity && item.result_kind === "collection");
      if (collection) {
        collection.filter = { ...filtered.filter! };
        collection.required = true;
        collection.normalized = `filesystem.collection:${collection.entity}`;
      }
    }
  }

  const canonicalCollections = new Map<string, SourceCandidate>();
  const coalesced = found.filter((item) => {
    if (item.result_kind !== "collection") return true;
    const identity = collectionIdentity(item);
    const existing = canonicalCollections.get(identity);
    if (!existing) {
      canonicalCollections.set(identity, item);
      return true;
    }
    if (item.required && !existing.required) {
      existing.required = true;
      existing.source_text = item.source_text;
      existing.source_start = item.source_start;
      existing.source_end = item.source_end;
      existing.normalized = item.normalized;
    }
    return false;
  });
  const ordered = coalesced
    .filter((item, index, all) => all.findIndex((other) => other.normalized === item.normalized && other.result_kind === item.result_kind && other.source_start === item.source_start) === index)
    .sort((left, right) => left.source_start - right.source_start || (left.result_kind === "collection" ? -1 : 1));
  const goals: SourceGoal[] = ordered.map((item, index) => ({
    id: `sg-${index + 1}-${safeId(item.normalized)}`, ...item,
    depends_on: [],
    required: item.required,
    status: item.status ?? (item.domain === "unknown" ? "unmapped" as const : "mapped" as const),
  }));
  for (const goal of goals) {
    if ((goal.result_kind === "filtered_count" || goal.result_kind === "count") && goal.normalized !== "players.online-count") {
      const collection = goals.find((candidate) => candidate.domain === goal.domain && candidate.entity === goal.entity && candidate.result_kind === "collection");
      if (collection) goal.depends_on = [collection.id];
      else goal.status = "unmapped";
    }
    if (goal.normalized === "players.occupancy-ratio") {
      const playerFact = goals.find((candidate) => candidate.normalized === "players.online-count")
        ?? goals.find((candidate) => candidate.normalized === "players.online");
      const capacityFact = goals.find((candidate) => candidate.normalized === "config.value:server.properties:max-players");
      const dependencies = [playerFact, capacityFact].filter((candidate): candidate is SourceGoal => Boolean(candidate));
      goal.depends_on = dependencies.map((dependency) => dependency.id);
      if (dependencies.length !== 2) goal.status = "unmapped";
    } else if (goal.normalized === "performance.pressure") {
      const dependencies = goals.filter((candidate) => candidate.normalized === "performance.cpu" || candidate.normalized === "performance.memory");
      goal.depends_on = dependencies.map((dependency) => dependency.id);
      if (dependencies.length !== 2) goal.status = "unmapped";
      } else if (goal.normalized === "world.difficulty-peaceful") {
        const fact = goals.find((candidate) => candidate.normalized === "world.difficulty");
        if (!fact) goal.status = "unmapped";
        else {
          goal.depends_on = [fact.id];
          goal.predicate = directedPredicate("equals",
            spanOperand(typedOperand(fact), goal.source_text, goal.source_start, /(?:判断|是否|是不是|当前|现在|whether|if)/i, "left"),
            spanOperand({ value: "peaceful" }, goal.source_text, goal.source_start, /(?:和平(?:模式|难度)?|peaceful)/i, "right"));
        }
      } else if (goal.normalized === "world.day-period") {
        const fact = goals.find((candidate) => candidate.normalized === "world.daytime");
        if (!fact) goal.status = "unmapped";
        else {
          goal.depends_on = [fact.id];
          goal.predicate = directedPredicate("lt",
            spanOperand(typedOperand(fact), goal.source_text, goal.source_start, /(?:白天|day(?:time)?)/i, "left"),
            spanOperand({ value: 13000 }, goal.source_text, goal.source_start, /(?:夜晚|night(?:time)?)/i, "right"));
        }
      } else if (goal.normalized === "world.gametime-positive") {
        const fact = goals.find((candidate) => candidate.normalized === "world.gametime");
        if (!fact) goal.status = "unmapped";
        else {
          goal.depends_on = [fact.id];
          goal.predicate = directedPredicate("gt",
            spanOperand(typedOperand(fact), goal.source_text, goal.source_start, /(?:判断|是否|whether|determine|check)/i, "left"),
            spanOperand({ value: 0 }, goal.source_text, goal.source_start, /(?:零|0)/i, "right"));
        }
      } else if (goal.normalized.startsWith("gamerule.judgement:")) {
        const fact = goals.find((candidate) => candidate.normalized === `gamerule.value:${goal.entity}`);
        if (!fact) goal.status = "unmapped";
        else {
          goal.depends_on = [fact.id];
          const disabled = goal.entity.toLowerCase() === "randomtickspeed";
          goal.predicate = directedPredicate("equals",
            spanOperand(typedOperand(fact), goal.source_text, goal.source_start, /(?:判断|是否|whether|determine|check|当前|现在)/i, "left"),
            spanOperand({ value: disabled ? 0 : true }, goal.source_text, goal.source_start,
              disabled ? /(?:停用|停止|关闭|disabled|stopped|off|zero)/i : /(?:自然生成|自然刷新|spawn\s+naturally|natural\s+spawning|enabled|允许)/i, "right"));
        }
    } else if (goal.result_kind === "judgement") {
      const derived = deriveJudgementPredicate(goal.source_text, goals.filter((candidate) => candidate.id !== goal.id), goal.domain === "filesystem" ? goal.entity : undefined, goal.source_start);
      if (derived) {
        goal.predicate = derived.predicate;
        goal.depends_on = derived.dependencies.map((dependency) => dependency.id);
        goal.domain = derived.domain;
        goal.entity = derived.entity;
      } else goal.status = "unmapped";
    }
  }
  return goals;
}

/**
 * Immutable, source-first accounting of the user's request.  Unlike goals,
 * atoms exist before a tool is selected and therefore make unsupported text
 * visible instead of allowing it to disappear from coverage calculations.
 */
export function buildSourceAtomLedger(intent: string, clauseLedger: ClauseRoleEntry[], sourceGoals: SourceGoal[], constraints: PlanConstraint[]): SourceAtom[] {
  const atoms: SourceAtom[] = sourceGoals.filter((goal) => goal.required).map((goal) => ({
    id: `atom-${safeId(goal.id)}`,
    source_text: goal.source_text,
    source_start: goal.source_start,
    source_end: goal.source_end,
    polarity: "positive",
    role: goal.domain === "unknown" ? "unknown" : goal.result_kind,
    normalized: goal.normalized,
    required: true,
    status: goal.status === "mapped" ? "mapped" : "clarify",
    source_goal_ids: goal.status === "mapped" ? [goal.id] : [],
    reason: goal.status === "mapped" ? "mapped_to_typed_source_goal" : "no_compatible_capability_mapping",
    clause_id: clauseForGoal(clauseLedger, goal)?.id ?? "",
  }));
  for (const constraint of constraints) {
    const sourceStart = constraint.source_start;
    atoms.push({
      id: `atom-constraint-${atoms.length + 1}-${constraint.action}`,
      source_text: constraint.source,
      source_start: sourceStart,
      source_end: constraint.source_end,
      polarity: "negative",
      role: "constraint",
      normalized: `constraint.forbid:${constraint.action}`,
      required: false,
      status: "mapped",
      source_goal_ids: [],
      reason: "mapped_to_plan_constraint",
      clause_id: constraint.clause_id,
    });
  }
  for (const clause of clauseLedger.filter((entry) => entry.role === "unknown_business_goal")) {
    const overlaps = atoms.some((atom) => atom.source_start < clause.source_end && atom.source_end > clause.source_start);
    if (!overlaps) atoms.push({
      id: `atom-unknown-${atoms.length + 1}`,
      source_text: clause.source_text,
      source_start: clause.source_start,
      source_end: clause.source_end,
      polarity: "positive",
      role: "unknown",
      normalized: "unknown.unmapped",
      required: true,
      status: "clarify",
      source_goal_ids: [],
      reason: "positive_source_fragment_has_no_typed_mapping",
      clause_id: clause.id,
    });
  }
  for (const clause of clauseLedger) {
    let tracedAtoms = atoms.filter((atom) => atom.clause_id === clause.id
      || clause.role === "domain_goal" && clause.polarity === "positive"
        && atom.required && atom.polarity === "positive"
        && atom.source_start < clause.source_end && atom.source_end > clause.source_start);
    if (tracedAtoms.length === 0 && clause.role === "domain_goal" && clause.polarity === "positive"
      && /(?:文件名|名称|名单|列出|显示|filenames?|file\s+names?|names?|list|show)/i.test(clause.source_text)) {
      const collectionGoal = [...sourceGoals]
        .filter((goal) => goal.required && goal.status === "mapped" && goal.domain === "filesystem" && goal.result_kind === "collection" && goal.source_start <= clause.source_start)
        .sort((left, right) => right.source_start - left.source_start)[0];
      const collectionAtom = collectionGoal && atoms.find((atom) => atom.source_goal_ids.includes(collectionGoal.id));
      if (collectionAtom) tracedAtoms = [collectionAtom];
    }
    if (tracedAtoms.length === 0 && clause.role === "domain_goal" && clause.polarity === "positive"
      && logEventFilters(compileLogFilterQuery(clause.source_text)).length > 0) {
      // Event alternatives can be split into their own clause after the
      // initial log subject (for example topic AND event-A OR event-B). They
      // still contribute to the same audited collection query and therefore
      // must reverse-map to that collection instead of becoming an empty
      // business clause rejected by the Agent.
      const logCollection = sourceGoals.find((goal) => goal.required && goal.status === "mapped"
        && goal.domain === "diagnosis" && goal.entity === "recent-logs" && goal.result_kind === "collection");
      const logAtom = logCollection && atoms.find((atom) => atom.source_goal_ids.includes(logCollection.id));
      if (logAtom) tracedAtoms = [logAtom];
    }
    clause.source_atom_ids = [...new Set(tracedAtoms.map((atom) => atom.id))];
    clause.source_goal_ids = [...new Set(tracedAtoms.flatMap((atom) => atom.source_goal_ids))];
    // A clause that owns a deterministic, mapped goal is a business-domain
    // clause even when the earlier lexical classifier could not recognize its
    // wording. Keep the ledger consistent with the audited Atom -> Goal trace
    // instead of letting an "unknown" label make the Agent reject a valid
    // read-only plan. Clauses without mapped goals remain fail-closed.
    if (clause.source_goal_ids.length > 0
      && clause.role !== "domain_goal"
      && clause.polarity !== "negative") {
      clause.role = "domain_goal";
      clause.polarity = "positive";
      clause.status = "mapped";
      clause.reason = "mapped_by_typed_source_goal_trace";
    }
  }
  return atoms.sort((left, right) => left.source_start - right.source_start || left.source_end - right.source_end || left.role.localeCompare(right.role));
}

/**
 * A deterministic capability may intentionally represent several adjacent
 * phrases with one structured result (for example implementation + game
 * version). Such a goal spans the whole request and therefore is not contained
 * by any single clause. Bind it to the most specific overlapping positive
 * domain clause so the clause/atom/goal reverse trace remains auditable.
 */
function clauseForGoal(clauses: ClauseRoleEntry[], goal: SourceGoal): ClauseRoleEntry | undefined {
  const contained = clauseForSpan(clauses, goal.source_start, goal.source_end);
  if (contained) return contained;
  return clauses
    .filter((clause) => clause.role === "domain_goal"
      && clause.polarity === "positive"
      && clause.source_start < goal.source_end
      && clause.source_end > goal.source_start)
    .sort((left, right) => {
      const leftOverlap = Math.min(left.source_end, goal.source_end) - Math.max(left.source_start, goal.source_start);
      const rightOverlap = Math.min(right.source_end, goal.source_end) - Math.max(right.source_start, goal.source_start);
      return rightOverlap - leftOverlap || left.source_start - right.source_start;
    })[0];
}

function deriveJudgementPredicate(text: string, candidates: SourceGoal[], preferredEntity?: string, sourceStart = 0): { predicate: NonNullable<SourceGoal["predicate"]>; dependencies: SourceGoal[]; domain: string; entity: string } | undefined {
  const diagnosticCount = [...candidates].reverse().find((goal) => goal.domain === "diagnosis" && goal.entity === "recent-logs" && goal.result_kind === "count");
  if (diagnosticCount && isLogAbnormalJudgement(text)) return {
    predicate: directedPredicate("gt",
      spanOperand(typedOperand(diagnosticCount), text, sourceStart, /(?:判断|判定|是否|结论|有没有|whether|determine|judge|say)/i, "left"),
      spanOperand({ value: 0 }, text, sourceStart, /(?:异常|问题|健康|风险|迹象|征兆|需要(?:处理|干预|处置)|(?:是否|判断|判定).{0,6}(?:要|需)(?:处理|干预|处置)|abnormal|anomal|problem|healthy|warning\s+signs?|concern|(?:action|intervention|attention)\s+is\s+(?:needed|required)|needs?\s+(?:action|intervention|attention))/i, "right")),
    dependencies: [diagnosticCount], domain: "diagnosis", entity: "recent-logs",
  };
  const suffix = extractSuffix(text) ?? text.match(/\bends?\s+(?:in\s+)?(\.[a-z0-9_-]+)/i)?.[1];
  const collection = [...candidates].reverse().find((goal) => goal.result_kind === "collection" && (!preferredEntity || goal.entity === preferredEntity) && (!suffix || goal.item_schema?.name === "string"));
  if (collection && suffix && /(?:全部|所有|每(?:一|个)|all|every)/i.test(text)) return {
    predicate: directedPredicate("equals", spanOperand(typedOperand(collection, { field: "name", operator: "suffix", value: suffix }, "filtered_count"), text, sourceStart, suffix, "left"), spanOperand(typedOperand(collection, undefined, "count"), text, sourceStart, /(?:全部|所有|每(?:一|个)|all|every)/i, "right", true), "all", { field: "name", operator: "suffix", value: suffix }),
    dependencies: [collection], domain: collection.domain, entity: collection.entity,
  };
  if (collection && suffix && /(?:存在|任意|至少一个|any|exists?)/i.test(text)) return {
    predicate: directedPredicate("gt", spanOperand(typedOperand(collection, { field: "name", operator: "suffix", value: suffix }, "filtered_count"), text, sourceStart, suffix, "left"), spanOperand({ value: 0 }, text, sourceStart, /(?:存在|任意|至少一个|any|exists?)/i, "right", true), "any", { field: "name", operator: "suffix", value: suffix }, !/(?:不存在|没有|no\s+|not\s+any)/i.test(text)),
    dependencies: [collection], domain: collection.domain, entity: collection.entity,
  };
  const filtered = [...candidates].reverse().find((goal) => goal.result_kind === "filtered_count" && (!preferredEntity || goal.entity === preferredEntity) && (!suffix || goal.filter?.value.toLowerCase() === suffix.toLowerCase()));
  const total = filtered && [...candidates].reverse().find((goal) => (goal.result_kind === "count" || goal.result_kind === "collection") && goal.domain === filtered.domain && goal.entity === filtered.entity);
  const comparison = /(?:不等于|不为|does\s+not\s+equal|not\s+equal(?:s|\s+to)?)/i.test(text) ? "not_equals"
    : /(?:不超过|不多于|至多|less\s+than\s+or\s+equal|no\s+more\s+than|at\s+most)/i.test(text) ? "lte"
      : /(?:不少于|至少|greater\s+than\s+or\s+equal|no\s+less\s+than|at\s+least)/i.test(text) ? "gte"
        : /(?:小于|少于|低于|less\s+than)/i.test(text) ? "lt"
          : /(?:大于|多于|超过|greater\s+than|more\s+than)/i.test(text) ? "gt"
            : /(?:等于|相等|equals?|equal\s+to|the\s+same\s+as)/i.test(text) ? "equals"
              : undefined;
  const literal = numericLiteral(text);
  if (filtered && comparison && literal !== undefined) return {
    predicate: directedPredicate(comparison,
      spanOperand(typedOperand(filtered), text, sourceStart, suffix ?? filtered.filter?.value ?? /(?:数量|count|number)/i, "left"),
      spanOperand({ value: literal }, text, sourceStart, new RegExp(`-?${String(literal).replace(".", "\\.")}`), "right")),
    dependencies: [filtered], domain: filtered.domain, entity: filtered.entity,
  };
  if (filtered && total && comparison) return {
    predicate: comparisonHasTotalOnLeft(text)
      ? directedPredicate(comparison,
        spanOperand(typedOperand(total, undefined, total.result_kind === "collection" ? "count" : "observed"), text, sourceStart, totalOperandPattern, "left"),
        spanOperand(typedOperand(filtered), text, sourceStart, suffix ?? filtered.filter?.value ?? /(?:过滤|匹配|filtered|matching)/i, "right"))
      : directedPredicate(comparison,
        spanOperand(typedOperand(filtered), text, sourceStart, suffix ?? filtered.filter?.value ?? /(?:过滤|匹配|filtered|matching)/i, "left"),
        spanOperand(typedOperand(total, undefined, total.result_kind === "collection" ? "count" : "observed"), text, sourceStart, totalOperandPattern, "right")),
    dependencies: [filtered, total], domain: filtered.domain, entity: filtered.entity,
  };
  if (filtered && /(?:等于|为零|equals?\s+zero|equals?\s+0|is\s+zero)/i.test(text)) return {
    predicate: directedPredicate("equals",
      spanOperand(typedOperand(filtered), text, sourceStart, suffix ?? filtered.filter?.value ?? /(?:数量|count|number)/i, "left"),
      spanOperand({ value: 0 }, text, sourceStart, /(?:零|zero|0)/i, "right")),
    dependencies: [filtered], domain: filtered.domain, entity: filtered.entity,
  };
  return undefined;
}

function directedPredicate(
  operator: NonNullable<SourceGoal["predicate"]>["operator"],
  left: NonNullable<SourceGoal["predicate"]>["operands"][number],
  right: NonNullable<SourceGoal["predicate"]>["operands"][number],
  quantifier?: "all" | "any",
  filter?: SourceGoal["filter"],
  expected = true,
): NonNullable<SourceGoal["predicate"]> {
  return { schema_version: "goal-predicate/v2", operator, left, right, operands: [left, right], ...(quantifier ? { quantifier } : {}), ...(filter ? { filter } : {}), expected };
}

function comparisonHasTotalOnLeft(text: string) {
  const comparisonAt = text.search(/(?:不等于|不为|不超过|不多于|至少|小于|少于|低于|大于|多于|超过|等于|does\s+not\s+equal|not\s+equal|no\s+more\s+than|at\s+most|at\s+least|less\s+than|greater\s+than|more\s+than|equals?|equal\s+to)/i);
  if (comparisonAt < 0) return false;
  const before = text.slice(0, comparisonAt);
  return /(?:总数|总量|全部(?:条目|文件)?数|total(?:\s+(?:count|number))?|number\s+of\s+all)(?:\s+(?:is|are))?\s*$/i.test(before.trim());
}

function typedOperand(goal: SourceGoal, filter?: SourceGoal["filter"], selector: "observed" | "count" | "filtered_count" = "observed"): NonNullable<SourceGoal["predicate"]>["operands"][number] {
  return { goal_id: goal.id, selector, domain: goal.domain, entity: goal.entity, result_kind: goal.result_kind, ...(filter ? { filter } : {}) };
}

const totalOperandPattern = /(?:总数|总量|全部(?:条目|文件)?数|total(?:\s+(?:count|number))?|number\s+of\s+all)/i;

function spanOperand(operand: NonNullable<SourceGoal["predicate"]>["operands"][number], text: string, sourceStart: number,
  needle: string | RegExp, sourceRole: "left" | "right", implicit = false) {
  const match = typeof needle === "string" ? text.toLowerCase().indexOf(needle.toLowerCase()) : text.search(needle);
  const matchedText = match >= 0 ? (typeof needle === "string" ? text.slice(match, match + needle.length) : text.slice(match).match(needle)?.[0] ?? "") : "";
  const start = match >= 0 ? sourceStart + [...text.slice(0, match)].length : sourceStart;
  return { ...operand, source_text: matchedText || text, source_start: start, source_end: start + [...(matchedText || text)].length, source_role: implicit && match < 0 ? "implicit" as const : sourceRole };
}

function numericLiteral(text: string) {
  if (/(?:\bzero\b|零)/i.test(text)) return 0;
  const match = text.match(/(?:等于|不等于|不少于|不超过|大于|小于|at\s+least|at\s+most|equals?|equal\s+to|greater\s+than|less\s+than|not\s+equal(?:s|\s+to)?)\D*(-?\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : undefined;
}

function collectionIdentity(item: SourceCandidate) {
  const schema = Object.entries(item.item_schema ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([item.domain, item.entity.trim().replace(/\/$/, "") || "/", schema]);
}

function isJudgementClause(text: string) {
  const explicit = /(?:判断|判定|是否|结论|建议|需要(?:处理|干预|处置)|要不要(?:处理|干预|处置)|需不需要(?:处理|干预|处置)|recommend|suggest|decide|whether|determine|judge|tell\s+(?:me\s+)?if|say\s+if|assess|(?:action|intervention|attention)\s+is\s+(?:needed|required)|needs?\s+(?:action|intervention|attention))/i.test(text);
  const quantified = /(?:全部|所有|每(?:一|个)).{0,24}(?:都|均|以|后缀|结尾)|(?:任意|存在|至少一个).{0,24}(?:以|后缀|结尾)|\b(?:all|every|any)\b.{0,40}(?:ends?|ending|suffix|match)|\bexists?\b.{0,40}(?:ending|suffix|match)/i.test(text)
    && Boolean(extractSuffix(text));
  const compared = /(?:不等于|不为|不超过|不多于|不少于|至少|小于|少于|低于|大于|多于|超过|等于|does\s+not\s+equal|not\s+equal|no\s+more\s+than|at\s+most|no\s+less\s+than|at\s+least|less\s+than|greater\s+than|more\s+than|equals?|equal\s+to)/i.test(text)
    && /(?:数量|个数|总数|count|number)/i.test(text);
  return explicit || quantified || compared;
}
function isLogAbnormalJudgement(text: string) {
  return /(?:异常|问题|健康|风险|迹象|征兆|需要(?:处理|干预|处置)|要不要(?:处理|干预|处置)|需不需要(?:处理|干预|处置)|(?:是否|判断|判定).{0,6}(?:要|需)(?:处理|干预|处置)|abnormal|anomal|problem|trouble|risk|healthy|warning\s+signs?|signs?\s+of\s+(?:trouble|failure)|concern|(?:action|intervention|attention)\s+is\s+(?:needed|required)|needs?\s+(?:action|intervention|attention))/i.test(text);
}
function isLogExistenceQuestion(text: string) {
  return /(?:有没有|是否(?:出现|存在|发生)|多少(?:次|条)?|数量|条数|how\s+many|\bcount\b|whether\s+(?:there\s+(?:is|are|was|were)|any)|if\s+(?:there\s+(?:is|are|was|were)|any)|\bany\b.{0,24}\b(?:occurred|appeared|found|present|matching|events?|entries?|lines?|errors?|timeouts?)\b)/i.test(text);
}
function isQualitativePerformanceSynthesis(text: string) {
  const hasMetric = /\b(?:tps|mspt|tick\s+rate|milliseconds?\s+per\s+tick)\b|(?:内存|运行内存)(?:占用|使用|用了|消耗|用量)?|(?:RAM|memory|heap)\s*(?:usage|use|used|consumption|utilization)?/i.test(text);
  const hasExplicitPredicate = /(?:全部|所有|每(?:一|个)|任意|存在|至少|不等于|不为|不超过|不多于|不少于|小于|少于|低于|大于|多于|超过|等于|\b(?:all|every|any|exists?|equals?|less\s+than|greater\s+than|at\s+least|at\s+most)\b)/i.test(text);
  return hasMetric && !hasExplicitPredicate && /(?:顺不顺|流畅|平稳|健康|性能|负载|health|healthy|smooth|stable|performance|load)/i.test(text);
}
function extractSuffix(text: string) {
  const suffix = text.match(/(?:后缀|扩展名|结尾|ending(?:\s+in)?|ends?\s+in|suffix)[^\n,，;；]{0,12}(\.[a-z0-9_-]+)/i)?.[1]
    ?? text.match(/(\.[a-z0-9_-]+)(?=\s*(?:[\p{Script=Han}]{0,8})?(?:文件|条目|数量|个数|包)|\s*(?:[a-z][a-z0-9_-]{0,23}\s+)?(?:files?|file\s*names?|report\s+names?|entries?|packages?|bundles?|archives?)\b)/iu)?.[1]
    ?? text.match(/\b([a-z0-9][a-z0-9_-]{0,9})\b(?=\s*(?:[\p{Script=Han}]{0,8})?(?:文件|包|报告|报表|归档))/iu)?.[1]?.replace(/^/, ".")
    ?? text.match(/\b([A-Z0-9][A-Z0-9_-]{1,9})\b(?=\s+[A-Za-z][A-Za-z0-9_-]{0,23}\s+(?:files?|entries?|packages?|bundles?|archives?)\b)/)?.[1]?.replace(/^/, ".")
    ?? text.match(/\b([A-Za-z0-9][A-Za-z0-9_-]{0,9})\b(?=\s+(?:files?|filenames?|file\s+names?|packages?|bundles?|archives?)\b)/)?.[1]?.replace(/^/, ".")
    ?? (/(?:后缀|扩展名|结尾|ending|ends?|suffix)/i.test(text) ? text.match(/\.[a-z0-9_-]+/i)?.[0] : undefined);
  return suffix?.toLowerCase();
}
function normalizeInstanceFilesystemPath(candidate: string) {
  const raw = candidate.trim();
  if (!raw || /\\/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\/{2,}/.test(raw)) return undefined;
  const relative = raw.startsWith("/") ? raw.slice(1) : raw;
  const segments = relative.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]{1,128}$/.test(segment))) {
    return undefined;
  }
  return `/${segments.join("/")}`;
}

export function hasUnsafeInstanceFilesystemPath(text: string) {
  return /(?:[A-Za-z]:[\\/]|\\\\|(?:^|[^A-Za-z0-9._-])\.{1,2}\/|\/\.\.?\/|\/{2,})/i.test(text);
}

function extractFilesystemPathSource(text: string) {
  // A path-shaped token is authoritative. If it is unsafe, do not fall back to
  // its final basename and accidentally turn an invalid request into a broader
  // valid read (for example, world/../private -> /private).
  if (hasUnsafeInstanceFilesystemPath(text)) return undefined;

  const namedEnglishDirectory = text.match(/\b(?:inspect|read|list|scan|check|review)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:for|and|with)\b/i)?.[1];
  if (namedEnglishDirectory && namedEnglishDirectory.toLowerCase() !== "plugin") return namedEnglishDirectory;

  const prepositionalEnglishDirectory = text.match(/\b(?:under|inside|within)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$|[,.!?;])/i)?.[1];
  if (prepositionalEnglishDirectory && prepositionalEnglishDirectory.toLowerCase() !== "plugin") return prepositionalEnglishDirectory;

  const nested = text.match(/["'“”]((?:\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)["'“”]/)?.[1]
    ?? text.match(/(?:^|[^A-Za-z0-9._\/-])((?:\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=\s|$|(?:目录|文件夹|内|下|里|中|directory|folder)|[，,。；;！？!?])/i)?.[1];
  if (nested) return nested.replace(/\.$/, "");

  const explicit = text.match(/["'“”](\/[A-Za-z0-9._-]+)["'“”]/)?.[1]
    ?? text.match(/(?:^|\s)(\/[A-Za-z0-9._-]+)(?=\s|$|[，,。；;！？!?])/i)?.[1];
  if (explicit) return explicit;
  const namedDirectory = text.match(/\b([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*(?:目录|文件夹|directory|folder)/i)?.[1];
  if (!namedDirectory || namedDirectory.toLowerCase() === "plugin") return undefined;
  return namedDirectory;
}

function extractFilesystemPath(text: string) {
  const source = extractFilesystemPathSource(text);
  return source ? normalizeInstanceFilesystemPath(source) : undefined;
}

function scanAtomicClauses(intent: string): Array<{ text: string; start: number }> {
  const primary: Array<{ text: string; start: number }> = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  const quotePairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  const push = (end: number) => {
    const raw = intent.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) primary.push({ text, start: start + leading });
  };
  for (let index = 0; index < intent.length; index++) {
    const char = intent[index];
    if (quote) { if (char === quote) quote = ""; continue; }
    if (quotePairs[char]) { quote = quotePairs[char]; continue; }
    if (/[（(\[]/.test(char)) { depth++; continue; }
    if (/[）)\]]/.test(char)) { depth = Math.max(0, depth - 1); continue; }
    const asciiSentenceBoundary = char === "." && /\s/.test(intent[index + 1] ?? "")
      && /[\p{L}\p{N}]/u.test(intent.slice(index + 1).trimStart()[0] ?? "");
    if (depth === 0 && (/[，,、；;。\n]/.test(char) || asciiSentenceBoundary)) { push(index); start = index + 1; }
  }
  push(intent.length);
  const result: Array<{ text: string; start: number }> = [];
  // Do not condition ledger segmentation on a finite verb catalogue. Newly
  // phrased coordinated targets must stand alone and fail closed instead of
  // disappearing behind a recognized sibling in the same sentence.
  const connector = /\b(?:and\s+then|then|and)\b|(?:然后|随后|并且|以及|同时|最后|再(?=(?:读取|查看|核对|判断|统计|列出|执行|确认)))/ig;
  for (const clause of primary) {
    let cursor = 0;
    for (const match of clause.text.matchAll(connector)) {
      const index = match.index ?? 0;
      const before = clause.text.slice(cursor, index).trim();
      if (before) result.push({ text: before, start: clause.start + cursor + clause.text.slice(cursor, index).indexOf(before) });
      cursor = index + match[0].length;
    }
    const tail = clause.text.slice(cursor).trim();
    if (tail) result.push({ text: tail, start: clause.start + cursor + clause.text.slice(cursor).indexOf(tail) });
  }
  return result;
}

const forbiddenAliases: Array<[PlanConstraint["action"], RegExp]> = [
  ["write", /\bwriting\b/i],
  ["download", /(?:下载|拉取|download|fetch)/i],
  ["install", /(?:安装|部署|装入|install|deploy)/i],
  ["restart", /(?:重启|\brestart\b|\breboot\b)/i],
  ["start", /(?:启动|开机|\bstart(?:ing)?\b|\blaunch(?:ing)?\b)/i],
  ["stop", /(?:停止|停服|关服|\bstop(?:ping)?\b|\bshutdown\b)/i],
  ["write", /(?:修改|写入|删除|覆盖|更改|调整|设置|设为|改(?:动|变|写)?|配置|添加|加入|新增|创建|移除|解除|(?:启用|停用).{0,16}(?:数据包|资料包|包)|modify|alter|edit|write|delete|overwrite|change|adjust|set|add|create|remove|pardon|(?:enable|disable).{0,24}(?:data\s*packs?|packages?))/i],
];

const negation = /(?:不要|不得|不允许|禁止|无需|不必|别|不可|避免|只读|不落盘|不(?=修改|写入|删除|覆盖|更改|调整|设置|新增|创建|添加|移除|解除|启用|停用)|do\s+not|don't|without|never|no\s+(?:changes?|modifications?)|read[- ]?only)/i;
const readObservationSignal = /(?:只读|读取|读一下|查看|看看|瞅|查(?:看|询|一下|查)?|核对|复核|确认(?:一下|当前|现有|实际)?|显示|给出|告诉|知道|报告|算(?:一)?下|统计|列出|各是多少|是什么值|read[- ]?only|\bread\b|\bshow\b|\binspect\b|\breport\b|\bprovide\b|\bgive\b|\btell\b|\bcheck\b|\bverify\b|\breview\b|\bcalculate\b|\bcount\b|\blist\b|\bwhat\s+is\b|\bwhat\s+are\b)/i;

const factObservationObjectSignal = /(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\.(?:properties|conf|json|ya?ml)\b|\s*(?:目录|文件夹|directory|folder))|(?:当前|现在|目前|现有|实际)[^，,；;。.!?\r\n]{0,20}(?:值|版本|实现|构建|名单|成员|人数|数量|状态|模式|规则|比例|上限)|(?:在线|连接(?:中|着)?)[^，,；;。.!?\r\n]{0,16}(?:人数|数量|多少|几位|几人|玩家|成员)|(?:值|版本|实现|构建|名单|成员|人数|数量|游戏模式|游戏规则|文件名|比例|上限)(?:分别|各自|各)?(?:是|为|有|多少)?|(?:玩家|成员)[^，,；;。.!?\r\n]{0,16}(?:游戏模式|gamemode|game\s*mode)|(?:进程|服务|实例)?(?:(?:已|持续)?运行(?:时长|时间|多久|了多久)|CPU|处理器|内存)(?:占用|使用|用量|负载)?|(?:process|service|instance)?\s*(?:uptime|cpu|processor|memory|ram)(?:\s+(?:usage|use|utilization|load))?|\bcurrent\s+(?:values?|versions?|builds?|members?|rosters?|counts?|game\s*modes?|gamerules?)\b|\b(?:values?|versions?|builds?|members?|rosters?|counts?|game\s*modes?|gamerules?|file\s*names?)\s+(?:currently|right\s+now)\b)/i;

function isFactObservationClause(text: string) {
  const withoutReadOnly = text.replace(/(?:只读|read[- ]?only)/ig, " ");
  return readObservationSignal.test(withoutReadOnly) && factObservationObjectSignal.test(text);
}

function isConstraintClause(text: string) {
  if (extractRuntimeConsoleRead(text)) return false;
  if (conditionalFirstPlayerGamemodeIntent(text)) return false;
  if (extractFilesystemPath(text) && readObservationSignal.test(text)
    && /(?:目录|文件夹|文件|报告|条目|数量|多少|列出|directory|folder|files?|reports?|entries?|count|list)/i.test(text)) return false;
  const semanticText = semanticConstraintText(text);
  const negatedAt = semanticText.search(negation);
  if (negatedAt < 0) return false;
  const scope = semanticText.slice(negatedAt);
  if (/(?:只读|read[- ]?only)/i.test(scope) && isFactObservationClause(text)) return false;
  return forbiddenAliases.some(([, pattern]) => pattern.test(scope)) || /(?:只读|read[- ]?only)/i.test(scope);
}

function positiveAtomicText(intent: string) {
  return scanAtomicClauses(intent).filter((clause) => !isConstraintClause(clause.text)).map((clause) => clause.text).join("；");
}

export interface ConfigReadIntent {
  path: string;
  keys: string[];
}

export interface ConfigIdentifierScope {
  config: ConfigReadIntent;
  maskedIntent: string;
  spans: Array<{ start: number; end: number; kind: "path" | "key" }>;
}

const configFilePattern = /\/?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:properties|conf|json|ya?ml))(?=$|[\s"'”’)，,.。；;：:?？!！]|[\u3400-\u9fff])/i;
const configReadSignal = readObservationSignal;
const configKnowledgeSignal = /(?:解释|含义|什么意思|教程|怎么配置|如何配置|\bexplain\b|\bmeaning\b|\bwhat\s+does\b|\bhow\s+to\b)/i;
const configCurrentStateSignal = /(?:当前|现在|目前|现有|实际|正在|\bcurrent(?:ly)?\b|\bpresent\b|\bactual(?:ly)?\b|\bright\s+now\b)/i;
const configShellSignal = /(?:\b(?:cat|grep|awk|sed|powershell|cmd|bash|sh)\b|\|\s*\w+|\/path\/to\/)/i;
const configWriteAssignment = /(?:设为|设置为|改为|修改成|更新为|写入.{0,60}[=:]|change\s+.+?\s+to|set\s+.+?\s+to|write\s+.+?=|(?:key|键|配置项)\s*[：:=].{0,40}(?:value|值)\s*[：:=])/i;
const configKeyStopWords = new Set([
  "a", "all", "alter", "an", "and", "anything", "are", "as", "at", "be", "binding", "both", "change", "changing", "check", "config", "configuration", "current", "do", "each", "edit", "editing", "explain", "file", "for", "from", "get", "in", "inside", "inspect", "is", "it", "key", "keys", "leave", "me", "modify", "not", "now", "of", "only", "or", "please", "present", "read", "readonly", "report", "review", "show", "tell", "the", "their", "them", "these", "they", "this", "to", "unchanged", "untouched", "value", "values", "verify", "what", "without", "write", "writing", "yaml", "yml", "json", "properties", "conf",
]);

/**
 * Extracts a bounded read of explicit keys from an explicit configuration
 * file. The source sentence remains authoritative: generated shell snippets,
 * placeholder paths, knowledge questions, and positive assignments never
 * enter this path.
 */
export function extractConfigReadIntent(intent: string): ConfigReadIntent | undefined {
  const knowledgeOnly = configKnowledgeSignal.test(intent) && !configCurrentStateSignal.test(intent);
  if (!configReadSignal.test(intent) || knowledgeOnly || configShellSignal.test(intent) || configWriteAssignment.test(intent)) return undefined;
  const pathMatch = intent.match(configFilePattern);
  if (!pathMatch) return undefined;
  const path = pathMatch[1].replace(/^\/+/, "");
  const pathParts = new Set(path.toLowerCase().split(/[\/.]/).filter(Boolean));
  const keys: string[] = [];
  const addKey = (raw: string) => {
    const key = raw.trim().replace(/^[`"'“‘]+|[`"'”’]+$/g, "");
    const lower = key.toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{1,127}$/.test(key) || pathParts.has(lower) || configKeyStopWords.has(lower) || /^qa\d/i.test(lower)) return;
    if (!keys.some((item) => item.toLowerCase() === lower)) keys.push(key);
  };
  for (const match of intent.matchAll(/[`"'“‘]([A-Za-z][A-Za-z0-9_.-]{1,127})[`"'”’]/g)) addKey(match[1]);
  const withoutPath = intent.replace(pathMatch[0], " ");
  for (const match of withoutPath.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{1,127}\b/g)) addKey(match[0]);
  return keys.length ? { path, keys } : undefined;
}

/**
 * Configuration paths and keys are opaque identifiers, not prose. Mask their
 * exact source occurrences (without changing string length) before adjacent
 * domain routers inspect the request. This preserves auditable offsets while
 * preventing identifiers from manufacturing unrelated domain goals.
 */
export function configIdentifierScope(intent: string): ConfigIdentifierScope | undefined {
  const config = extractConfigReadIntent(intent);
  if (!config) return undefined;
  const spans: ConfigIdentifierScope["spans"] = [];
  const pathMatch = intent.match(configFilePattern);
  if (pathMatch?.index !== undefined) spans.push({ start: pathMatch.index, end: pathMatch.index + pathMatch[0].length, kind: "path" });
  const lower = intent.toLowerCase();
  let searchFrom = 0;
  for (const key of config.keys) {
    const ordered = lower.indexOf(key.toLowerCase(), searchFrom);
    const start = ordered < 0 ? lower.indexOf(key.toLowerCase()) : ordered;
    if (start < 0) continue;
    spans.push({ start, end: start + key.length, kind: "key" });
    searchFrom = start + key.length;
  }
  const chars = intent.split("");
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) chars[index] = " ";
  }
  return { config, maskedIntent: chars.join(""), spans };
}

export function extractPlanConstraints(intent: string, clauseLedger: ClauseRoleEntry[] = buildClauseRoleLedger(intent)): PlanConstraint[] {
  // Constraints are source-bound safety claims, not merely an action set.
  // Preserve one projection per clause/action so repeated local prohibitions
  // remain independently auditable by the zero-trust Agent validator.
  const constraints = new Map<string, PlanConstraint>();
  for (const entry of clauseLedger.filter((item) => item.role === "safety_constraint")) {
    const rawClause = entry.source_text;
    const clause = semanticConstraintText(rawClause);
    const negatedAt = clause.search(negation);
    const scope = negatedAt < 0 ? clause : clause.slice(negatedAt);
    const scopeOnlyWrite = /(?:除此之外|除(?:了|外)[^，,；;。.!?]{0,32}(?:什么|其他|其余|任何).{0,16}(?:别|不要|不得|禁止).{0,8}(?:改|变更|写)|(?:anything|everything|nothing)\s+else|no\s+other\s+changes?)/i.test(rawClause);
    const domainScopedWrite = /(?:配置|游戏规则|gamerules?|configuration|config(?:uration)?)/i.test(rawClause)
      && !/(?:任何|全部|所有|everything|anything|all\s+(?:writes?|changes?))/i.test(rawClause);
    for (const [action, pattern] of forbiddenAliases) {
      // A domain-scoped "do not modify configuration/rules" clause is a
      // real write prohibition and is safe alongside a read-only step. Only
      // the generic "nothing else" scope guard is handled outside the
      // action-forbid set so it does not reject the one explicitly requested
      // write operation.
      if (action === "write" && (scopeOnlyWrite || domainScopedWrite && Boolean(resolveBoundedConsoleWrite(intent)))) continue;
      if (!pattern.test(scope)) continue;
      constraints.set(`${entry.id}:${action}`, { action, effect: "forbid", source: rawClause, source_start: entry.source_start, source_end: entry.source_end, clause_id: entry.id });
      entry.constraint_actions.push(action);
    }
    if (/(?:只读|read[- ]?only)/i.test(scope)) {
      constraints.set(`${entry.id}:write`, { action: "write", effect: "forbid", source: rawClause, source_start: entry.source_start, source_end: entry.source_end, clause_id: entry.id });
      if (!entry.constraint_actions.includes("write")) entry.constraint_actions.push("write");
    }
  }
  return [...constraints.values()];
}

function semanticConstraintText(text: string) {
  return text.replace(/["'“‘][^"'”’]*["'”’]/g, " ").replace(/\/[A-Za-z0-9._\/-]+/g, " ");
}

export function extractReadGoals(intent: string, context: {
  pluginProject?: string;
  platform?: string;
  minecraftVersion?: string;
  loader?: string;
} = {}): RequestedGoal[] {
  const originalIntent = intent;
  const originalConfigScope = configIdentifierScope(intent);
  const gameruleRead = extractGameruleReadIntent(originalConfigScope?.maskedIntent ?? intent);
  intent = positiveAtomicText(intent);
  const configScope = configIdentifierScope(intent);
  const configRead = configScope?.config;
  const domainIntent = configScope?.maskedIntent ?? intent;
  const goals: RequestedGoal[] = [];
  const add = (goal: Omit<RequestedGoal, "order">, pattern: RegExp) => {
    const match = pattern.exec(domainIntent);
    if (!match) return;
    if (!goals.some((item) => item.key === goal.key)) goals.push({ ...goal, order: match.index });
  };

  const logQuery = extractLogQueryIntent(originalConfigScope?.maskedIntent ?? originalIntent);
  const runtimeConsoleRead = extractRuntimeConsoleRead(originalConfigScope?.maskedIntent ?? originalIntent);
  const whitelistRead = extractWhitelistReadIntent(domainIntent);
  if (gameruleRead) {
    goals.push({
      key: `gamerule.value:${gameruleRead.rule}`,
      description: `读取游戏规则 ${gameruleRead.rule} 当前值`,
      domain: "gamerule",
      action: "read",
      target: gameruleRead.rule,
      tool: "console.command",
      args: { command: `gamerule ${gameruleRead.rule}` },
      order: gameruleRead.sourceIndex,
    });
  }
  if (configRead) {
    for (const key of configRead.keys) {
      const order = intent.toLowerCase().indexOf(key.toLowerCase());
      goals.push({
        key: `config.value:${configRead.path}:${key}`,
        description: `Read ${key} from ${configRead.path}`,
        domain: "config",
        action: "read",
        target: `${configRead.path}#${key}`,
        tool: "config.inspect",
        args: { path: configRead.path, keys: configRead.keys },
        order: order >= 0 ? order : 0,
      });
    }
  }

  const conditionalGamemode = conditionalFirstPlayerGamemodeIntent(domainIntent);
  const playerObservationScope = originalConfigScope?.maskedIntent ?? originalIntent;
  const explicitPlayerObservationRead = /(?:查看|看|查询|查|统计|数|给出|报告|告诉|read|show|check|count|report|tell|how\s+many)/i.test(playerObservationScope);
  const onlineCapacityRequested = /(?:在线|连接(?:中|着)?|online|connected)/i.test(playerObservationScope)
    && /(?:人数|多少|几位|几人|players?|people)/i.test(playerObservationScope)
    && /(?:最大|最多|上限|容量|maximum|max(?:imum)?|capacity|limit)/i.test(playerObservationScope)
    && explicitPlayerObservationRead;
  if (!runtimeConsoleRead && (isOnlinePlayerReadIntent(domainIntent) || onlineCapacityRequested) && !conditionalGamemode) {
    const span = onlinePlayerSourceSpan(domainIntent);
    goals.push({
      key: "players.online",
      description: "读取当前在线玩家数量与名单",
      domain: "players",
      action: "read",
      target: "online",
      tool: "console.command",
      args: { command: "list" },
      order: span.index,
    });
  }
  if (conditionalGamemode) {
    const args = { schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] };
    goals.push({ key: "players.first-online-gamemode", description: "有在线玩家时读取首位玩家的当前游戏模式", domain: "players", action: "read", target: "conditional-first-online", tool: "players.inspect", args, order: conditionalGamemode.sourceIndex + 1 });
  }

  const capacityRead = (isOnlinePlayerReadIntent(domainIntent) || onlineCapacityRequested) && /(?:最大|最多|上限|容量|maximum|max(?:imum)?|capacity|limit)/i.test(domainIntent);
  if (capacityRead) {
    goals.push({
      key: "config.value:server.properties:max-players", description: "读取最大玩家容量", domain: "config", action: "read",
      target: "server.properties#max-players", tool: "config.inspect", args: { path: "server.properties", keys: ["max-players"] },
      order: Math.max(0, domainIntent.search(/(?:最大|最多|上限|容量|maximum|max(?:imum)?|capacity|limit)/i)),
    });
  }

  if (whitelistRead) {
    goals.push({
      key: "access.whitelist-observation",
      description: "读取当前白名单成员与人数",
      domain: "access",
      action: "read",
      target: "whitelist",
      tool: "console.command",
      args: { command: "whitelist list" },
      order: whitelistRead.sourceIndex,
    });
  }
  if (runtimeConsoleRead) {
    const definition = runtimeConsoleGoalDefinition(runtimeConsoleRead.kind);
    goals.push({
      key: definition.key,
      description: definition.description,
      domain: "world",
      action: "read",
      target: definition.target,
      tool: "console.command",
      args: { command: runtimeConsoleRead.command },
      order: runtimeConsoleRead.sourceIndex,
    });
  }

  add({ key: "server.version", description: "确认服务端实现与 Minecraft 版本", domain: "server", action: "read", target: "version", tool: "console.command", args: { command: "version" } }, /(?:服务端|服务器|实例|游戏服|运行环境|minecraft|mc).{0,32}(?:实现|类型|内核|发行版|平台|构建(?:号|版本)?|版本)|\b(?:server|minecraft|runtime)\s+(?:implementation|platform|distribution|kernel|build|version|release)\b|\b(?:implementation|platform|distribution|kernel|build)\b.{0,24}\b(?:server|minecraft|runtime|version|release)\b|^\s*version\s*$/i);
  add({ key: "performance.tps", description: "读取服务器 TPS", domain: "performance", action: "read", target: "tps", tool: "console.command", args: { command: "tps" } }, /\btps\b|\bticks?\s+per\s+second\b|\btick\s*(?:rate\b|速率|速度)|(?:每秒|一秒)[^，,。;；\r\n]{0,6}\bticks?\b/i);
  add({ key: "performance.mspt", description: "读取服务器 MSPT", domain: "performance", action: "read", target: "mspt", tool: "console.command", args: { command: "mspt" } }, /\bmspt\b|\bmilliseconds?\s+per\s+tick\b/i);
  add({ key: "plugins.loaded", description: "列出当前已加载插件", domain: "plugin", action: "read", target: "loaded", tool: "console.command", args: { command: "plugins" } }, /(?:已加载|当前|服务器).{0,8}(?:插件列表|有哪些插件|插件)|(?:列出|查看|查询).{0,8}(?:已加载)?插件|\b(?:loaded|installed)\s+plugins?\b|\bplugin\s+list\b/i);
  add({ key: "plugins.files", description: "读取插件目录实际文件", domain: "plugin", action: "read", target: "/plugins", tool: "files.list", args: { path: "/plugins" } }, /(?:\/plugins\b|plugins[\\/]|plugins?\s*(?:目录|文件夹|files?|folder|directory)|插件\s*(?:目录|文件夹|jar|文件))/i);
  if (logQuery) {
    const order = intent.search(logSubjectPattern);
    goals.push({ key: "logs.recent", description: "读取近期事件并给出异常证据", domain: "diagnosis", action: "diagnose", target: "recent-logs", tool: "logs.query", args: { ...logQuery }, order: order >= 0 ? order : 0 });
  }

  if (context.pluginProject && pluginMetadataSignal.test(domainIntent)) {
    const args = {
      project: context.pluginProject,
      source: "modrinth",
      platform: context.platform ?? "unknown",
      minecraft_version: context.minecraftVersion ?? "unknown",
      loader: context.loader ?? context.platform ?? "unknown",
    };
    const first = domainIntent.toLowerCase().indexOf(context.pluginProject.toLowerCase());
    goals.push({
      key: `plugin.resolve:${context.pluginProject}`,
      description: `解析 ${context.pluginProject} 的兼容制品、来源与校验信息`,
      domain: "plugin",
      action: "read",
      target: context.pluginProject,
      tool: "plugin.resolve",
      args,
      order: first >= 0 ? first : 0,
    });
  }
  // A basename that looks like a diagnostic term is still a filesystem target.
  // Runtime-log requests are reintroduced from their typed SourceGoal below,
  // so this suppression does not hide a separate diagnostic clause.
  return goals
    .filter((goal) => goal.key !== "logs.recent" || !extractFilesystemPath(domainIntent))
    .sort((left, right) => left.order - right.order);
}

function runtimeConsoleGoalDefinition(kind: RuntimeConsoleReadKind) {
  if (kind === "seed") return { key: "world.seed", target: "world.seed", description: "读取当前世界种子" };
  if (kind === "difficulty") return { key: "world.difficulty", target: "world.difficulty", description: "读取当前游戏难度" };
  if (kind === "daytime") return { key: "world.daytime", target: "world.daytime", description: "读取当前世界时间刻数" };
  if (kind === "gametime") return { key: "world.gametime", target: "world.gametime", description: "读取当前世界累计游戏刻数" };
  if (kind === "worldborder") return { key: "world.border-diameter", target: "world.border-diameter", description: "读取当前世界边界直径" };
  if (kind === "datapacks-enabled") return { key: "world.datapacks-enabled", target: "world.datapacks-enabled", description: "读取当前已启用数据包" };
  if (kind === "datapacks-available") return { key: "world.datapacks-available", target: "world.datapacks-available", description: "读取当前可用但未启用的数据包" };
  if (kind === "banned-players") return { key: "world.banned-players", target: "world.banned-players", description: "读取当前封禁玩家名单" };
  if (kind === "teams") return { key: "world.teams", target: "world.teams", description: "读取当前计分板队伍" };
  if (kind === "scoreboard-objectives") return { key: "world.scoreboard-objectives", target: "world.scoreboard-objectives", description: "读取当前计分板目标" };
  return { key: "world.forceload", target: "world.forceload", description: "读取当前强制加载区块" };
}

export function requestedGoalSteps(goals: RequestedGoal[]): TaskStep[] {
  const unique = new Map<string, RequestedGoal>();
  for (const goal of goals) {
    const key = `${goal.tool}:${JSON.stringify(goal.args)}`;
    if (!unique.has(key)) unique.set(key, goal);
  }
  return [...unique.values()].map((goal, index) => ({ id: `s${index + 1}`, tool: goal.tool, args: goal.args, risk: "read" }));
}

export function requestsForSourceGoals(sourceGoals: SourceGoal[], existing: RequestedGoal[]) {
  const requests = [...existing];
  const add = (source: SourceGoal, request: Omit<RequestedGoal, "order">) => {
    if (!requests.some((item) => item.key === request.key)) requests.push({ ...request, order: source.source_start });
  };
  for (const source of sourceGoals) {
    if (source.domain === "filesystem" && !requests.some((request) => request.tool === "files.list" && request.target === source.entity)) {
      requests.push({
        key: `filesystem.read:${source.entity}`,
        description: `Read filesystem entries under ${source.entity}`,
        domain: "filesystem",
        action: "read",
        target: source.entity,
        tool: "files.list",
        args: { path: source.entity },
        order: source.source_start,
      });
    }
    if (source.domain === "config" && source.normalized.startsWith("config.value:")) {
      const separator = source.entity.lastIndexOf("#");
      const path = separator > 0 ? source.entity.slice(0, separator) : "";
      const key = separator > 0 ? source.entity.slice(separator + 1) : "";
      const siblings = sourceGoals.filter((candidate) => candidate.domain === "config" && candidate.entity.startsWith(`${path}#`));
      const keys = siblings.map((candidate) => candidate.entity.slice(candidate.entity.lastIndexOf("#") + 1));
      add(source, {
        key: source.normalized,
        description: `Read ${key} from ${path}`,
        domain: "config",
        action: "read",
        target: source.entity,
        tool: "config.inspect",
        args: { path, keys },
      });
    }
    if (source.normalized === "server.version") add(source, { key: "server.version", description: "确认服务端类型与版本", domain: "server", action: "read", target: "version", tool: "console.command", args: { command: "version" } });
    if (source.normalized === "players.online") add(source, { key: "players.online", description: "读取当前在线成员", domain: "players", action: "read", target: "online", tool: "console.command", args: { command: "list" } });
    if (source.normalized === "players.first-online-gamemode") {
      add(source, {
        key: source.normalized,
        description: source.normalized.endsWith("gamemode") ? "有在线玩家时读取首位玩家游戏模式" : "读取在线人数并决定条件分支",
        domain: "players", action: "read", target: "conditional-first-online", tool: "players.inspect",
        args: { schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] },
      });
    }
    if ((source.normalized === "access.whitelist-roster" || source.normalized === "access.whitelist-count")
      && !requests.some((request) => request.tool === "console.command" && String(request.args.command).toLowerCase() === "whitelist list")) {
      add(source, { key: "access.whitelist-observation", description: "读取当前白名单成员与人数", domain: "access", action: "read", target: "whitelist", tool: "console.command", args: { command: "whitelist list" } });
    }
    if (source.normalized === "performance.tps") add(source, { key: "performance.tps", description: "读取 TPS", domain: "performance", action: "read", target: "tps", tool: "console.command", args: { command: "tps" } });
    if (source.normalized === "performance.mspt") add(source, { key: "performance.mspt", description: "读取 MSPT", domain: "performance", action: "read", target: "mspt", tool: "console.command", args: { command: "mspt" } });
    if (source.normalized === "performance.uptime" || source.normalized === "performance.cpu" || source.normalized === "performance.memory" || source.normalized === "performance.pressure") {
      const requestedMetrics = new Set(sourceGoals.filter((candidate) => ["performance.uptime", "performance.cpu", "performance.memory"].includes(candidate.normalized)).map((candidate) => candidate.entity));
      const metrics = ["uptime", "cpu", "memory"].filter((metric) => requestedMetrics.has(metric));
      const args = { schema_version: "instance-metrics/v2", metrics, include_capacity: sourceGoals.some((candidate) => candidate.normalized === "performance.pressure") };
      const description = source.normalized === "performance.uptime" ? "读取实例进程运行时长"
        : source.normalized === "performance.cpu" ? "读取实例 CPU 占用"
        : source.normalized === "performance.memory" ? "读取实例内存占用" : "根据真实 CPU 与内存判断资源压力";
      add(source, { key: source.normalized, description, domain: "performance", action: "read", target: source.entity, tool: "instance.metrics", args });
    }
    if (source.normalized === "plugins.loaded") add(source, { key: "plugins.loaded", description: "读取已加载插件", domain: "plugin", action: "read", target: "loaded", tool: "console.command", args: { command: "plugins" } });
    if (source.normalized === "plugins.files" || source.normalized === "plugins.jar-count") add(source, { key: "plugins.files", description: "读取插件目录", domain: "plugin", action: "read", target: "/plugins", tool: "files.list", args: { path: "/plugins" } });
    if (source.normalized === "logs.events" || source.normalized === "logs.event-count") add(source, { key: "logs.recent", description: "读取近期异常日志", domain: "diagnosis", action: "diagnose", target: "recent-logs", tool: "logs.query", args: { window_minutes: 60, max_lines: 500 } });
  }
  return requests.sort((left, right) => left.order - right.order);
}

export function buildGoalRequirements(
  intent: string,
  steps: TaskStep[],
  operation: OperationObjective,
  requested: RequestedGoal[] = [],
  sourceGoals: SourceGoal[] = extractSourceGoals(intent),
): { goals: GoalRequirement[]; coverage: "full" | "partial" | "waiting" } {
  const goals: GoalRequirement[] = [];
  const matchedSteps = new Set<string>();
  const sourceMapped = new Set<string>();
  for (const source of sourceGoals) {
    const goal = requestedForSource(source, requested) ?? (source.normalized === "operation.intent" ? requestedFromStep(steps.find((step) => step.purpose !== "verify"), source) : undefined);
    if (!goal || source.status === "unmapped") {
      goals.push({
        id: `g-${safeId(source.id)}`, description: source.source_text, domain: source.domain,
        action: "read", target: source.entity, required: true, source_goal_ids: [source.id],
        result_kind: source.result_kind, ...(source.filter ? { filter: source.filter } : {}),
        ...(source.predicate ? { predicate: source.predicate } : {}),
        execute_step_ids: [], verify_step_ids: [], evidence: [], status: "unsupported",
      });
      continue;
    }
    const dependencyStepIds = source.depends_on.length
      ? source.depends_on.flatMap((sourceId) => {
        const dependency = sourceGoals.find((candidate) => candidate.id === sourceId);
        const dependencyGoal = dependency && requestedForSource(dependency, requested);
        const dependencyStep = dependencyGoal && steps.find((candidate) => stepMatchesGoal(candidate, dependencyGoal));
        return dependencyStep ? [dependencyStep.id] : [];
      })
      : [];
    const step = source.depends_on.length
      ? steps.find((candidate) => dependencyStepIds.includes(candidate.id))
      : steps.find((candidate) => stepMatchesGoal(candidate, goal));
    if (step) matchedSteps.add(step.id);
    sourceMapped.add(source.id);
    const requirement = requirementFor(goal, step, steps, operation, source);
    if (!source.required) {
      const supported = sourceGoals.filter((candidate) => candidate.required && candidate.depends_on.includes(source.id));
      requirement.required = false;
      requirement.supporting = true;
      requirement.supports_source_goal_ids = supported.map((candidate) => candidate.id);
      requirement.support_reason = supported.some((candidate) => candidate.result_kind === "filtered_count")
        ? "collection_required_for_filtered_count"
        : supported.some((candidate) => candidate.result_kind === "count")
          ? "collection_required_for_count"
          : "dependency_required_for_judgement";
    }
    if (
      source.result_kind === "judgement" ||
      (source.normalized === "players.occupancy-ratio" && source.depends_on.length > 0)
    ) {
      requirement.execute_step_ids = [...new Set(dependencyStepIds)];
      requirement.verify_step_ids = [];
      requirement.status = dependencyStepIds.length ? "pending" : "unsupported";
    }
    goals.push(requirement);
  }
  for (const goal of requested.filter((candidate) => !sourceGoals.some((source) => requestedForSource(source, [candidate])))) {
    const step = steps.find((candidate) => stepMatchesGoal(candidate, goal));
    if (step && matchedSteps.has(step.id)) continue;
    const supported = sourceGoals.filter((source) => source.required && source.domain === goal.domain && source.entity === goal.target);
    if (!supported.length) continue;
    if (step) matchedSteps.add(step.id);
    const requirement = requirementFor(goal, step, steps, operation);
    requirement.required = false;
    requirement.supporting = true;
    requirement.supports_source_goal_ids = supported.map((source) => source.id);
    requirement.support_reason = "dependency_required_for_judgement";
    goals.push(requirement);
  }
  for (const step of steps.filter((candidate) => candidate.purpose !== "verify" && !matchedSteps.has(candidate.id))) {
    const target = stepTarget(step);
    const operationSource = sourceGoals.find((source) => source.required && source.normalized === "operation.intent" && source.entity === target);
    const operationGoal = operationSource && goals.find((goal) => goal.source_goal_ids.includes(operationSource.id));
    if (operationGoal) {
      const verification = relatedVerificationSteps(step, steps);
      operationGoal.action = operation.action;
      operationGoal.execute_step_ids = [...new Set([...operationGoal.execute_step_ids, step.id])];
      operationGoal.verify_step_ids = [...new Set([...operationGoal.verify_step_ids, ...verification.map((candidate) => candidate.id)])];
      const allowed = new Set([...operationGoal.execute_step_ids, ...operationGoal.verify_step_ids, "terminal", "acceptance"]);
      operationGoal.evidence = [...operation.execution_evidence, ...operation.verification_evidence].filter((item) => allowed.has(item.step_id ?? ""));
      operationGoal.status = "pending";
      matchedSteps.add(step.id);
      continue;
    }
    const supported = sourceGoals.filter((source) => source.required && source.entity === target);
    if (!supported.length) continue;
    const policyAction = operationActionForStep(step);
    const requirement = requirementFor({
      key: `${step.tool}:${target}`,
      description: describeStep(step),
      domain: step.tool.split(".", 1)[0] ?? "operation",
      action: policyAction,
      target,
      tool: step.tool,
      args: step.args,
      order: steps.indexOf(step),
    }, step, steps, operation);
    requirement.required = false;
    requirement.supporting = true;
    requirement.supports_source_goal_ids = supported.map((source) => source.id);
    requirement.support_reason = "dependency_required_for_judgement";
    goals.push(requirement);
  }

  const unknowns = sourceGoals.length ? [] : unsupportedOperationalClauses(intent, requested, steps);
  for (const [index, clause] of unknowns.entries()) {
    goals.push({
      id: `g-unsupported-${index + 1}`,
      description: clause,
      domain: "unknown",
      action: /(?:查看|读取|查询|检查|read|show|check|inspect)/i.test(clause) ? "read" : "write",
      target: "unresolved",
      required: true,
      source_goal_ids: [],
      result_kind: "fact",
      execute_step_ids: [],
      verify_step_ids: [],
      evidence: [],
      status: "unsupported",
    });
  }
  const unique = uniqueGoals(goals);
  const goalBySource = new Map(unique.flatMap((goal) => goal.source_goal_ids.map((sourceId) => [sourceId, goal.id] as const)));
  for (const goal of unique) {
    const source = sourceGoals.find((candidate) => goal.source_goal_ids.includes(candidate.id));
    if (source?.depends_on.length) goal.depends_on_goal_ids = source.depends_on.map((sourceId) => goalBySource.get(sourceId)).filter((id): id is string => Boolean(id));
  }
  if (unique.length === 0) return { goals: [], coverage: "waiting" };
  const requiredSources = sourceGoals.filter((goal) => goal.required);
  const mappedSources = new Set(unique.filter((goal) => goal.execute_step_ids.length > 0).flatMap((goal) => goal.source_goal_ids));
  const covered = requiredSources.length
    ? requiredSources.filter((source) => mappedSources.has(source.id)).length
    : unique.filter((goal) => goal.execute_step_ids.length > 0).length;
  const total = requiredSources.length || unique.length;
  return { goals: unique, coverage: covered === total ? "full" : covered > 0 ? "partial" : "waiting" };
}

export function constraintViolations(steps: TaskStep[], constraints: PlanConstraint[]) {
  const forbidden = new Set(constraints.map((constraint) => constraint.action));
  return steps.filter((step) => {
    const actions = actionsForStep(step);
    return actions.some((action) => forbidden.has(action));
  });
}

function requirementFor(goal: RequestedGoal, step: TaskStep | undefined, steps: TaskStep[], operation: OperationObjective, source?: SourceGoal): GoalRequirement {
  const executeIds = step ? [step.id] : [];
  const verify = step ? relatedVerificationSteps(step, steps) : [];
  const evidence = [...operation.execution_evidence, ...operation.verification_evidence].filter((item) =>
    item.step_id === "terminal" || item.step_id === "acceptance" || executeIds.includes(item.step_id ?? "") || verify.some((candidate) => candidate.id === item.step_id));
  return {
    id: source ? `g-${safeId(source.id)}` : `g-${safeId(goal.key)}`,
    description: source?.result_kind === "judgement" ? `综合判断：${source.source_text}` : goal.description,
    domain: goal.domain,
    action: source?.normalized === "operation.intent" ? operation.action : goal.action,
    target: goal.target,
    required: true,
    source_goal_ids: source ? [source.id] : [],
    result_kind: source?.result_kind ?? "fact",
    ...(source?.filter ? { filter: source.filter } : {}),
    ...(source?.predicate ? { predicate: remapPredicate(source.predicate) } : {}),
    ...(source?.depends_on.length ? { depends_on_goal_ids: source.depends_on.map((id) => `g-${safeId(id)}`) } : {}),
    execute_step_ids: executeIds,
    verify_step_ids: verify.map((candidate) => candidate.id),
    evidence,
    status: step ? "pending" : "unsupported",
  };
}

function remapPredicate(predicate: NonNullable<SourceGoal["predicate"]>): NonNullable<GoalRequirement["predicate"]> {
  const remapOperand = (operand: NonNullable<SourceGoal["predicate"]>["operands"][number]) => ({
    ...operand,
    ...(operand.goal_id ? { goal_id: `g-${safeId(operand.goal_id)}` } : {}),
    ...(operand.predicate ? { predicate: remapPredicate(operand.predicate) } : {}),
  });
  return { ...predicate, operands: predicate.operands.map(remapOperand), ...(predicate.left ? { left: remapOperand(predicate.left) } : {}), ...(predicate.right ? { right: remapOperand(predicate.right) } : {}) };
}

function requestedForSource(source: SourceGoal, requested: RequestedGoal[]) {
  if (source.domain === "world" && source.normalized.startsWith("world.")) {
    const command = source.normalized.startsWith("world.difficulty") ? "difficulty"
      : source.normalized.startsWith("world.day") ? "time query daytime"
        : source.normalized.startsWith("world.gametime") ? "time query gametime"
        : source.normalized.startsWith("world.datapacks-enabled") ? "datapack list enabled"
          : source.normalized.startsWith("world.datapacks-available") ? "datapack list available"
            : source.normalized.startsWith("world.banned-players") ? "banlist players"
              : source.normalized.startsWith("world.teams") ? "team list"
                : source.normalized.startsWith("world.scoreboard-objectives") ? "scoreboard objectives list"
                  : source.normalized.startsWith("world.forceload") ? "forceload query"
          : source.normalized === "world.seed" ? "seed"
            : source.normalized === "world.border-diameter" ? "worldborder get" : undefined;
    const request = command && requested.find((goal) => goal.tool === "console.command" && String(goal.args.command).toLowerCase() === command);
      return request ? { ...request, key: source.normalized, domain: source.domain, target: source.entity } : undefined;
  }
  if (source.domain === "filesystem") {
    const request = requested.find((goal) => goal.tool === "files.list" && goal.target === source.entity);
    return request ? { ...request, key: source.normalized, domain: source.domain, target: source.entity } : undefined;
  }
  if (source.domain === "config") {
    const request = requested.find((goal) => goal.tool === "config.inspect" && goal.target === source.entity);
    return request ? { ...request, key: source.normalized, domain: source.domain, target: source.entity } : undefined;
  }
  if (source.domain === "plugin" && source.normalized.startsWith("plugin.resolve:")) {
    return requested.find((goal) => goal.tool === "plugin.resolve" && goal.target.toLowerCase() === source.entity.toLowerCase());
  }
  if (source.domain === "access" && source.entity === "whitelist") {
    const request = requested.find((goal) => goal.tool === "console.command" && String(goal.args.command).toLowerCase() === "whitelist list");
    return request ? { ...request, key: source.normalized, domain: source.domain, target: source.entity } : undefined;
  }
  if (source.normalized === "players.online-count" || source.normalized === "players.occupancy-ratio") {
    const request = requested.find((goal) => goal.tool === "console.command" && String(goal.args.command).toLowerCase() === "list");
    return request ? { ...request, key: source.normalized, domain: source.domain, target: source.entity } : undefined;
  }
  const key = source.normalized === "plugins.jar-count" ? "plugins.files"
    : source.normalized === "logs.events" || source.normalized === "logs.event-count" ? "logs.recent"
      : source.normalized === "derived.judgement" ? undefined : source.normalized;
  if (source.result_kind === "judgement") {
    const request = requested.find((goal) => goal.target === source.entity && (goal.domain === source.domain || goal.tool === "files.list"));
    return request ? { ...request, domain: source.domain, target: source.entity } : undefined;
  }
  return requested.find((goal) => goal.key === key);
}

function requestedFromStep(step: TaskStep | undefined, source: SourceGoal): RequestedGoal | undefined {
  if (!step) return undefined;
  return {
    key: source.normalized,
    description: source.source_text,
    domain: source.domain,
    action: operationActionForStep(step),
    target: stepTarget(step),
    tool: step.tool,
    args: step.args,
    order: source.source_start,
  };
}

function relatedVerificationSteps(execute: TaskStep, steps: TaskStep[]) {
  const index = steps.indexOf(execute);
  const result: TaskStep[] = [];
  for (let cursor = index + 1; cursor < steps.length; cursor++) {
    if (steps[cursor].purpose !== "verify") break;
    result.push(steps[cursor]);
  }
  return result;
}

function stepMatchesGoal(step: TaskStep, goal: RequestedGoal) {
  if (step.purpose === "verify" || step.tool !== goal.tool) return false;
  if (goal.tool === "console.command") return String(step.args.command ?? "").toLowerCase() === String(goal.args.command ?? "").toLowerCase();
  if (goal.tool === "files.list") return String(step.args.path ?? "") === String(goal.args.path ?? "");
  if (goal.tool === "config.inspect") return String(step.args.path ?? "") === String(goal.args.path ?? "");
  if (goal.tool === "plugin.resolve") return String(step.args.project ?? "").toLowerCase() === String(goal.args.project ?? "").toLowerCase();
  if (goal.tool === "instance.metrics") {
    const metrics = Array.isArray(step.args.metrics) ? step.args.metrics.map(String) : [];
    return goal.target === "resource-pressure" ? metrics.includes("cpu") && metrics.includes("memory") && step.args.include_capacity === true
      : metrics.includes(goal.target);
  }
  return true;
}

function actionsForStep(step: TaskStep): PlanConstraint["action"][] {
  if (step.tool === "server.install" || step.tool === "plugin.install") return ["download", "install", "write"];
  if (step.tool === "instance.restart") return ["restart", "stop", "start", "write"];
  if (step.tool === "instance.start") return ["start", "write"];
  if (step.tool === "instance.stop") return ["stop", "write"];
  if (step.tool === "config.patch" || step.tool === "console.command" && !isReadConsole(String(step.args.command ?? ""))) return ["write"];
  return [];
}

function constraintScopes(intent: string) {
  return intent.split(/[；;。！？\r\n]+/).map((item) => item.trim()).filter(Boolean);
}

function unsupportedOperationalClauses(intent: string, requested: RequestedGoal[], steps: TaskStep[]) {
  if (!steps.length && /(?:修复|处理|操作|执行|修改|安装|部署|启动|停止|重启|fix|operate|execute|modify|install|deploy|start|stop|restart)/i.test(intent)) return [intent.trim()];
  if (steps.length > 0) return [];
  const knownText = requested.map((goal) => `${goal.description} ${goal.target}`).join(" ").toLowerCase();
  return intent.split(/[；;。！？\r\n]+|(?:然后|随后|最后|and\s+then|then)/i)
    .map((item) => item.trim())
    .filter((clause) => clause.length > 2 && !negation.test(clause))
    .filter((clause) => /(?:查看|读取|查询|列出|检查|分析|确认|修复|修改|安装|部署|启动|停止|重启|read|show|query|list|check|analy[sz]e|confirm|fix|modify|install|deploy|start|stop|restart)/i.test(clause))
    .filter((clause) => {
      const lower = clause.toLowerCase();
      if (requested.some((goal) => lower.includes(goal.target.toLowerCase()) || knownText.includes(lower))) return false;
      return !steps.some((step) => lower.includes(stepTarget(step).toLowerCase()));
    });
}

function operationActionForStep(step: TaskStep): OperationObjective["action"] {
  if (step.tool.includes("install")) return "install";
  if (step.tool.startsWith("instance.")) return "lifecycle";
  if (step.tool === "logs.query") return "diagnose";
  return actionsForStep(step).length ? "write" : "read";
}

function describeStep(step: TaskStep) {
  const target = stepTarget(step);
  return `${step.tool}：${target}`;
}

function stepTarget(step: TaskStep) {
  for (const key of ["path", "project", "command", "platform", "target"]) {
    const value = step.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return step.tool;
}

function isReadConsole(command: string) {
  const normalized = command.trim().replace(/^minecraft:/i, "").toLowerCase();
  const verb = normalized.split(/\s+/, 1)[0] ?? "";
  return ["list", "help", "version", "plugins", "pl", "tps", "mspt", "seed"].includes(verb)
    || normalized === "difficulty" || normalized === "whitelist list" || /^time\s+query\b/.test(normalized)
    || normalized === "worldborder get" || /^datapack\s+list\s+(?:enabled|available)$/.test(normalized)
    || normalized === "banlist players" || normalized === "team list" || normalized === "scoreboard objectives list" || normalized === "forceload query"
    || /^gamerule\s+\w+$/.test(normalized) || /^data\s+get\b/.test(normalized);
}

function safeId(value: string) { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "goal"; }

function codeUnitOffset(value: string, runeOffset: number) { return [...value].slice(0, runeOffset).join("").length; }

function clauseForSpan(ledger: ClauseRoleEntry[], start: number, end: number) {
  return ledger.find((entry) => entry.source_start <= start && entry.source_end >= end);
}

function uniqueGoals(goals: GoalRequirement[]) {
  const result = new Map<string, GoalRequirement>();
  for (const goal of goals) {
    const semanticPluginFact = goal.domain === "plugin" && goal.action === "read" && goal.result_kind === "fact"
      && goal.execute_step_ids.length > 0;
    const key = semanticPluginFact
      ? `plugin.resolve:${goal.target.toLowerCase()}:${goal.execute_step_ids.join(",")}`
      : goal.source_goal_ids.length ? goal.source_goal_ids.join(",") : `${goal.domain}:${goal.action}:${goal.target}:${goal.execute_step_ids.join(",")}`;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, goal);
      continue;
    }
    if (semanticPluginFact) {
      existing.source_goal_ids = [...new Set([...existing.source_goal_ids, ...goal.source_goal_ids])];
      existing.verify_step_ids = [...new Set([...existing.verify_step_ids, ...goal.verify_step_ids])];
      existing.evidence = [...new Map([...existing.evidence, ...goal.evidence].map((item) => [JSON.stringify(item), item])).values()];
      existing.required = existing.required || goal.required;
    }
  }
  return [...result.values()];
}
