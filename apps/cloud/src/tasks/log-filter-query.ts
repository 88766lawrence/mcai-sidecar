import { createHash } from "node:crypto";

export interface LogFilterGroupV1 {
  all_of: string[];
  any_of: string[];
}

export interface LogFilterQueryV1 {
  schema_version: "log-filter-query/v1";
  groups: LogFilterGroupV1[];
  digest: string;
}

type MatchDefinition = { token: string; pattern: RegExp; terms: string[] };

const subjectDefinitions: MatchDefinition[] = [
  {
    token: "client_connection",
    pattern: /(?:玩家|客户端|用户|成员|players?|clients?|users?|members?)[^，,；;。.!?\r\n]{0,40}(?:连接|联机|登录|加入|握手|connection|connect|login|join|handshake)|(?:连接|联机|登录|加入|握手|connection|connect|login|join|handshake)[^，,；;。.!?\r\n]{0,40}(?:玩家|客户端|用户|成员|players?|clients?|users?|members?)/i,
    terms: ["player", "client", "user authenticator", "login", "logged in", "joined", "join", "connection", "connect", "handshake", "玩家", "客户端", "用户", "登录", "加入", "连接", "握手"],
  },
  { token: "client_connection", pattern: /\b(?:connection|connect|login|handshake|player\s+join)\b/i, terms: [] },
  { token: "http_request", pattern: /\b(?:http|api|webhook|provider)\b|(?:接口|网页请求)/i, terms: ["http", "api", "webhook", "request", "接口"] },
  { token: "backup", pattern: /(?:备份|快照|backup|snapshot)/i, terms: ["backup", "snapshot", "备份", "快照"] },
  { token: "world_storage", pattern: /(?:世界|区块|存档|world|chunk).{0,20}(?:保存|写盘|save|saving)|(?:保存|写盘|save|saving).{0,20}(?:世界|区块|存档|world|chunk)/i, terms: [] },
  { token: "software_component", pattern: /(?:插件|扩展|模块|组件|加载器|plugin|extension|module|component|loader)/i, terms: ["plugin", "extension", "module", "component", "loader", "插件", "扩展", "模块", "组件", "加载器"] },
  { token: "database_service", pattern: /(?:数据库|数据源|database|datasource|sql|mysql|postgres(?:ql)?|redis)/i, terms: ["database", "datasource", "sql", "mysql", "postgres", "postgresql", "redis", "数据库", "数据源"] },
  { token: "proxy_service", pattern: /(?:代理|网关|反向代理|proxy|gateway|reverse\s+proxy)/i, terms: ["proxy", "gateway", "reverse proxy", "代理", "网关", "反向代理"] },
  { token: "server_lag", pattern: /(?:服务器|服务端|实例|server|instance)[^，,；;。.!?\r\n]{0,28}(?:跟不上|卡顿|延迟|lag(?:ging)?|behind)|(?:跟不上|卡顿|延迟|lag(?:ging)?|behind)[^，,；;。.!?\r\n]{0,28}(?:服务器|服务端|实例|server|instance)/i, terms: ["can't keep up", "cannot keep up", "server is behind", "running behind", "tick took", "服务器跟不上", "服务端跟不上", "卡顿"] },
  { token: "memory_resource", pattern: /(?:内存|堆空间|垃圾回收|memory|heap|garbage\s+collection|\bgc\b)/i, terms: ["memory", "heap", "outofmemory", "gc overhead", "garbage collection", "内存", "堆空间", "垃圾回收"] },
  { token: "world_storage", pattern: /(?:世界|区块|区域文件|存档|world|chunk|region|level|world\s+storage)/i, terms: ["world", "chunk", "region", "level", "storage", "世界", "区块", "区域文件", "存档"] },
];

