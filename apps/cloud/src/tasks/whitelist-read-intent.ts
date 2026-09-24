export interface WhitelistReadIntent {
  wantsRoster: boolean;
  wantsCount: boolean;
  wantsEmpty: boolean;
  sourceIndex: number;
  rosterIndex: number;
  countIndex: number;
}

const whitelistPattern = /(?:白名单|允许名单|准入名单|whitelist|allowlist)/i;
const rosterPattern = /(?:名单|列表|都有谁|有哪些人|谁在|成员|玩家|用户|members?|players?|users?|roster|names?|list\s+(?:the\s+)?(?:members?|players?|users?))/i;
const countPattern = /(?:人数|数量|个数|多少(?:人|个)?|统计|count|how\s+many|number\s+of)/i;
const emptyPattern = /(?:是否为空|是不是空|有没有(?:成员|玩家|用户|人)|有无(?:成员|玩家|用户|人)|empty|any\s+(?:members?|players?|users?))/i;
const readPattern = /(?:只读|查看|看看|查询|查一下|查查|读取|读一下|列出|显示|告诉|核对|统计|数数|read(?:-?only)?|show|list|query|check|inspect|tell\s+me|report|count)/i;
const mutationPattern = /(?:添加|加入|移除|删除|踢出|开启|启用|关闭|禁用|修改|更改|写入|add|remove|delete|enable|disable|turn\s+(?:the\s+)?(?:whitelist|allowlist)\s+(?:on|off)|set|change|modify|write)/gi;
const localNegationPattern = /(?:不要|别|禁止|不许|不得|无需|无需进行|do\s+not|don't|never|without|no\s+changes?|must\s+not)/i;

/**
 * Recognises a metadata-only access-list observation. The model is not used
 * for this parameter-free read: a positive mutation remains outside this
 * route, while locally-negated mutations are preserved as safety constraints.
 */
export function extractWhitelistReadIntent(value: string): WhitelistReadIntent | undefined {
  const domain = whitelistPattern.exec(value);
  if (!domain) return undefined;

  for (const mutation of value.matchAll(mutationPattern)) {
    const index = mutation.index ?? 0;
    const prefix = value.slice(Math.max(0, index - 28), index);
    if (!localNegationPattern.test(prefix)) return undefined;
  }

  const masked = `${value.slice(0, domain.index)}${" ".repeat(domain[0].length)}${value.slice(domain.index + domain[0].length)}`;
  const roster = rosterPattern.exec(masked);
  const count = countPattern.exec(value);
  const empty = emptyPattern.exec(value);
  if (!readPattern.test(value) && !roster && !count && !empty) return undefined;

  return {
    wantsRoster: Boolean(roster) || (!count && !empty),
    wantsCount: Boolean(count) || Boolean(empty),
    wantsEmpty: Boolean(empty),
    sourceIndex: domain.index,
    rosterIndex: roster?.index ?? domain.index,
    countIndex: count?.index ?? empty?.index ?? domain.index,
  };
}
