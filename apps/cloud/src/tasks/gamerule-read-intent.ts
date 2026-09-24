export interface GameruleReadIntent {
  rule: string;
  sourceIndex: number;
}

const ruleName = "[A-Za-z][A-Za-z0-9]{0,63}";
const readSignal = /(?:只读|只查询|查询|查看|核对|复核|当前值|现在(?:是|为)?什么|是多少|read|query|show|check|inspect|review|current\s+value|what\s+is)/i;
const positiveSetter = new RegExp(`(?:set|change|update|设为|设置为|改为|修改为|更新为|=).{0,32}(?:gamerule|game\\s*rule|游戏规则)|(?:gamerule|game\\s*rule|游戏规则).{0,64}(?:set\\s+to|change\\s+to|=|设为|设置为|改为|修改为|更新为)`, "i");
const rawCommandSetter = new RegExp(`^\\s*\\/?gamerule\\s+${ruleName}\\s+(?:true|false|-?\\d+|[A-Za-z][A-Za-z0-9_-]*)\\s*$`, "i");

function withoutNegativeWriteConstraints(intent: string) {
  const mask = (value: string) => " ".repeat(value.length);
  return intent
    .replace(/(?:do\s+not|don't|never)\s+(?:change|modify|adjust|set|write|update)\b[^.;,]*/gi, mask)
    .replace(/without\s+(?:changing|modifying|adjusting|setting|writing|updating)\b[^.;,]*/gi, mask)
    .replace(/make\s+no\s+(?:changes?|modifications?)\b[^.;,]*/gi, mask)
    .replace(/[\u4e0d\u522b\u7981\u4e25\u65e0][\u8981\u6b62\u7981\u9700\u6cd5]?[^\uff0c\u3002\uff1b,.;]{0,20}(?:\u4fee\u6539|\u66f4\u6539|\u8c03\u6574|\u8bbe\u7f6e|\u5199\u5165)[^\uff0c\u3002\uff1b,.;]*/g, mask);
}

/**
 * Extract a parameter-free gamerule observation. This function never turns a
 * setter into a read and never accepts command separators or multiple rules.
 */
export function extractGameruleReadIntent(intent: string): GameruleReadIntent | undefined {
  const positiveActionText = withoutNegativeWriteConstraints(intent);
  if (!readSignal.test(intent) || positiveSetter.test(positiveActionText) || rawCommandSetter.test(intent)) return undefined;
  if (/\r|\n|&&|\|\||[|`$]/.test(intent) || /[;；]\s*\/?(?:op|deop|stop|restart|start|ban|kick|execute|function|data|setblock|fill)\b/i.test(intent)) return undefined;
  if (new RegExp(`(?:gamerule|game\\s*rule|游戏规则)\\s*${ruleName}(?:\\s+(?:and|or)\\s+|\\s*[和与、]\\s*)${ruleName}`, "i").test(intent)) return undefined;

  const candidates: Array<{ rule: string; index: number }> = [];
  const patterns = [
    new RegExp(`(?:read|query|show|check|inspect|review)\\s+(?:the\\s+)?(?:current\\s+value\\s+of\\s+)?(${ruleName})\\s+(?:gamerule|game\\s*rule)`, "ig"),
    new RegExp(`(?:gamerule|game\\s*rule|游戏规则)\\s*(?:的|名为|named)?\\s*(${ruleName})`, "ig"),
    new RegExp(`(${ruleName})\\s*(?:这条|这个|the)?\\s*(?:gamerule|game\\s*rule|游戏规则)`, "ig"),
    new RegExp(`(?:current\\s+value\\s+of|value\\s+of)\\s+(${ruleName})\\s+(?:gamerule|game\\s*rule)`, "ig"),
  ];
  for (const pattern of patterns) {
    for (const match of positiveActionText.matchAll(pattern)) {
      const rule = match[1];
      if (!rule) continue;
      if (/^(?:read|query|show|check|inspect|review|verify|current|value|what|of|the|a|an)$/i.test(rule)) continue;
      const offset = (match.index ?? 0) + match[0].indexOf(rule);
      if (!candidates.some((candidate) => candidate.rule.toLowerCase() === rule.toLowerCase())) candidates.push({ rule, index: offset });
    }
  }
  if (candidates.length === 0 && (/(?:gamerule|game\s*rule|游戏规则)/i.test(intent)
    || /(?:当前值|数值|current\s+value|numeric\s+value).{0,48}(?:是否|判断|whether|decide|determine)|(?:是否|判断|whether|decide|determine).{0,48}(?:当前值|数值|numeric\s+value)/i.test(intent))) {
    const identifiers = [...positiveActionText.matchAll(/\b([A-Za-z][A-Za-z0-9]{2,63})\b/g)]
      .filter((match) => /[a-z][A-Z]|^[a-z]+(?:Speed|Spawning|Cycle|Fire|Drops|Griefing|Weather|Daylight)$/.test(match[1]))
      .filter((match) => !/^(?:gamerule|game|rule|current|value|check|read|query|show|whether|determine|change|modify)$/i.test(match[1]));
    const unique = [...new Map(identifiers.map((match) => [match[1].toLowerCase(), match])).values()];
    if (unique.length === 1) candidates.push({ rule: unique[0][1], index: unique[0].index ?? 0 });
  }
  if (candidates.length !== 1) return undefined;
  return { rule: candidates[0].rule, sourceIndex: candidates[0].index };
}