const eventDefinitions: MatchDefinition[] = [
  { token: "authentication_failure", pattern: /(?:认证|鉴权|登录|auth(?:entication)?|login).{0,20}(?:失败|拒绝|错误|fail(?:ed|ure)?|reject(?:ed)?|denied|error)|(?:失败|拒绝|fail(?:ed|ure)?|reject(?:ed)?|denied).{0,20}(?:认证|鉴权|登录|auth(?:entication)?|login)/i, terms: ["authentication failed", "login failed", "failed to authenticate", "认证失败", "鉴权失败", "登录失败"] },
  { token: "connection_failure", pattern: /(?:连接|联机|握手|connect(?:ion)?|handshake).{0,20}(?:失败|拒绝|重置|断开|fail(?:ed|ure)?|refused|reject(?:ed)?|reset|disconnect(?:ed)?)|(?:失败|拒绝|重置|断开|fail(?:ed|ure)?|refused|reject(?:ed)?|reset|disconnect(?:ed)?).{0,20}(?:连接|联机|握手|connect(?:ion)?|handshake)/i, terms: ["connection failed", "failed to connect", "connection refused", "handshake failed", "login failed", "连接失败", "拒绝连接", "握手失败", "登录失败"] },
  { token: "timeout", pattern: /(?:超时|timeout|timed[-\s]*out)/i, terms: ["timeout", "timed out", "timed-out", "超时"] },
  { token: "resource_failure", pattern: /(?:资源包|下载|resource\s*pack|download).{0,20}(?:失败|错误|fail(?:ed|ure)?|error)|(?:失败|错误|fail(?:ed|ure)?|error).{0,20}(?:资源包|下载|resource\s*pack|download)/i, terms: ["resource pack failed", "download failed", "资源包下载失败", "下载失败"] },
  { token: "permission_failure", pattern: /(?:权限|permission|access).{0,20}(?:被拒|拒绝|失败|不足|denied|reject(?:ed)?|fail(?:ed|ure)?)|(?:被拒|拒绝|失败|不足|denied|reject(?:ed)?|fail(?:ed|ure)?).{0,20}(?:权限|permission|access)/i, terms: ["permission denied", "access denied", "permission rejected", "权限被拒", "权限拒绝", "权限不足", "拒绝访问"] },
  { token: "disconnect", pattern: /(?:掉线|断开|disconnect(?:ed)?|connection\s+closed)/i, terms: ["disconnected", "disconnect", "connection closed", "断开连接", "掉线"] },
  { token: "warning", pattern: /(?:警告|warn(?:ing)?)/i, terms: ["warn", "warning", "警告"] },
  { token: "crash", pattern: /(?:崩服|崩溃|crash(?:ed|es)?|fatal)/i, terms: ["crash", "fatal", "崩溃", "崩服"] },
  { token: "error", pattern: /(?:报错|错误|exception|error)/i, terms: ["error", "exception", "错误", "报错"] },
  { token: "initialization_failure", pattern: /(?:加载|初始化|启动|启用|load(?:ing)?|initiali[sz](?:e|ed|ation)?|startup|start(?:ing)?|enable(?:d)?).{0,24}(?:失败|错误|无法|不能|fail(?:ed|ure|ures)?|error|unable|could\s+not)|(?:失败|错误|无法|不能|fail(?:ed|ure|ures)?|error|unable|could\s+not).{0,24}(?:加载|初始化|启动|启用|load(?:ing)?|initiali[sz](?:e|ed|ation)?|startup|start(?:ing)?|enable(?:d)?)/i, terms: ["failed to load", "load failed", "failed to initialize", "initialization failed", "unable to initialize", "startup failed", "startup failure", "could not enable", "加载失败", "初始化失败", "启动失败", "无法加载", "无法初始化"] },
  { token: "dependency_missing", pattern: /(?:依赖|前置|dependency|dependencies|prerequisite).{0,24}(?:缺失|缺少|未找到|不满足|不可用|missing|not\s+found|unsatisfied|unavailable|required)|(?:缺失|缺少|未找到|不满足|missing|not\s+found|unsatisfied|unavailable).{0,24}(?:依赖|前置|dependency|dependencies|prerequisite)/i, terms: ["missing dependency", "dependency missing", "dependency not found", "unsatisfied dependency", "required dependency", "dependencies unavailable", "依赖缺失", "缺少依赖", "未找到依赖", "依赖不满足"] },
  { token: "response_failure", pattern: /(?:响应|返回|response|reply).{0,20}(?:畸形|无效|错误|malformed|invalid|error|failed)|(?:畸形|无效|malformed|invalid).{0,20}(?:响应|返回|response|reply)/i, terms: ["malformed response", "invalid response", "response error", "响应无效", "响应错误", "畸形响应"] },
  { token: "cannot_keep_up", pattern: /(?:服务器|服务端)?\s*(?:跟不上|来不及处理)|(?:can(?:not|'t)\s+keep\s+up|running\s+behind|server\s+is\s+behind)/i, terms: ["can't keep up", "cannot keep up", "running behind", "server is behind", "服务器跟不上", "服务端跟不上", "来不及处理"] },
  { token: "tick_timeout", pattern: /(?:单个|单次|一个)?\s*(?:tick|游戏刻)[^，,；;。.!?\r\n]{0,24}(?:超时|耗时(?:过|太)长|timeout|timed[-\s]*out|times?\s+out|took\s+too\s+long)|(?:超时|耗时(?:过|太)长|timeout|timed[-\s]*out|times?\s+out|took\s+too\s+long)[^，,；;。.!?\r\n]{0,24}(?:tick|游戏刻)/i, terms: ["tick timeout", "tick timed out", "single tick took", "server tick took", "watchdog", "单个tick超时", "游戏刻超时"] },
  { token: "out_of_memory", pattern: /(?:内存不足|内存耗尽|内存分配失败|out[ -]?of[ -]?memory|outofmemory|memory\s+(?:allocation\s+)?fail(?:ed|ure)?|\boom\b)/i, terms: ["out of memory", "outofmemory", "memory allocation failed", "内存不足", "内存耗尽", "内存分配失败"] },
  { token: "heap_exhaustion", pattern: /(?:堆(?:空间)?(?:耗尽|不足)|heap\s+(?:space|exhausted|exhaustion))/i, terms: ["java heap space", "heap space", "heap exhausted", "heap exhaustion", "堆空间耗尽", "堆空间不足"] },
  { token: "gc_overhead", pattern: /(?:(?:gc|垃圾回收)[^，,；;。.!?\r\n]{0,16}(?:开销过高|耗时过高|overhead(?:\s+limit)?(?:\s+exceeded)?)|(?:excessive|high)\s+(?:garbage[-\s]+collection|gc)\s+overhead)/i, terms: ["gc overhead limit exceeded", "gc overhead", "garbage collection overhead", "垃圾回收开销过高", "垃圾回收耗时过高", "GC开销过高"] },
  { token: "save_failure", pattern: /(?:世界|存档|world|level)[^，,；;。.!?\r\n]{0,24}(?:保存|写盘|save|saving)[^，,；;。.!?\r\n]{0,16}(?:失败|错误|fail(?:ed|ure)?|error)|(?:failed|unable|error)[^，,；;。.!?\r\n]{0,20}(?:(?:save|saving)[^，,；;。.!?\r\n]{0,16}(?:world|level)|(?:world|level)[^，,；;。.!?\r\n]{0,16}(?:save|saving))/i, terms: ["failed to save world", "world save failed", "unable to save level", "save failure", "世界保存失败", "存档保存失败"] },
  { token: "chunk_corruption", pattern: /(?:区块|区域文件|chunk|region)[^，,；;。.!?\r\n]{0,20}(?:损坏|损毁|corrupt(?:ed|ion)?|malformed)|(?:损坏|损毁|corrupt(?:ed|ion)?|malformed)[^，,；;。.!?\r\n]{0,20}(?:区块|区域文件|chunk|region)/i, terms: ["chunk corrupted", "corrupt chunk", "region corrupted", "corrupt region", "区块损坏", "区域文件损坏"] },
  { token: "chunk_read_failure", pattern: /(?:区块|区域文件|chunk|region)[^，,；;。.!?\r\n]{0,24}(?:读取|加载|read|load)[^，,；;。.!?\r\n]{0,16}(?:失败|错误|异常|fail(?:ed|ure)?|error|exception)|(?:failed|unable|error|exception)[^，,；;。.!?\r\n]{0,20}(?:read|load)[^，,；;。.!?\r\n]{0,16}(?:chunk|region)/i, terms: ["failed to read chunk", "chunk read failed", "unable to load chunk", "region read error", "区块读取失败", "区块读取异常", "区域文件读取失败"] },
];

const definitions = [...subjectDefinitions, ...eventDefinitions];
const knownTokens = new Set(["all", ...definitions.map((item) => item.token)]);
const subjectTokens = new Set(subjectDefinitions.map((item) => item.token));
// Bounded named-plugin literals let activation verification target specific
// startup lines without broadening tool arguments to arbitrary search strings.
export const LOG_FILTER_CONDITION_TOKENS = [...knownTokens, "literal:Essentials", "literal:LuckPerms"].sort();

export function compileLogFilterQuery(intent: string): LogFilterQueryV1 {
  const subjects = matchingDefinitions(intent, subjectDefinitions).map((item) => item.token);
  const eventMatches = matchingDefinitions(intent, eventDefinitions);
  let events = eventDefinitions.filter((definition) => eventMatches.some((match) => match.token === definition.token)).map((definition) => definition.token);
  if (events.some((token) => token !== "error")) events = events.filter((token) => token !== "error");
  if (events.includes("tick_timeout")) events = events.filter((token) => token !== "timeout");
  if (events.includes("disconnect") && !/(?:连接|联机|握手|connect(?:ion)?|handshake).{0,16}(?:失败|拒绝|fail(?:ed|ure)?|refused|reject(?:ed)?)|(?:失败|拒绝|fail(?:ed|ure)?|refused|reject(?:ed)?).{0,16}(?:连接|联机|握手|connect(?:ion)?|handshake)/i.test(intent)) {
    events = events.filter((token) => token !== "connection_failure");
  }
  const literalMatches = [...intent.matchAll(/["'“”]([^"'“”]{2,48})["'“”]/g)].map((match) => ({
    token: `literal:${match[1].trim()}`,
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  events.push(...literalMatches.map((match) => match.token));
  const allOf = [...subjects];
  const anyOf: string[] = [];
  if (events.length === 1) {
    allOf.push(events[0]);
  } else if (events.length > 1) {
    const spans = [...eventMatches, ...literalMatches];
    const start = Math.min(...spans.map((item) => item.start));
    const end = Math.max(...spans.map((item) => item.end));
    const connector = intent.slice(start, end);
    if (/(?:或者|或是|或|\bor\b)/i.test(connector)) anyOf.push(...events);
    else allOf.push(...events);
  }
  if (!allOf.length && !anyOf.length) allOf.push("all");
  const groups = [{ all_of: stableUnique(allOf), any_of: stableUnique(anyOf) }];
  const base = { schema_version: "log-filter-query/v1" as const, groups };
  return { ...base, digest: digestLogFilterQuery(base) };
}

export function logEventFilters(query: LogFilterQueryV1) {
  return stableUnique(query.groups.flatMap((group) => [...group.all_of, ...group.any_of]).filter((token) => !subjectTokens.has(token) && token !== "all"));
}

export function canonicalizeLogFilterGroups(groups: unknown):
  | { ok: true; query: LogFilterQueryV1 }
  | { ok: false; reason: string } {
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 4) return { ok: false, reason: "invalid log filter group count" };
  const normalized: LogFilterGroupV1[] = [];
  for (const raw of groups) {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "invalid log filter group" };
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["all_of", "any_of"].includes(key))) return { ok: false, reason: "unknown log filter group field" };
    if (!Array.isArray(value.all_of) || !Array.isArray(value.any_of)
      || value.all_of.some((item) => typeof item !== "string")
      || value.any_of.some((item) => typeof item !== "string")) return { ok: false, reason: "invalid log filter group conditions" };
    let allOf = stableUnique(value.all_of as string[]);
    let anyOf = stableUnique(value.any_of as string[]);
    // Models commonly repeat the subject token in both fields. Keep the
    // mandatory subject and remove only its redundant event-side occurrence;
    // all remaining alternatives stay intact and are still validated.
    // `all` is the boolean identity. Reduce model-produced neutral terms to
    // the same canonical form before the strict provider envelope is sealed.
    if (allOf.includes("all") && (allOf.length > 1 || anyOf.length > 0)) {
      allOf = allOf.filter((token) => token !== "all");
    }
    if (anyOf.includes("all")) anyOf = [];
    // An event repeated in an OR list is an alternative, not an extra
    // mandatory condition. Keeping it in all_of turns "error OR warning"
    // into "error AND warning" and can hide every real log entry.
    allOf = allOf.filter((token) => subjectTokens.has(token) || !anyOf.includes(token));
    anyOf = anyOf.filter((token) => !allOf.includes(token));
    if (!allOf.length && !anyOf.length) allOf = ["all"];
    const tokens = [...allOf, ...anyOf];
    if (tokens.length < 1 || tokens.length > 8) return { ok: false, reason: "invalid log filter group size" };
    if (tokens.some((token) => !validToken(token))) return { ok: false, reason: "unknown or unsafe log filter condition" };
    if (tokens.includes("all") && tokens.length !== 1) return { ok: false, reason: "all cannot be combined with another condition" };
    normalized.push({ all_of: [...allOf], any_of: [...anyOf] });
  }
  const base = { schema_version: "log-filter-query/v1" as const, groups: normalized };
  return { ok: true, query: { ...base, digest: digestLogFilterQuery(base) } };
}

export function validateLogFilterQuery(query: LogFilterQueryV1): { ok: true } | { ok: false; reason: string } {
  if (!query || query.schema_version !== "log-filter-query/v1" || !Array.isArray(query.groups) || query.groups.length < 1 || query.groups.length > 4) return { ok: false, reason: "invalid log filter query envelope" };
  for (const group of query.groups) {
    if (!Array.isArray(group.all_of) || !Array.isArray(group.any_of) || group.all_of.length + group.any_of.length < 1 || group.all_of.length + group.any_of.length > 8) return { ok: false, reason: "invalid log filter group" };
    const tokens = [...group.all_of, ...group.any_of];
    if (new Set(tokens).size !== tokens.length || group.all_of.some((token) => group.any_of.includes(token))) return { ok: false, reason: "duplicate log filter condition" };
    if (tokens.some((token) => !validToken(token))) return { ok: false, reason: "unknown or unsafe log filter condition" };
  }
  const expected = digestLogFilterQuery({ schema_version: query.schema_version, groups: query.groups });
  return query.digest === expected ? { ok: true } : { ok: false, reason: "log filter query digest mismatch" };
}

export function matchesLogFilterQuery(line: string, query: LogFilterQueryV1) {
  if (!validateLogFilterQuery(query).ok) return false;
  return query.groups.some((group) => group.all_of.every((token) => matchesCondition(line, token))
    && (group.any_of.length === 0 || group.any_of.some((token) => matchesCondition(line, token))));
}

function matchingDefinitions(intent: string, values: MatchDefinition[]) {
  return values.flatMap((definition) => {
    const match = definition.pattern.exec(intent);
    return match ? [{ token: definition.token, start: match.index, end: match.index + match[0].length }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
}

function matchesCondition(line: string, token: string) {
  if (token === "all") return true;
  const lower = line.toLowerCase();
  const terms = token.startsWith("literal:") ? [token.slice("literal:".length)] : definitions.find((item) => item.token === token)?.terms ?? [];
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function validToken(token: string) {
  return knownTokens.has(token) || token.startsWith("literal:") && token.length > 8 && [...token].length <= 64 && !/[\u0000-\u001f\u007f]/u.test(token);
}

function digestLogFilterQuery(value: { schema_version: "log-filter-query/v1"; groups: LogFilterGroupV1[] }) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableUnique<T>(values: T[]) { return [...new Set(values)]; }
