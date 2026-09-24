export interface PluginResolveIntent {
  project: string;
  platform?: string;
  minecraftVersion?: string;
  loader?: string;
}

export const pluginMetadataSignal = /(?:兼容|适配|支持|可信(?:来源)?|发布源|制品|构建|版本|校验(?:值|信息)?|签名|哈希|完整性|compatible|compatibility|support(?:s|ed)?|trusted(?:\s+source)?|authoritative\s+source|provenance|artifact|release|version|checksum|signature|hash|integrity|metadata)/i;
const platformPattern = /\b(paper|fabric|forge|neoforge|spigot|purpur|bukkit|velocity|waterfall)\s*(?:loader|server|服务端|平台)?\s*(1\.\d+(?:\.\d+)?)/i;
const platformMatchSignal = /\b[A-Za-z][A-Za-z0-9_-]{1,63}\s+matches?\s+(?:paper|fabric|forge|neoforge|spigot|purpur|bukkit|velocity|waterfall)\b/i;
const stopWords = new Set(["plugin", "minecraft", "server", "paper", "fabric", "forge", "neoforge", "spigot", "purpur", "bukkit", "velocity", "waterfall", "version", "release", "source", "checksum", "signature", "hash", "integrity", "anything", "whether", "compatibility", "it", "its", "this", "that", "resolve", "find", "query", "check", "audit", "verify", "review", "report", "provide", "give", "determine", "loaded", "installed", "current", "recent", "logs", "log", "crash", "evidence", "for", "from", "of", "the", "and", "with", "without"]);
const platformIdentityLeads = new Set(["paper", "fabric", "forge", "neoforge", "spigot", "purpur", "bukkit", "velocity", "waterfall"]);
const readSignal = /(?:只查|只查询|只核对|仅查询|仅核对|查询|查找|检查|核对|核验|复核|解析|校验|确认|判断|只读|资料|look\s*up|resolve|verify|check|audit|review|determine|read[- ]?only|metadata\s+only)/i;
const writeForbidSignal = /(?:不要|不得|禁止|别|不可|避免|无需|不必|不落盘|do\s+not|don't|without|never|no\s+)(?:[^，,；;。.!?]{0,24})(?:下载|拉取|安装|部署|写入|download|fetch|install|deploy|write)/i;

/** Extract a bounded metadata-only plugin lookup without assigning risk. */
export function extractPluginResolveIntent(intent: string): PluginResolveIntent | undefined {
  if (/\b[A-Za-z0-9_.-]+\.(?:properties|conf|json|ya?ml)\b/i.test(intent)) return undefined;
  if ((!pluginMetadataSignal.test(intent) && !platformMatchSignal.test(intent)) || (!readSignal.test(intent) && !writeForbidSignal.test(intent))) return undefined;
  const source = intent.split(/\n\s*\nAgent operation:\s*/i)[0];
  const candidates: Array<{ value: string; score: number; index: number }> = [];
  const normalizeProject = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  const collect = (pattern: RegExp, score: number) => {
    for (const match of source.matchAll(pattern)) {
      const value = match[1]?.trim();
      const normalized = value ? normalizeProject(value) : "";
      const words = value!.split(/\s+/).map((part) => part.toLowerCase());
      const allowedPlatformTitle = words.length > 1 && platformIdentityLeads.has(words[0]);
      if (!normalized || !/^[a-z][a-z0-9-]{1,63}$/.test(normalized) || /-$/.test(normalized)
        || stopWords.has(words[0]) && !allowedPlatformTitle
        || words.every((part) => stopWords.has(part))) continue;
      candidates.push({ value: normalized, score: score + (/[A-Z]/.test(value!) ? 10 : 0), index: match.index ?? 0 });
    }
  };
  // Multi-word product names are opaque plugin identities. Requiring every
  // project to be a single token silently loses legitimate titles such as
  // "Fabric API". Only bounded title-like sequences adjacent to metadata
  // semantics are accepted; generic prose remains excluded by stop words.
  collect(/\b([A-Z][A-Za-z0-9_-]{1,31}(?:\s+[A-Z][A-Za-z0-9_-]{1,31}){1,2})\s*(?:插件|plugin|是否|能否|可否|兼容|适配|支持|compatibility|compatible|supports?|matches?|works?\s+(?:on|with|for))/gu, 175);
  collect(/\b([A-Z][A-Za-z0-9_-]{1,31}(?:\s+[A-Z][A-Za-z0-9_-]{1,31}){1,2})\s*(?:(?:是否)?有?适用于|可用于|适配于|works?\s+(?:on|with|for)|has\s+(?:an?\s+)?(?:artifact|release)\s+for)/gu, 178);
  collect(/\b([A-Z][A-Za-z0-9_-]{1,31}(?:\s+[A-Z][A-Za-z0-9_-]{1,31}){1,2})(?=[^,，;；.。!?\r\n]{0,40}\b(?:artifact|release|metadata|compatibility|compatible|provenance|checksum|signature|hash)\b)/gu, 170);
  collect(/\b([A-Za-z][A-Za-z0-9_-]{1,63})\s*(?:插件|plugin)\b/gi, 150);
  collect(/\b([A-Za-z][A-Za-z0-9_-]{1,63})\s*(?:是否|能否|可否|是不是|is\s+it\s+)?(?:兼容|适配|支持|compatible\b|matches?\b|supports?\b)/gi, 145);
  collect(/\b([A-Za-z][A-Za-z0-9_-]{1,63})\s*(?:(?:是否)?有?适用于|可用于|适配于|works?\s+(?:on|with|for)|has\s+(?:an?\s+)?(?:artifact|release)\s+for)/giu, 148);
  collect(/(?:查询|查找|检查|核对|核验|复核|解析|校验|确认)\s*([A-Za-z][A-Za-z0-9_-]{1,63})/gi, 140);
  collect(/\b(?:verify|check|audit|review|resolve|look\s*up)\s+(?:whether\s+|the\s+)?([A-Za-z][A-Za-z0-9_-]{1,63})\b/gi, 130);
  collect(/\b(?:install|deploy|download|fetch)\s+([A-Za-z][A-Za-z0-9_-]{1,63})\b/gi, writeForbidSignal.test(source) ? 120 : 20);
  collect(/\b([A-Za-z][A-Za-z0-9_-]{1,63})\s+(?:compatibility|metadata|provenance|artifact|release)\b/gi, 125);
  const selected = candidates.sort((left, right) => right.score - left.score || left.index - right.index)[0];
  if (!selected || selected.score < 100) return undefined;
  const compatibility = source.match(platformPattern);
  const platform = compatibility?.[1]?.toLowerCase();
  const minecraftVersion = compatibility?.[2];
  return {
    project: selected.value === "essentials" ? "essentialsx" : selected.value,
    ...(platform ? { platform, loader: platform } : {}),
    ...(minecraftVersion ? { minecraftVersion } : {}),
  };
}
