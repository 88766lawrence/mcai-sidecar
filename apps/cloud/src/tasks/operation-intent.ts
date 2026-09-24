import { createHash } from "node:crypto";
import type {
  AcceptanceRule,
  OperationEvidenceRequirement,
  OperationObjective,
  RiskLevel,
  TaskStep,
} from "@mcai/contracts";
import { aggregateOperationAction, highestRisk, intrinsicToolPolicy } from "@mcai/contracts";
import { extractRuntimeConsoleRead } from "./runtime-console-read";

const mutationVerbs = [
  /(?:帮我|请|给我|替我|自己)?\s*(?:安装|下载|部署|更新|升级|修改|更改|设置|设为|调整|开启|关闭|启动|停止|重启|删除|移除|添加|执行|运行|发送|广播|公告|修复|配置|换成|改成|调成|切成)/i,
  /\b(?:install|download|deploy|update|upgrade|modify|change|set|enable|disable|start|stop|restart|delete|remove|add|execute|run|announce|broadcast|say|fix|configure|turn|make)\b/i,
];

const knowledgeSignals = /(?:怎么做|如何做|教程|原理|区别|是什么|意味着什么|什么意思|请说明|解释|一般|示例|是否会|会不会|what\s+is|what\s+does|how\s+(?:do|does|to)|difference\s+between|what\s+does\b.+\bmean|^\s*if\b)/i;
const observationReportSignals = /(?:哪些|多少|几个|几项|名称|名单|数量|总数|版本|状态|告诉我|给出|返回|汇总|列出|查看|查询|读取|核对|检查|\b(?:which|what|how\s+many|names?|list|count|total|status|version|tell|show|report|return|summari[sz]e|read|query|inspect|check)\b)/i;
const negationSignals = /(?:不要|不用|不得|禁止|无需|不必|别|不可|避免|do\s+not|don't|without|never)/i;
const operationalTargets = /(?:服务器|服务端|实例|控制台|插件|模组|配置|文件|日志|白名单|难度|天气|时间|游戏模式|规则|玩家|存档|备份|诊断包|资源|数据包|世界|内存|性能|paper|fabric|forge|spigot|server|instance|console|plugin|mod|config|file|logs?|whitelist|difficulty|weather|gamemode|gamerule|backup|archive|snapshot|datapack|world|resource|memory|ram|performance|tps|mspt)/i;
const descriptivePrefix = /^\s*(?:the|this|that|my|our|your|yesterday|today|currently|previously|日志|log|output|error)\b\s*[:：]?/i;
const englishImperativePrefix = /^\s*(?:please\s+)?(?!the\b|this\b|that\b|my\b|our\b|your\b|it\b|if\b|when\b|why\b|what\b|how\b|yesterday\b|today\b)[a-z][a-z-]*\b/i;
const chineseImperativeFrame = /^\s*(?:请|帮我|麻烦|替我|给我|立即|现在|把|将|对)/;

export type OperationalLanguage = "none" | "read" | "write";

const runtimeVersionContext = /(?:当前|现在|正在|实际|精确|实时|本实例|该实例|这台|眼前|运行(?:中|环境)|跑的|\b(?:current(?:ly)?|actual|exact|precise|live|running|runtime|active|this|bound)\b)/i;
const runtimeVersionSubject = /(?:服务端|服务器|实例|(?:游戏)?服|节点|运行环境|minecraft|mc|\b(?:server|instance|host|node|runtime|backend)\b)/i;
const runtimeVersionFact = /(?:实现|类型|内核|发行版|平台|构建(?:号|版本)?|版本|\b(?:implementation|platform|distribution|kernel|build|version|release)\b)/i;
const runtimeVersionReadAction = /(?:报(?:告|下)?|给出|告诉|查看|查询|读取|确认|核对|识别|检测|查(?:明|清)|采用什么|哪(?:个|种)?|什么|\b(?:report|tell|show|read|check|confirm|identify|detect|which|what)\b)/i;
const runtimeVersionKnowledgeOnly = /(?:区别|原理|解释|含义|如何命名|一般|\b(?:difference|explain|meaning|mean|naming|generally)\b)/i;

/**
 * Identifies a request for the bound instance's live runtime identity.
 * Static product knowledge is intentionally excluded: this route exists only
 * for facts that must be observed from the running server.
 */
export function isRuntimeVersionReadIntent(intent: string): boolean {
  const value = intent.trim();
  if (!value || runtimeVersionKnowledgeOnly.test(value)) return false;
  return runtimeVersionContext.test(value)
    && runtimeVersionSubject.test(value)
    && runtimeVersionFact.test(value)
    && runtimeVersionReadAction.test(value);
}

export type InstanceLifecycleIntent = {
  action: "start" | "stop" | "restart";
  tool: "instance.start" | "instance.stop" | "instance.restart";
};

export type LifecycleOccurrenceRole = "current_state" | "desired_state" | "action" | "constraint";
export type LifecycleOccurrencePolarity = "positive" | "negative";

export type InstanceLifecycleOccurrence = InstanceLifecycleIntent & {
  index: number;
  end: number;
  text: string;
  clause: string;
  clause_index: number;
  role: LifecycleOccurrenceRole;
  polarity: LifecycleOccurrencePolarity;
};

export type InstanceLifecycleAnalysis = {
  occurrences: InstanceLifecycleOccurrence[];
  positive_actions: InstanceLifecycleIntent["action"][];
  ambiguous: boolean;
};

const lifecycleDomain = /(?:服务器|服务端|实例|游戏节点|节点|(?:游戏|联机|测试|生存|模组|专用)?服(?:务器)?|server|instance|game\s+(?:service|host)|service|node|host)/i;
const lifecycleReferent = /(?:这台|那台|当前|眼前|该(?:台)?|本(?:台|机)?|它|此实例|\b(?:bound|current|this|that|it)\b)/i;
const onlinePresence = /(?:在线|在服|(?:已)?连接(?:中|着)?|联机中)|\b(?:online|connected|logged\s+in)\b/i;
const playerEntity = /(?:玩家|成员|用户|名单|人数|几个人|多少人|几位|谁)|\b(?:players?|members?|users?|roster|people|who)\b/i;
const playerReadAction = /(?:查看|看(?:一眼|一下)?|瞅|查询|查一下|列(?:出)?|显示|统计|数(?:一)?下|算(?:一)?下|给出|报告|告诉我|有几|多少|几人|几位|谁|名单|人数)|\b(?:show|list|query|check|count|calculate|provide|give|report|read|how\s+many|who|roster)\b/i;
const lifecycleSignals: Array<InstanceLifecycleIntent & { default_role: LifecycleOccurrenceRole; pattern: RegExp }> = [
  { action: "restart", tool: "instance.restart", default_role: "action", pattern: /(?:重启|重开|重新启动)|\b(?:restart(?:ing)?|reboot(?:ing)?)\b/i },
  { action: "start", tool: "instance.start", default_role: "desired_state", pattern: /(?:(?:进入|变为|变成|转为|转成|恢复到|恢复为|切换到|切换为|改为|成为)[^，,；;。！？\r\n或和及]{0,12}(?:运行|在线)(?:中|状态)?|(?:送|让|使)[^，,；;。！？\r\n或和及]{0,10}(?:进入|变为|变成|转为|转成|切换到|切换为)[^，,；;。！？\r\n或和及]{0,8}(?:运行|在线)(?:中|状态)?)|\b(?:bring|put|move|transition)\b[^\r\n,;.!?]{0,80}\b(?:online|running|up)\b/i },
  { action: "stop", tool: "instance.stop", default_role: "desired_state", pattern: /(?:(?:进入|变为|变成|转为|转成|恢复到|恢复为|切换到|切换为|改为|成为)[^，,；;。！？\r\n或和及]{0,12}(?:离线|停止)(?:中|状态)?|(?:送|让|使)[^，,；;。！？\r\n或和及]{0,10}(?:进入|变为|变成|转为|转成|切换到|切换为)[^，,；;。！？\r\n或和及]{0,8}(?:离线|停止)(?:中|状态)?|送[^，,；;。！？\r\n或和及]{0,10}下线)|\b(?:bring|put|move|transition)\b[^\r\n,;.!?]{0,80}\b(?:offline|stopped|down)\b/i },
  { action: "start", tool: "instance.start", default_role: "action", pattern: /(?:启动|开机|开服|拉起|开起来|运行起来|开启|上线)|\b(?:start(?:ing)?|launch(?:ing)?|boot(?:ing)?)\b|\bpower\s+on\b/i },
  { action: "stop", tool: "instance.stop", default_role: "action", pattern: /(?:停止|关闭|关机|关服|停服|下线)|\b(?:stop(?:ping)?|shutdown)\b|\bpower\s+off\b|\bshut(?:ting)?(?:\s+\w+){0,2}\s+down\b/i },
  { action: "start", tool: "instance.start", default_role: "current_state", pattern: /(?:在线(?:中|状态)?|运行(?:中|状态))|\b(?:online|running|up)\b/i },
  { action: "stop", tool: "instance.stop", default_role: "current_state", pattern: /(?:离线(?:中|状态)?|停止状态|停着|未运行)|\b(?:offline|stopped|down)\b/i },
];

/** True when the request is about an instance lifecycle even if its action is ambiguous. */
export function hasInstanceLifecycleLanguage(intent: string): boolean {
  const value = intent.trim();
  if (!value || knowledgeSignals.test(value) || extractExplicitConsoleCommand(value)) return false;
  // Runtime identity uses words such as running/current as observation
  // context. It is never an instance start/stop transition.
  if (isRuntimeVersionReadIntent(value)) return false;
  // Player presence is an entity-scoped read domain, not an instance desired
  // state. Resolve it before interpreting words such as online as lifecycle.
  if (isOnlinePlayerReadIntent(value)) return false;
  if (!lifecycleDomain.test(value) && !lifecycleReferent.test(value)) return false;
  const analysis = analyzeInstanceLifecycleIntent(value);
  if (analysis.occurrences.length === 0) return false;
  if (analysis.positive_actions.length > 0) return true;
  // A lifecycle-only prohibition/current-state sentence still owns this
  // domain and must clarify instead of falling into the console envelope.
  // A side-effect constraint attached to another operation must not swallow
  // that unrelated operation (for example: whitelist update, never restart).
  return !/(?:查看|看看|查询|读取|列出|显示|报告|给出|检查|诊断|分析|确认|统计|计数|安装|下载|部署|配置|修改|添加|删除|白名单|插件|模组|配置|文件|日志|难度|天气|时间|游戏模式|规则|玩家|成员|存档|备份|\b(?:show|query|read|list|display|report|inspect|check|diagnose|analy[sz]e|count|install|download|configure|modify|add|remove)\b|whitelist|plugin|mod|config|file|logs?|difficulty|weather|gamemode|gamerule|backup)/i.test(value);
}

/** Resolves a bound instance lifecycle action before console-command parsing. */
export function resolveInstanceLifecycleIntent(intent: string): InstanceLifecycleIntent | undefined {
  const value = intent.trim();
  if (!hasInstanceLifecycleLanguage(value)) return undefined;
  const analysis = analyzeInstanceLifecycleIntent(value);
  if (analysis.positive_actions.length !== 1) return undefined;
  const action = analysis.positive_actions[0];
  return { action, tool: `instance.${action}` as InstanceLifecycleIntent["tool"] };
}

/** Auditable lifecycle occurrence model: role and polarity are resolved before action selection. */
export function analyzeInstanceLifecycleIntent(intent: string): InstanceLifecycleAnalysis {
  const occurrences = splitOperationalClauses(intent).flatMap((clause, clauseIndex) =>
    lifecycleOccurrences(clause).map((occurrence) => classifyLifecycleOccurrence(clause, clauseIndex, occurrence)),
  );
  const positiveActions = [...new Set(occurrences
    .filter((occurrence) => occurrence.polarity === "positive" && (occurrence.role === "action" || occurrence.role === "desired_state"))
    .map((occurrence) => occurrence.action))];
  return { occurrences, positive_actions: positiveActions, ambiguous: positiveActions.length > 1 };
}

const modeAliases: Record<string, string> = {
  和平: "peaceful", 简单: "easy", 普通: "normal", 困难: "hard",
  peaceful: "peaceful", easy: "easy", normal: "normal", hard: "hard",
  晴天: "clear", 晴朗: "clear", 下雨: "rain", 雨天: "rain", 雷雨: "thunder", 雷暴: "thunder",
  clear: "clear", rain: "rain", thunder: "thunder",
  白天: "day", 早上: "day", 中午: "noon", 晚上: "night", 午夜: "midnight",
  day: "day", noon: "noon", night: "night", midnight: "midnight",
  生存: "survival", 创造: "creative", 冒险: "adventure", 旁观: "spectator",
  survival: "survival", creative: "creative", adventure: "adventure", spectator: "spectator",
};

/** Resolves parameterized Minecraft console operations through one catalog. */
export function resolveConsoleOperation(intent: string): string | undefined {
  return resolveConsoleOperations(intent)[0];
}

/**
 * Resolves one bounded mutable console operation without delegating the
 * security decision to the language model. Arbitrary console text and read
 * commands are deliberately excluded; policy/risk/confirmation are still
 * derived later by the canonical confirmed-write validator.
 */
export function resolveBoundedConsoleWrite(intent: string): string | undefined {
  const operations = resolveConsoleOperations(intent);
  if (operations.length !== 1) return undefined;
  const command = operations[0].trim();
  // Start with the weather family whose parameter space is closed and whose
  // post-confirmation envelope is already registered. Additional families
  // may join only with equivalent cross-layer safety coverage.
  const allowed = [
    /^weather\s+(?:clear|rain|thunder)$/i,
    /^playsound\s+minecraft:block\.note_block\.bell\s+master\s+@a\s+~\s+~\s+~\s+1\s+1$/i,
    /^execute\s+if\s+entity\s+@a\s+run\s+execute\s+as\s+@a\s+at\s+@s\s+run\s+particle\s+minecraft:happy_villager\s+~\s+~1\s+~\s+0\.25\s+0\.25\s+0\.25\s+0\s+5\s+force\s+@s$/i,
  ];
  return allowed.some((pattern) => pattern.test(command)) ? command : undefined;
}

/** Resolves two bounded one-shot effects for the current online audience. */
export function extractTransientPlayerEffectCommand(intent: string): string | undefined {
  const value = intent.trim();
  if (!value || value.length > 1_000 || /[\r\n\0]/.test(value)) return undefined;
  const masked = maskQuotedText(value);
  const audience = /(?:所有|全部|全体|每个|每位|在线)(?:的)?(?:玩家|成员)|\b(?:all|every|each|online|connected)\b[^,;.!?]{0,32}\b(?:players?|members?)\b/i;
  if (!audience.test(masked)) return undefined;
  if (/(?:不要|禁止|别|不得|不可|do\s+not|don't|never)\s*(?:播放|显示|产生|生成|play|show|display|spawn)/i.test(masked)) return undefined;
  const bell = /(?:播放|响起|发出)[^，。；!?]{0,24}(?:钟声|铃声)|\b(?:play|ring|sound)\b[^,;.!?]{0,28}\b(?:bell|chime)\b/i.test(masked);
  const happy = /(?:五|5)\s*(?:颗|个)?[^，。；!?]{0,20}(?:快乐村民|开心村民|happy[_\s-]*villager)[^，。；!?]{0,20}(?:粒子|particle)|\b(?:show|spawn|display|place|emit)\b[^,;.!?]{0,32}\b(?:five|5)\b[^,;.!?]{0,20}\bhappy[_\s-]*villager\b[^,;.!?]{0,16}\bparticles?\b/i.test(masked);
  if (bell === happy) return undefined;
  if (bell) return "playsound minecraft:block.note_block.bell master @a ~ ~ ~ 1 1";
  // Guard the nested audience execution in the same command. Minecraft then
  // emits a deterministic failed-condition result when @a is empty instead of
  // silently producing no callback for an execute-as branch with zero rows.
  return "execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~ 0.25 0.25 0.25 0 5 force @s";
}

/**
 * Extracts a single player-facing actionbar write. The audience words
 * (including "online players") are part of the write target and must not be
 * reinterpreted as a roster observation. The message is encoded as a JSON
 * text component so quotes and backslashes cannot escape the command.
 */
export function extractActionbarConsoleCommand(intent: string): string | undefined {
  const value = intent.trim();
  if (!value || value.length > 1_000 || /[\r\n\0]/.test(value)) return undefined;
  const masked = maskQuotedText(value);
  const surface = /(?:快捷栏|动作栏|操作栏)|\b(?:action\s*bar|hotbar)\b/i.exec(masked);
  if (!surface || surface.index === undefined) return undefined;

  const actionPattern = /(?:显示|展示|提示|发送|推送|告知)|\b(?:show|display|send|put|post)\b/i;
  const audiencePattern = /(?:所有|全部|全体|每(?:个|位)|全服|在线(?:玩家|成员|用户)|玩家|成员)|\b(?:all|every|each|online|connected)\b[^,，;；。.!?]{0,24}\b(?:players?|members?|users?)\b|\b(?:players?|members?|users?)\b/i;
  const action = actionPattern.exec(masked);
  if (!action || action.index === undefined || !audiencePattern.test(masked)) return undefined;

  const localPrefix = masked.slice(Math.max(0, action.index - 36), action.index);
  if (/(?:不要|别|禁止|不得|不可|无需|do\s+not|don't|never|without)[^，,；;。.!?]{0,32}$/i.test(localPrefix)) return undefined;
  if (hasAdditionalBroadcastWrite(masked.slice(surface.index + surface[0].length))) return undefined;

  const bodies = actionbarQuotedBodies(value);
  if (bodies.length !== 1) return undefined;
  const body = bodies[0];
  if (!body || body.length > 240 || /[\r\n\0]/.test(body)) return undefined;
  const command = `title @a actionbar ${JSON.stringify({ text: body })}`;
  return command.length <= 256 ? command : undefined;
}

/**
 * Extracts one player-facing main-title write. Audience words such as
 * "online players" belong to the selector in this context and must not create
 * a roster read. The quoted body is preserved as a JSON text component.
 */
export function extractTitleConsoleCommand(intent: string): string | undefined {
  const value = intent.trim();
  if (!value || value.length > 1_000 || /[\r\n\0]/.test(value)) return undefined;
  const masked = maskQuotedText(value);
  const surface = /(?:主标题|大标题|标题)|\b(?:main\s+)?title(?:\s+(?:message|text))?\b/i.exec(masked);
  if (!surface || surface.index === undefined) return undefined;

  const actionPattern = /(?:显示|展示|发送|推送|呈现|弹出|放到)|\b(?:show|display|send|put|post|present)\b/i;
  const audiencePattern = /(?:所有|全部|全体|每(?:个|位)|全服|在线(?:玩家|成员|用户)|玩家|成员)|\b(?:everyone|everybody)\b|\b(?:all|every|each|online|connected)\b[^,，;；。.!?]{0,24}\b(?:players?|members?|users?)\b|\b(?:players?|members?|users?)\b/i;
  const action = actionPattern.exec(masked);
  if (!action || action.index === undefined || !audiencePattern.test(masked)) return undefined;

  const localPrefix = masked.slice(Math.max(0, action.index - 48), action.index);
  if (/(?:不要|别|禁止|不得|不可|无需|do\s+not|don't|never|without)[^，,；;。.!?]{0,40}$/i.test(localPrefix)) return undefined;
  if (hasAdditionalBroadcastWrite(masked.slice(surface.index + surface[0].length))) return undefined;

  const bodies = actionbarQuotedBodies(value);
  if (bodies.length !== 1) return undefined;
  const body = bodies[0];
  if (!body || body.length > 240 || /[\r\n\0]/.test(body)) return undefined;
  const command = `title @a title ${JSON.stringify({ text: body })}`;
  return command.length <= 256 ? command : undefined;
}

/**
 * Extracts one explicit player-facing broadcast while preserving the exact
 * message body. Scope exclusions such as "nothing else" are not operations.
 * Ambiguous, negated, or compound writes fail closed.
 */
export function extractBroadcastConsoleCommand(intent: string): string | undefined {
  const value = intent.trim();
  if (!value || /[\r\n\0]/.test(value)) return undefined;
  const masked = maskQuotedText(value);
  const cue = /(?:广播|公告|向(?:全服|所有玩家|大家)发送(?:一条|一句)?(?:消息|通知)?|(?:console\s+)?announce|broadcast(?:\s+this\s+exact\s+message)?|(?:use\s+)?say(?:\s+to\s+tell\s+(?:every|all)\s+players?)?)/i.exec(masked);
  if (!cue || cue.index === undefined) return undefined;
  const prefix = masked.slice(0, cue.index);
  if (/(?:不要|别|禁止|不得|不可|do\s+not|don't|never)[^，,；;。.!?]{0,32}$/i.test(prefix)) return undefined;
  if (mutationVerbs.some((pattern) => pattern.test(prefix)) && operationalTargets.test(prefix)) return undefined;
  if (hasAdditionalBroadcastWrite(masked.slice(cue.index + cue[0].length))) return undefined;

  const quoted = quotedMessageBodies(value);
  if (quoted.length > 1) return undefined;
  let body = quoted[0];
  if (!body) {
    const tail = value.slice(cue.index + cue[0].length);
    body = tail
      .replace(/^\s*(?:一句|一条|消息|内容|message)?\s*[:：]?\s*/i, "")
      .replace(/\s*(?:[,，;；]\s*)?(?:别做别的|不要(?:执行|做)?(?:任何)?其他(?:事情|操作)|仅此(?:一项)?|只做这(?:一件|一项)|and\s+nothing\s+else|nothing\s+else|only\s+this|only)\s*$/i, "")
      .trim();
  }
  if (!body || body.length > 240 || /[\r\n\0]/.test(body)) return undefined;
  if (/^(?:一句?(?:消息|话)?|一条(?:消息|通知)?|消息|内容|something(?:\s+to\s+players?)?|anything|a\s+message|some\s+message)$/i.test(body)) return undefined;
  return `say ${body}`;
}

/** Extracts ordered console goals while keeping negation local to its clause. */
export function resolveConsoleOperations(intent: string): string[] {
  const value = intent.trim();
  if (!value || isGlobalNegativeEnumeration(value)) return [];
  if (isRuntimeVersionReadIntent(value)) return ["version"];
  const runtimeRead = extractRuntimeConsoleRead(value);
  if (runtimeRead) return [runtimeRead.command];
  if (knowledgeSignals.test(value)) return [];
  const explicitWholeCommand = extractExplicitConsoleCommand(value);
  if (explicitWholeCommand) return [explicitWholeCommand];
  const title = extractTitleConsoleCommand(value);
  if (title) return [title];
  const actionbar = extractActionbarConsoleCommand(value);
  if (actionbar) return [actionbar];
  const broadcast = extractBroadcastConsoleCommand(value);
  if (broadcast) return [broadcast];
  const transientEffect = extractTransientPlayerEffectCommand(value);
  if (transientEffect) return [transientEffect];
  if (isOnlinePlayerReadIntent(value)) return ["list"];
  // Instance lifecycle language is owned exclusively by instance.* tools.
  // Ambiguous lifecycle language must clarify rather than become a console command.
  if (hasInstanceLifecycleLanguage(value)) return [];
  const clauses = splitOperationalClauses(value);
  const commands: string[] = [];
  const suppressQualitativeModeInference = performanceReadMetrics(value).length > 0 && resourcePressureRequested(value);
  let inheritedDomain: string | undefined;
  for (const clause of clauses) {
    const mentionedDomain = consoleDomain(clause);
    if (mentionedDomain) inheritedDomain = mentionedDomain;
    if (isNegatedClause(clause)) continue;
    const explicit = extractExplicitConsoleCommand(clause);
    if (explicit) {
      commands.push(explicit);
      continue;
    }
    const command = resolveConsoleClause(clause, inheritedDomain, suppressQualitativeModeInference);
    if (command) commands.push(command);
  }
  return commands;
}

function quotedMessageBodies(value: string) {
  const patterns = [/“([^”]+)”/g, /「([^」]+)」/g, /‘([^’]+)’/g, /"([^"]+)"/g, /'([^']+)'/g];
  return patterns.flatMap((pattern) => [...value.matchAll(pattern)].map((match) => match[1].trim())).filter(Boolean);
}

function actionbarQuotedBodies(value: string) {
  const patterns = [
    /“([^”]+)”/g,
    /「([^」]+)」/g,
    /‘([^’]+)’/g,
    /"([^"\r\n]+)"/g,
    /(?:^|[\s:：])'([^'\r\n]+)'(?=$|[\s,，;；.!?。！？])/g,
  ];
  const candidates = patterns.flatMap((pattern) => [...value.matchAll(pattern)].map((match) => ({
    body: match[1].trim(),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }))).filter((candidate) => candidate.body);
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const outermost: typeof candidates = [];
  for (const candidate of candidates) {
    if (outermost.some((accepted) => candidate.start >= accepted.start && candidate.end <= accepted.end)) continue;
    outermost.push(candidate);
  }
  return outermost.map((candidate) => candidate.body);
}

function maskQuotedText(value: string) {
  return value.replace(/“[^”]*”|「[^」]*」|‘[^’]*’|"[^"]*"|'[^']*'/g, (segment) => " ".repeat(segment.length));
}

function hasAdditionalBroadcastWrite(tail: string) {
  const afterConnector = tail.match(/(?:[，,；;。！？!?]|\b(?:and\s+then|then|and)\b|然后|随后|并且|同时|再)\s*(.+)$/i)?.[1]?.trim();
  if (!afterConnector) return false;
  if (isNegatedClause(afterConnector)) return false;
  if (/^(?:别做别的|不要(?:执行|做)?(?:任何)?其他(?:事情|操作)|仅此(?:一项)?|只做这(?:一件|一项)|nothing\s+else|only\s+this|only)$/i.test(afterConnector)) return false;
  return mutationVerbs.some((pattern) => pattern.test(afterConnector)) || hasInstanceLifecycleLanguage(afterConnector);
}

export function extractExplicitConsoleCommand(intent: string): string | undefined {
  const patterns = [
    /^(?:\s*(?:mc|minecraft)\s+)?(?:console\s+)?(?:command|cmd)\s*[:：]\s*(.+)$/i,
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

function resolveConsoleClause(value: string, inheritedDomain?: string, suppressQualitativeModeInference = false): string | undefined {
  const lower = value.toLowerCase();
  const mode = Object.entries(modeAliases).find(([alias]) => new RegExp(`(?:^|[^a-z])${escapePattern(alias)}(?:$|[^a-z])`, "i").test(value))?.[1];
  const explicitDomain = consoleDomain(value);
  // Qualitative resource-health language commonly contains words such as
  // "normal".  A bare mode alias is not a difficulty operation when the same
  // clause is an explicit runtime-metrics judgement.  An explicit difficulty
  // subject still wins, preserving genuine multi-domain commands.
  const inferredModeDomain = !explicitDomain && (suppressQualitativeModeInference || performanceReadMetrics(value).length > 0 && resourcePressureRequested(value))
    ? undefined
    : domainForMode(mode);
  const domain = explicitDomain ?? inferredModeDomain ?? inheritedDomain;

  if (domain === "difficulty") {
    if (mode && ["peaceful", "easy", "normal", "hard"].includes(mode)) return `difficulty ${mode}`;
    if (/(?:查看|查询|当前|现在|show|query|current|check)/i.test(value)) return "difficulty";
  }
  if ((domain === "weather" || (mode && ["clear", "rain", "thunder"].includes(mode))) && mode && ["clear", "rain", "thunder"].includes(mode)) return `weather ${mode}`;
  if (domain === "time" || (mode && ["day", "noon", "night", "midnight"].includes(mode))) {
    const numeric = lower.match(/(?:时间|time)[^\d]{0,16}(\d{1,6})/)?.[1];
    if (numeric) return `time set ${numeric}`;
    if (mode && ["day", "noon", "night", "midnight"].includes(mode)) return `time set ${mode}`;
  }
  if (domain === "whitelist") {
    const player = value.match(/(?:添加|加入|移除|删除|add|remove)\s*(?:玩家|player)?\s*([A-Za-z0-9_]{3,16})/i)?.[1]
      ?? value.match(/([A-Za-z0-9_]{3,16})\s*(?:加入|添加到|移出|移除出|add(?:ed)?\s+to|remove(?:d)?\s+from).{0,8}(?:白名单|whitelist|allowlist)/i)?.[1];
    const scopedPlayer = player
      ?? value.match(/(?:把|将|仅将|只把|add)\s*([A-Za-z0-9_]{3,16})\s*(?:加(?:入|进|到)|添加|add)/i)?.[1]
      ?? value.match(/add\s+([A-Za-z0-9_]{3,16})\s+to\s+(?:it|the\s+list)/i)?.[1];
    if (scopedPlayer && /(?:添加|加(?:入|进|到)|add)/i.test(value)) return `whitelist add ${scopedPlayer}`;
    if (scopedPlayer && /(?:移除|删除|remove)/i.test(value)) return `whitelist remove ${scopedPlayer}`;
    if (/(?:开启|启用|打开|enable|\bturn\b[^\r\n]{0,40}\bon\b)/i.test(value)) return "whitelist on";
    if (/(?:关闭|禁用|disable|\bturn\b[^\r\n]{0,40}\boff\b)/i.test(value)) return "whitelist off";
    if (/(?:查看|查询|查|列出|\bshow\b|\bquery\b|\blist\b)/i.test(value)) return "whitelist list";
  }
  if ((domain === "gamemode" || (mode && ["survival", "creative", "adventure", "spectator"].includes(mode))) && mode && ["survival", "creative", "adventure", "spectator"].includes(mode)) {
    const player = value.match(/(?:玩家|player)\s*([A-Za-z0-9_]{3,16})/i)?.[1]
      ?? value.match(/^\s*([A-Za-z0-9_]{3,16})\s*(?:的|to\s+)/i)?.[1]
      ?? value.match(/(?:把|将|set)\s*([A-Za-z0-9_]{3,16})/i)?.[1];
    if (player) return `gamemode ${mode} ${player}`;
  }
  if (domain === "gamerule") {
    const match = value.match(/(?:游戏规则|gamerule)\s*([A-Za-z][A-Za-z0-9]*)\s*(?:设为|设置为|改为|=|to)?\s*(true|false|-?\d+)/i);
    if (match) return `gamerule ${match[1]} ${match[2].toLowerCase()}`;
  }
  return undefined;
}

/**
 * Fail-closed language gate. It deliberately detects classes of operations,
 * not individual user sentences. A model may refine the target and arguments,
 * but it cannot turn an operational write request into a direct answer.
 */
export function classifyOperationalLanguage(intent: string): OperationalLanguage {
  const value = intent.trim();
  if (!value || descriptivePrefix.test(value) || /^\s*(?:日志|输出|错误)\s*[:：]/.test(value)) return "none";
  if (isGlobalNegativeEnumeration(value)) return "none";
  // A question form (for example "how much memory") is still an
  // operational read when it names a registered runtime metric. Resolve
  // these concrete observations before the generic knowledge-question gate.
  if (extractTransientPlayerEffectCommand(value)) return "write";
  if (performanceReadMetrics(value).length > 0 || isOnlinePlayerReadIntent(value) || isRuntimeVersionReadIntent(value) || extractRuntimeConsoleRead(value)) return "read";
  if (knowledgeSignals.test(value)) return "none";
  const positiveClauses = splitOperationalClauses(value).filter((clause) => !isNegatedClause(clause));
  const hasPositiveMutation = positiveClauses.some((clause) => mutationVerbs.some((pattern) => pattern.test(clause)));
  // Reporting observable facts is a read even when phrased as an imperative
  // ("tell/show/report names and count").  A real positive mutation always
  // wins, and knowledge/how-to questions were excluded above.
  if (!hasPositiveMutation && operationalTargets.test(value) && observationReportSignals.test(value)) return "read";
  let sawRead = false;
  for (const clause of splitOperationalClauses(value)) {
    if (isNegatedClause(clause)) continue;
    const explicit = extractExplicitConsoleCommand(clause);
    if (explicit) return isReadonlyConsoleCommand(explicit) ? "read" : "write";
    if (mutationVerbs.some((pattern) => pattern.test(clause))) return "write";
    if (isStructuralOperationalImperative(clause, operationalTargets.test(value))) return "write";
    const hasTarget = operationalTargets.test(clause);
    if (hasTarget && /(?:查看|看看|查询|读取|列出|检查|诊断|分析|确认|状态|日志|\bshow\b|\bquery\b|\bread\b|\blist\b|\binspect\b|\bcheck\b|\bdiagnose\b|\banaly[sz]e\b|\bstatus\b)/i.test(clause)) sawRead = true;
  }
  return sawRead ? "read" : "none";
}

/**
 * Distinguishes player-presence observations from instance state changes.
 * A positive read/quantity/list role and a player entity must both be present;
 * the word "online" alone is never enough to select either domain.
 */
export function isOnlinePlayerReadIntent(intent: string): boolean {
  if (extractTitleConsoleCommand(intent)) return false;
  if (extractActionbarConsoleCommand(intent)) return false;
  if (extractTransientPlayerEffectCommand(intent)) return false;
  if (!onlinePresence.test(intent) || !playerEntity.test(intent)) return false;
  if (playerReadAction.test(intent)
    && /(?:在线|在服|连接(?:中|着)?|联机中|online|connected|logged\s+in)[^，,；;。.!?\r\n]{0,24}(?:玩家|成员|用户|人数|几个人|多少人|几位|几人|players?|members?|people)|(?:玩家|成员|用户|人数|几个人|多少人|几位|几人|players?|members?|people)[^，,；;。.!?\r\n]{0,24}(?:在线|在服|连接(?:中|着)?|联机中|online|connected|logged\s+in)/i.test(intent)
    && !/(?:不要|别|禁止|不得|不可|do\s+not|don't|never)[^，,；;。.!?\r\n]{0,16}(?:查|看|读|列|统计|read|show|list|count)/i.test(intent)) return true;
  return splitOperationalClauses(intent).some((clause) => {
    if (!onlinePresence.test(clause) || !playerEntity.test(clause)) return false;
    if (isNegatedClause(clause)) return false;
    return playerReadAction.test(clause);
  });
}

export type PerformanceReadMetric = "tps" | "mspt" | "uptime" | "cpu" | "memory";

/** Extract explicitly requested runtime metrics in source order. */
export function performanceReadMetrics(intent: string): PerformanceReadMetric[] {
  const value = intent.trim();
  if (!value || /(?:解释|含义|原理|区别|为什么|why|difference|mean|explain)/i.test(value)) return [];
  const matches: Array<{ metric: PerformanceReadMetric; index: number }> = [];
  const add = (metric: PerformanceReadMetric, pattern: RegExp) => {
    const match = value.match(pattern);
    if (match?.index !== undefined) matches.push({ metric, index: match.index });
  };
  add("tps", /\btps\b|\bticks?\s+per\s+second\b|\btick\s*(?:rate\b|速率|速度)|(?:每秒|一秒)[^，,。;；\r\n]{0,6}\bticks?\b/i);
  add("mspt", /\bmspt\b|\bmilliseconds?\s+per\s+tick\b/i);
  add("uptime", /(?:已|持续)?(?:运行|启动|在线)(?:时长|时间|多久|了多久)|(?:开|启动|运行)了?多长时间|(?:process|server|service)?\s*uptime|how\s+long[^,，;；.。]{0,24}(?:running|up)/i);
  add("cpu", /\bcpu\b|\bprocessor\s*(?:usage|use|utilization|load)?\b|(?:处理器|进程)\s*(?:占用|使用率|负载)/i);
  add("memory", /(?:内存|运行内存)(?:占用|使用|用了|消耗|用量)?|(?:RAM|memory|heap)\s*(?:usage|use|used|consumption|utilization)?/i);
  return matches.sort((left, right) => left.index - right.index)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.metric === item.metric) === index)
    .map((item) => item.metric);
}

export function resourcePressureMatch(intent: string) {
  return intent.match(/(?:资源|进程|系统)?\s*(?:压力|负载|负担)(?:大不大|高不高|是否偏高|偏高|如何|怎么样|情况)?|(?:资源|系统|进程)(?:整体)?\s*(?:状态|状况|健康(?:状态)?)(?:是否|是不是|算不算)?\s*(?:正常|健康|良好|异常|稳定|怎么样|如何)?|(?:整体|综合)?\s*(?:判断|评估|说明)[^，,。;；\r\n]{0,20}(?:资源|系统|进程)[^，,。;；\r\n]{0,12}(?:正常|健康|异常|压力|负载)|resource\s+(?:pressure|burden)|system\s+load|under\s+(?:heavy\s+)?load|how\s+busy|how\s+(?:healthy|normal|stable|loaded)[^?!.\r\n]{0,32}(?:resources?|system|process)|(?:resource|system|process)\s+(?:status|health|condition)(?:\s+is)?\s*(?:normal|healthy|stable|okay|ok|abnormal)?|whether[^,.;\r\n]{0,24}(?:resource|system|process)[^,.;\r\n]{0,16}(?:normal|healthy|stable|okay|ok|abnormal)/i);
}

export function resourcePressureRequested(intent: string) {
  return Boolean(resourcePressureMatch(intent));
}

/** Match coarse planner shortcuts only within positively scoped clauses. */
export function hasPositiveOperationalMatch(intent: string, pattern: RegExp) {
  if (isGlobalNegativeEnumeration(intent)) return false;
  return splitOperationalClauses(intent).some((clause) => {
    if (isNegatedClause(clause)) return false;
    const baseFlags = pattern.flags.replace(/g/g, "").replace(/y/g, "");
    const flags = baseFlags.includes("i") ? baseFlags : `${baseFlags}i`;
    return new RegExp(pattern.source, flags).test(clause);
  });
}

export function isOnlyNegatedOperation(intent: string) {
  const clauses = splitOperationalClauses(intent);
  return negationSignals.test(intent) && clauses.every((clause) => isNegatedClause(clause) || classifyPositiveClause(clause) === "none");
}

export function deriveOperationObjective(
  intent: string,
  steps: TaskStep[],
  acceptance: AcceptanceRule[],
): OperationObjective {
  const executeSteps = steps.filter((step) => step.purpose !== "verify");
  const verificationSteps = steps.filter((step) => step.purpose === "verify");
  const primary = executeSteps[0] ?? steps[0];
  const risk = highestRisk(steps);
  const action = aggregateOperationAction(executeSteps);
  const executionEvidence = uniqueRequirements(executeSteps.map((step) => evidenceForStep(step, steps.indexOf(step), false, step)).filter(isRequirement));
  const verificationEvidence = uniqueRequirements([
    ...verificationSteps.map((step) => {
      const index = steps.indexOf(step);
      const related = [...steps.slice(0, index)].reverse().find((candidate) => candidate.purpose !== "verify") ?? step;
      return evidenceForStep(step, index, true, related);
    }).filter(isRequirement),
    ...executeSteps.filter((step) => intrinsicToolPolicy(step.tool, step.args).producer_verified)
      .map((step): OperationEvidenceRequirement | undefined => {
        const base = toolEvidenceKind(step.tool);
        if (!base) return undefined;
        const expected = expectedForExecution(step);
        const requirement: OperationEvidenceRequirement = {
          kind: `verification.${base}`, step_id: step.id, tool: step.tool,
          target: targetForStep(step), parameters: canonicalize(step.args) as Record<string, unknown>,
          order: steps.indexOf(step),
        };
        if (expected !== undefined) requirement.expected = expected;
        return requirement;
      }).filter(isRequirement),
    ...(acceptance.length > 0 ? [{
      kind: "verification", step_id: "acceptance", tool: "acceptance", target: targetForStep(primary),
      parameters: { acceptance }, order: steps.length, expected: acceptance,
    }] : []),
    // Read operations are independently grounded by their tool callback and
    // the Agent's terminal verification event, even without acceptance rules.
    ...(action === "read" || action === "diagnose" ? [{
      kind: "verification", step_id: "terminal", tool: "terminal", target: targetForStep(primary),
      parameters: {}, order: steps.length,
    }] : []),
  ]);
  return {
    schema_version: "operation-objective/v2",
    digest: operationDigest(steps),
    capability: primary?.tool ?? "unknown",
    action,
    target: targetForStep(primary),
    parameters: primary?.args ?? {},
    risk,
    requires_confirmation: steps.some((step) => Boolean(step.requires_confirmation)),
    execution_evidence: executionEvidence,
    verification_evidence: verificationEvidence,
    recovery: steps.some((step) => step.rollback) ? "rollback"
      : action === "read" || action === "diagnose" ? "retry-read" : "diagnose",
  };
}

function splitOperationalClauses(intent: string) {
  return intent
    .split(/(?:[，,；;。！？.!?\r\n—–]+|\b(?:and\s+then|then|but)\b|(?:然后|随后|最后|再|但|不过))/i)
    .map((clause) => clause.trim().replace(/^(?:但|不过|只|仅|and|but)\s*/i, ""))
    .filter(Boolean);
}

type RawLifecycleOccurrence = InstanceLifecycleIntent & { index: number; end: number; text: string; default_role: LifecycleOccurrenceRole };

function lifecycleOccurrences(value: string): RawLifecycleOccurrence[] {
  const raw = lifecycleSignals.flatMap((candidate) => {
    const flags = candidate.pattern.flags.includes("g") ? candidate.pattern.flags : `${candidate.pattern.flags}g`;
    const expression = new RegExp(candidate.pattern.source, flags);
    return [...value.matchAll(expression)].map((match) => ({
      action: candidate.action,
      tool: candidate.tool,
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: match[0],
      default_role: candidate.default_role,
    }));
  }).sort((left, right) => left.index - right.index || (right.end - right.index) - (left.end - left.index));
  const selected: RawLifecycleOccurrence[] = [];
  for (const occurrence of raw) {
    if (selected.some((item) => occurrence.index < item.end && occurrence.end > item.index)) continue;
    selected.push(occurrence);
  }
  return selected.sort((left, right) => left.index - right.index);
}

function classifyLifecycleOccurrence(clause: string, clauseIndex: number, occurrence: RawLifecycleOccurrence): InstanceLifecycleOccurrence {
  const before = clause.slice(0, occurrence.index);
  const after = clause.slice(occurrence.end);
  const exclusionAfter = /^(?:[^，,；;。！？\r\n]{0,28})?(?:排除|除外|不在(?:(?:本次|此次|这次|当前)?(?:操作|请求)?|[^，,；;。！？\r\n]{0,8})范围(?:之)?内?|不纳入|不列入|不算在|不允许|不考虑|不执行|不做|不包含|不属于|不要(?:做|执行)?|一概不要|均不要|都不要|禁止|excluded|excepted|forbidden|prohibited|out(?:side)?\s+(?:of\s+)?(?:this|the)?\s*(?:request|scope)|not\s+(?:part|included|considered|in\s+scope|allowed)|is\s+not\s+allowed)/i.test(after.trim());
  const exclusionClause = /(?:排除|除外|不在(?:(?:本次|此次|这次|当前)?(?:操作|请求)?|[^，,；;。！？\r\n]{0,8})范围(?:之)?内?|不纳入|不列入|不算在|不允许|不考虑|不执行|不做|不包含|不属于|(?:都|均|一概)?(?:不要|不得|禁止)(?:做|执行|进行|操作)?|(?:are|is)?\s*(?:excluded|excepted|forbidden|prohibited|out(?:side)?\s+(?:of\s+)?(?:this|the)?\s*(?:request|scope)|not\s+(?:part|included|considered|in\s+scope|allowed)))\s*[.!。！]?\s*$/i.test(clause.trim());
  const localNegation = lastPatternIndex(before, /(?:不要|不用|不得|禁止|不允许|不做|不执行|不考虑|不可|别|无需|不必|避免|一概不|都不|均不|do\s+not|don't|never|without|must\s+not|should\s+not)/gi)
    > lastPatternIndex(before, /(?:[，,；;。！？\r\n—–]|\b(?:but|then|although|so)\b|(?:但|不过|然后|随后|只|仅|但需要|所以))/gi);
  const negative = localNegation || exclusionAfter || exclusionClause || isNegatedClause(clause);
  const role = occurrence.default_role === "current_state"
    ? "current_state"
    : negative
      ? "constraint"
      : occurrence.default_role;
  return {
    action: occurrence.action,
    tool: occurrence.tool,
    index: occurrence.index,
    end: occurrence.end,
    text: occurrence.text,
    clause,
    clause_index: clauseIndex,
    role,
    polarity: negative ? "negative" : "positive",
  };
}

function lastPatternIndex(value: string, pattern: RegExp) {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index ?? index;
  return index;
}

function isNegatedClause(clause: string) {
  return /^(?:\s*(?:但|不过|and|but)\s*)?(?:也|并)?\s*(?:不要|不用|不得|禁止|无需|不必|别|不可|避免|do\s+not|don't|without|never|keep\b.+\benabled)/i.test(clause.trim());
}

function isGlobalNegativeEnumeration(intent: string) {
  const value = intent.trim();
  if (!isNegatedClause(value)) return false;
  // Plain commas and "or" retain a leading prohibition. A sequencing or
  // adversative marker opens a new positive scope unless it is also negated.
  return !/(?:[；;。！？]|\b(?:and\s+then|then)\b|然后|随后|最后|再|(?:\bbut\b|但|不过|只|仅)\s*(?!(?:do\s+not|don't|never)\b|不要|不用|不得|禁止|别|不可))/i.test(value);
}

function classifyPositiveClause(clause: string): OperationalLanguage {
  if (extractExplicitConsoleCommand(clause) || mutationVerbs.some((pattern) => pattern.test(clause)) || isStructuralOperationalImperative(clause)) return "write";
  return "none";
}

function isStructuralOperationalImperative(clause: string, inheritedTarget = false) {
  if ((!operationalTargets.test(clause) && !inheritedTarget) || /[?？]\s*$/.test(clause) || descriptivePrefix.test(clause)) return false;
  return englishImperativePrefix.test(clause) || chineseImperativeFrame.test(clause);
}

function consoleDomain(value: string) {
  if (/(?:难度|difficulty)/i.test(value)) return "difficulty";
  if (/(?:天气|weather)/i.test(value)) return "weather";
  if (/(?:时间|time)/i.test(value)) return "time";
  if (/(?:白名单|允许名单|准入名单|whitelist|allowlist)/i.test(value)) return "whitelist";
  if (/(?:游戏模式|gamemode)/i.test(value)) return "gamemode";
  if (/(?:游戏规则|gamerule)/i.test(value)) return "gamerule";
  return undefined;
}

function domainForMode(mode: string | undefined) {
  if (!mode) return undefined;
  if (["peaceful", "easy", "normal", "hard"].includes(mode)) return "difficulty";
  if (["clear", "rain", "thunder"].includes(mode)) return "weather";
  if (["day", "noon", "night", "midnight"].includes(mode)) return "time";
  if (["survival", "creative", "adventure", "spectator"].includes(mode)) return "gamemode";
  return undefined;
}

function isReadonlyConsoleCommand(command: string) {
  const normalized = command.trim().replace(/^minecraft:/i, "").toLowerCase();
  const verb = normalized.split(/\s+/, 1)[0];
  return ["list", "help", "version", "plugins", "pl", "tps", "mspt", "seed"].includes(verb)
    || normalized === "difficulty" || normalized === "whitelist list"
    || /^time\s+query\s+(?:daytime|gametime|day)$/.test(normalized)
    || normalized === "worldborder get" || /^datapack list (?:enabled|available)$/.test(normalized)
    || normalized === "banlist players" || normalized === "team list"
    || normalized === "scoreboard objectives list" || normalized === "forceload query"
    || /^gamerule\s+[a-z][a-z0-9]*$/.test(normalized);
}

function targetForStep(step: TaskStep | undefined) {
  if (!step) return "unknown";
  for (const key of ["path", "project", "command", "platform", "target"]) {
    const value = step.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return step.tool;
}

function evidenceForStep(step: TaskStep, order: number, verification: boolean, related: TaskStep): OperationEvidenceRequirement | undefined {
  const base = toolEvidenceKind(step.tool);
  if (!base) return undefined;
  const requirement: OperationEvidenceRequirement = {
    kind: verification ? `verification.${base}` : base,
    step_id: step.id,
    tool: step.tool,
    target: targetForStep(related),
    parameters: canonicalize(step.args) as Record<string, unknown>,
    order,
    ...(verification ? { expected: expectedForExecution(related) } : {}),
  };
  const expected = expectedTokens(step);
  if (expected.length) requirement.contains = expected;
  return requirement;
}

function toolEvidenceKind(tool: string) {
  if (tool === "console.command") return "console";
  if (tool === "logs.query") return "logs";
  if (tool === "files.list") return "files";
  if (tool.startsWith("config.")) return "config";
  if (tool === "plugin.install") return "files";
  if (tool.startsWith("plugin.")) return "plugin";
  if (tool === "web.search") return "web_search";
  if (tool === "file.download") return "download";
  if (tool.startsWith("server.")) return "download";
  if (tool === "instance.metrics") return "metrics";
  if (tool === "players.inspect") return "players";
  if (tool.startsWith("instance.")) return "instance";
  return undefined;
}

function expectedTokens(step: TaskStep) {
  if (step.tool === "files.list" && typeof step.args.expect === "string") return [step.args.expect.toLowerCase()];
  if (step.tool === "logs.query" && typeof step.args.expect === "string") return [step.args.expect.toLowerCase()];
  if (step.tool === "config.inspect" && typeof step.args.expect === "string") {
    const [key, ...valueParts] = step.args.expect.split("=");
    return [key.split(".").at(-1), valueParts.join("=")].filter((item): item is string => Boolean(item)).map((item) => item.toLowerCase());
  }
  if (step.tool !== "console.command") return [];
  if (typeof step.args.expect === "string") return [step.args.expect.toLowerCase()];
  const command = String(step.args.command ?? "").trim().toLowerCase();
  const [verb, ...args] = command.split(/\s+/);
  if (["difficulty", "gamerule"].includes(verb) && args.length) return [args.at(-1)!];
  if (verb === "gamemode" && args.length) return [args[0]];
  if (verb === "whitelist" && args.length > 1) return [args.at(-1)!];
  return [];
}

function uniqueRequirements(requirements: OperationEvidenceRequirement[]) {
  const byKey = new Map<string, OperationEvidenceRequirement>();
  for (const requirement of requirements) {
    const key = `${requirement.order}:${requirement.step_id}:${requirement.kind}:${(requirement.contains ?? []).join("|")}`;
    byKey.set(key, requirement);
  }
  return [...byKey.values()];
}

function isRequirement(value: OperationEvidenceRequirement | undefined): value is OperationEvidenceRequirement {
  return Boolean(value);
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectedForExecution(step: TaskStep): unknown {
  if (step.tool === "console.command") {
    const fields = String(step.args.command ?? "").trim().split(/\s+/);
    const verb = fields[0]?.replace(/^minecraft:/i, "").toLowerCase();
    if (["difficulty", "weather"].includes(verb) && fields[1]) return fields[1].toLowerCase();
    if (verb === "time" && fields[1]?.toLowerCase() === "set" && fields[2]) return fields[2].toLowerCase();
    if (verb === "gamerule" && fields[2]) return fields[2].toLowerCase();
    if (verb === "gamemode" && fields[1]) return fields[1].toLowerCase();
    if (verb === "whitelist" && fields[1] === "add") return "present";
    if (verb === "whitelist" && fields[1] === "remove") return "absent";
    if (verb === "whitelist" && fields[1] === "on") return "true";
    if (verb === "whitelist" && fields[1] === "off") return "false";
  }
  if (step.tool === "config.patch") return step.args.patch;
  if (step.tool === "plugin.install") return step.args.project;
  return undefined;
}

function operationDigest(steps: TaskStep[]) {
  const normalized = steps.map((step, order) => ({
    id: step.id,
    tool: step.tool,
    target: targetForStep(step),
    parameters: canonicalize(step.args),
    order,
    purpose: step.purpose ?? "execute",
  }));
  return createHash("sha256").update(JSON.stringify(canonicalize(normalized))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
