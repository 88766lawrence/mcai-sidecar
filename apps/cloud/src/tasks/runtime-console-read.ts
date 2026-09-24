export type RuntimeConsoleReadKind =
  | "seed" | "difficulty" | "daytime" | "gametime" | "worldborder"
  | "datapacks-enabled" | "datapacks-available"
  | "banned-players" | "teams" | "scoreboard-objectives" | "forceload";

export interface RuntimeConsoleReadIntent {
  kind: RuntimeConsoleReadKind;
  command: string;
  sourceIndex: number;
  sourceText: string;
  wantsPeacefulJudgement?: boolean;
  peacefulIndex?: number;
  peacefulText?: string;
  wantsPeriodJudgement?: boolean;
  periodIndex?: number;
  periodText?: string;
  wantsGreaterThanZeroJudgement?: boolean;
  greaterThanZeroIndex?: number;
  greaterThanZeroText?: string;
  wantsCollection?: boolean;
  wantsCount?: boolean;
  countIndex?: number;
  countText?: string;
}

const readCue = /(?:只读|读取|查看|看看|查询|查一下|核对|复核|确认当前|告诉|报告|多少|列出|当前|现在|目前|read[- ]?only|read|show|query|check|inspect|review|report|tell|list|give|current|present|how\s+(?:large|many)|what\s+is)/i;
const writeCue = /(?:设为|设置|改为|改成|调成|切成|调整|变更|修改|扩大|缩小|启用|停用|set|change|adjust|modify|resize|enable|disable)/i;
const negativeWrite = /(?:不要|不得|禁止|别|不可|无需|不必|保持.{0,16}(?:不变|原样)|without|do\s+not|don't|never|no\s+changes?|keep.{0,20}(?:unchanged|as\s+is))/i;

/** Deterministic catalogue for bounded, parameter-free Minecraft reads. */
export function extractRuntimeConsoleRead(intent: string): RuntimeConsoleReadIntent | undefined {
  const value = intent.trim();
  if (!value || !readCue.test(value)) return undefined;

  const seed = value.match(/(?:世界|主世界|world|overworld)[^，；。!?\r\n]{0,20}(?:种子(?:值)?|seed)|(?:种子(?:值)?|seed)[^，；。!?\r\n]{0,20}(?:世界|主世界|world|overworld)?/i);
  if (seed && !positiveSetterNear(value, seed.index ?? 0, /(?:种子|seed)/i)) return observation("seed", "seed", seed);

  const difficulty = value.match(/(?:游戏|世界|服务器|server|world|game)?\s*(?:难度|difficulty)/i);
  if (difficulty && !positiveSetterNear(value, difficulty.index ?? 0, /(?:难度|difficulty)/i)) {
    const peaceful = value.match(/(?:是否|是不是|判断|determine|whether|if)[^，；。!?\r\n]{0,24}(?:和平(?:模式|难度)?|peaceful)|(?:和平(?:模式|难度)?|peaceful)[^，；。!?\r\n]{0,24}(?:是否|是不是|判断|whether|if)/i);
    return { ...observation("difficulty", "difficulty", difficulty), ...(peaceful ? { wantsPeacefulJudgement: true, peacefulIndex: peaceful.index ?? 0, peacefulText: peaceful[0] } : {}) };
  }

  const gametime = value.match(/(?:累计|总计|已经运行|运行了|总运行|elapsed|total|accumulated)[^，；。!?\r\n]{0,28}(?:游戏时刻|游戏刻数|游戏刻|刻数|game\s*time|gametime|ticks?)|(?:game\s*time|gametime)[^，；。!?\r\n]{0,16}(?:ticks?)?|(?:time\s+query\s+gametime)/i);
  if (gametime && !positiveSetterNear(value, gametime.index ?? 0, /(?:时间|time|gametime|游戏刻)/i)) {
    const judgement = value.match(/(?:是否|判断|whether|determine|check)[^，；。!?\r\n]{0,28}(?:大于|超过|above|greater\s+than)\s*(?:零|0)/i);
    return { ...observation("gametime", "time query gametime", gametime), ...(judgement ? { wantsGreaterThanZeroJudgement: true, greaterThanZeroIndex: judgement.index ?? 0, greaterThanZeroText: judgement[0] } : {}) };
  }

  const daytime = value.match(/(?:世界|主世界|world|overworld)?[^，；。!?\r\n]{0,16}(?:时间刻数|时间刻|刻数|daytime\s+ticks?|world\s+time)|(?:time\s+query\s+daytime)/i);
  if (daytime && !positiveSetterNear(value, daytime.index ?? 0, /(?:时间|time|daytime)/i)) {
    const period = value.match(/(?:白天(?:还是|或|或者|和)夜晚|夜晚(?:还是|或|或者|和)白天|昼间(?:还是|或|或者|和)夜间|夜间(?:还是|或|或者|和)昼间|昼夜|day(?:time)?\s+or\s+night(?:time)?)/i);
    return { ...observation("daytime", "time query daytime", daytime), ...(period ? { wantsPeriodJudgement: true, periodIndex: period.index ?? 0, periodText: period[0] } : {}) };
  }

  const border = value.match(/(?:世界边界|world(?:'s)?[^，；。!?\r\n]{0,12}border|worldborder)[^，；。!?\r\n]{0,24}(?:直径|大小|宽度|diameter|size|width)|(?:直径|大小|宽度|diameter|size|width)[^，；。!?\r\n]{0,24}(?:世界边界|world(?:'s)?[^，；。!?\r\n]{0,12}border|worldborder)/i);
  if (border && !positiveSetterNear(value, border.index ?? 0, /(?:边界|border|直径|diameter|size|width)/i)) return observation("worldborder", "worldborder get", border);

  const datapack = value.match(/(?:数据包|资料包|data\s*packs?|datapacks?)/i);
  const availableState = /(?:可用但未启用|可用且未启用|尚未启用|未启用但可用|available\s+but\s+(?:(?:not\s+)?enabled|disabled)|available\s+(?:and\s+)?disabled|not\s+enabled|inactive)/i.test(value);
  const enabledState = !availableState && /(?:当前|现有|已|正在|currently|presently)?\s*(?:启用(?:的|了)?|生效(?:的)?|enabled|active)/i.test(value);
  const collection = value.match(/(?:哪些|名称|名单|列表|列出|name|names|list|which)/i);
  const count = value.match(/(?:数量|个数|多少|总数|count|how\s+many|number)/i);
  if (datapack && (enabledState || availableState) && (collection || count)) {
    const kind = availableState ? "datapacks-available" : "datapacks-enabled";
    const command = availableState ? "datapack list available" : "datapack list enabled";
    return { ...observation(kind, command, datapack), wantsCollection: Boolean(collection), wantsCount: Boolean(count), ...(count ? { countIndex: count.index ?? 0, countText: count[0] } : {}) };
  }

  const roster = (kind: RuntimeConsoleReadKind, command: string, subject: RegExp) => {
    const match = value.match(subject);
    if (!match) return undefined;
    const wantsCollection = /(?:清单|名单|名称|列表|列出|哪些|names?|roster|inventory|list|which)/i.test(value)
      || /(?:players?|teams?|objectives?|chunks?|regions?|packs?)\b/i.test(match[0]);
    const countMatch = value.match(/(?:人数|数量|个数|多少|总数|count|how\s+many|number|total)/i);
    if (!wantsCollection && !countMatch) return undefined;
    return { ...observation(kind, command, match), wantsCollection, wantsCount: Boolean(countMatch), ...(countMatch ? { countIndex: countMatch.index ?? 0, countText: countMatch[0] } : {}) } as RuntimeConsoleReadIntent;
  };
  return roster("banned-players", "banlist players", /(?:被封禁|已封禁|封禁中的)(?:的)?\s*(?:玩家|用户)|封禁(?:玩家|用户)(?:名单|列表)?|banned[-\s]+(?:players?|users?)|player\s+ban\s*(?:list|roster)?|banned\s+(?:player\s+)?(?:list|roster)/i)
    ?? roster("teams", "team list", /(?:计分板[^，；。!?\r\n]{0,16})?(?:现有|当前)?\s*(?:队伍|团队)|scoreboard\s+teams?|existing\s+teams?/i)
    ?? roster("scoreboard-objectives", "scoreboard objectives list", /(?:计分板\s*(?:目标|计分目标)|scoreboard\s+objectives?|scoring\s+objectives?)/i)
    ?? roster("forceload", "forceload query", /(?:强制加载|常加载)[^，；。!?\r\n]{0,12}(?:区块|区域)?|force[- ]?loaded\s+(?:chunks?|regions?)|forceload(?:ed)?\s+(?:chunks?|regions?)/i);
}

function observation(kind: RuntimeConsoleReadKind, command: string, match: RegExpMatchArray): RuntimeConsoleReadIntent {
  return { kind, command, sourceIndex: match.index ?? 0, sourceText: match[0] };
}

function positiveSetterNear(value: string, _index: number, subject: RegExp) {
  const clauses = value.split(/[，；。!?\r\n]+/).map((text) => text.trim()).filter(Boolean);
  return clauses.some((clause) => subject.test(clause) && writeCue.test(clause) && !negativeWrite.test(clause));
}
