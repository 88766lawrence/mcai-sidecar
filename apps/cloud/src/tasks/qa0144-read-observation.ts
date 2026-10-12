import { webSearchUrlWithinScope } from "../chat/web-search-scope";
import { createHash } from "node:crypto";
import type { AgentLoopDecision, AgentLoopObservation, AgentLoopToolName } from "../chat/agent-loop";

const digestDomain = "read-tool-result/v1\0";

export interface Qa0144ReadResult {
  schema_version: "qa0144-read-result/v1";
  output_schema_id: "config-inspect-result/v1" | "files-list-result/v1" | "logs-query-result/v1" | "web-search-result/v1";
  value: Record<string, unknown>;
}

export function projectQa0144ReadResult(input: {
  tool: AgentLoopToolName;
  arguments: Record<string, unknown>;
  observedValues: unknown[];
}): Qa0144ReadResult | undefined {
  const expected = input.tool === "config.inspect" ? "config-inspect-result/v1"
    : input.tool === "files.list" ? "files-list-result/v1"
      : input.tool === "logs.query" ? "logs-query-result/v1"
        : input.tool === "web.search" ? "web-search-result/v1"
          : undefined;
  if (!expected) return undefined;
  const matches = input.observedValues.filter((value) => plainObject(value) && value.schema_version === expected) as Record<string, unknown>[];
  const distinct = [...new Map(matches.map((value) => [JSON.stringify(value), value])).values()];
  if (distinct.length !== 1) return undefined;
  const value = distinct[0];
  const valid = expected === "config-inspect-result/v1" ? validConfig(value, input.arguments)
    : expected === "files-list-result/v1" ? validFiles(value, input.arguments)
      : expected === "logs-query-result/v1" ? validLogs(value, input.arguments)
        : validWeb(value, input.arguments);
  return valid ? { schema_version: "qa0144-read-result/v1", output_schema_id: expected, value: structuredClone(value) } : undefined;
}

export function renderQa0144ReadFinal(message: string, observations: AgentLoopObservation[]) {
  if (observations.length === 0 || observations.some((item) => item.status !== "succeeded")) return undefined;
  const projected = observations.map(readResultForObservation);
  if (projected.some((item) => !item)) return undefined;
  const chinese = /[\u3400-\u9fff]/u.test(message);
  const facts: string[] = [];
  for (const item of projected as Qa0144ReadResult[]) {
    const value = item.value;
    if (item.output_schema_id === "config-inspect-result/v1") {
      for (const entry of value.entries as Record<string, unknown>[]) {
        if (!entry.present) facts.push(chinese ? `${value.path} 中未设置 ${entry.key}。` : `${entry.key} is not set in ${value.path}.`);
        else if (entry.redacted === true) facts.push(chinese ? `${value.path} 中存在 ${entry.key}，其值已隐藏。` : `${entry.key} is present in ${value.path}; its value is redacted.`);
        else facts.push(chinese ? `${value.path} 中 ${entry.key} = ${String(entry.value)}。` : `${entry.key} = ${String(entry.value)} in ${value.path}.`);
      }
    } else if (item.output_schema_id === "files-list-result/v1") {
      const names = (value.entries as Record<string, unknown>[]).map((entry) => String(entry.name));
      const suffix = typeof value.suffix === "string" ? value.suffix : undefined;
      facts.push(chinese
        ? `${value.path} 目录共 ${value.total} 项；${suffix ? `按 ${suffix} 筛选后有` : "本次返回"} ${value.filtered_count} 项${names.length ? `：${names.join("、")}` : "。"}`
        : `${value.path} contains ${value.total} entries; ${suffix ? `${value.filtered_count} match ${suffix}` : `${value.filtered_count} returned`}${names.length ? `: ${names.join(", ")}` : "."}`);
    } else if (item.output_schema_id === "logs-query-result/v1") {
      const samples = value.samples as string[];
      const omitted = Number(value.matches) - samples.length;
      facts.push(chinese
        ? `日志匹配 ${value.matches} 条；展示 ${samples.length} 条样本；剩余 ${omitted} 条未展示。`
        : `Log matches: ${value.matches}; shown samples: ${samples.length}; not shown: ${omitted}.`);
      if (samples.length) facts.push(chinese ? `展示样本：\n${samples.map((sample) => `  - ${sample}`).join("\n")}` : `Shown samples:\n${samples.map((sample) => `  - ${sample}`).join("\n")}`);
    } else {
      const results = value.results as Record<string, unknown>[];
      facts.push((chinese ? "搜索结果：\n" : "Search results:\n") + results.slice(0, 5)
        .map((result) => `${result.title}\n${result.snippet}\n${result.url}`).join("\n\n"));
    }
  }
  return `${chinese ? "根据已完成的只读检查：" : "Based on the completed read-only checks:"}\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
}

function readResultForObservation(item: AgentLoopObservation): Qa0144ReadResult | undefined {
  if (!plainObject(item.data)) return undefined;
  const expected = item.tool === "config.inspect" ? "config-inspect-result/v1"
    : item.tool === "files.list" ? "files-list-result/v1"
      : item.tool === "logs.query" ? "logs-query-result/v1"
        : item.tool === "web.search" ? "web-search-result/v1"
          : undefined;
  if (!expected) return undefined;
  const direct = item.data.qa0144_read_result;
  if (plainObject(direct) && direct.schema_version === "qa0144-read-result/v1"
    && direct.output_schema_id === expected && plainObject(direct.value)) {
    return direct as unknown as Qa0144ReadResult;
  }
  if (!Array.isArray(item.data.observations)) return undefined;
  const matches = item.data.observations.flatMap((entry) => plainObject(entry)
    && plainObject(entry.observed) && entry.observed.schema_version === expected
    ? [entry.observed] : []);
  const distinct = [...new Map(matches.map((value) => [JSON.stringify(value), value])).values()];
  if (distinct.length !== 1) return undefined;
  return {
    schema_version: "qa0144-read-result/v1",
    output_schema_id: expected,
    value: structuredClone(distinct[0]!),
  };
}

// URL membership is only a structural citation check, never proof of a claim.
export function hasObservedWebLinks(answer: string, observations: AgentLoopObservation[]) {
  const urls = observations.filter((item) => item.tool === "web.search" && item.status === "succeeded")
    .flatMap((item) => {
      const read = readResultForObservation(item);
      return read && Array.isArray(read.value.results) ? read.value.results.filter(plainObject).map((result) => String(result.url)) : [];
    });
  const cited = answer.match(/https?:\/\/[^\s)\]}>，。；、]+/giu) ?? [];
  return cited.length > 0 && cited.every((url) => urls.includes(url));
}

export function validatedWebSourcePage(value: unknown, resultUrl: string) {
  if (!plainObject(value) || !["read", "unavailable", "not-read"].includes(String(value.status))) return undefined;
  if (value.status !== "read") return { status: String(value.status) };
  if (!bounded(value.url, 1, 2_048) || !safeUrl(String(value.url))
    || new URL(String(value.url)).hostname !== new URL(resultUrl).hostname
    || !bounded(value.fetched_at, 1, 40) || !Number.isFinite(Date.parse(String(value.fetched_at)))
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Array.isArray(value.passages) || value.passages.length < 1 || value.passages.length > 3
    || !value.passages.every((text) => bounded(text, 30, 1_200))) return undefined;
  return { status: "read", url: value.url, fetched_at: value.fetched_at, sha256: value.sha256, passages: value.passages as string[] };
}

export function renderWebSourceFinal(message: string, observations: AgentLoopObservation[]) {
  if (!observations.length || observations.some((item) => item.tool !== "web.search")) return undefined;
  const results = [...observations].reverse().filter((item) => item.status === "succeeded").flatMap((item) => {
    const projected = readResultForObservation(item);
    return projected && Array.isArray(projected.value.results) ? projected.value.results.filter(plainObject).filter((result) => typeof result.url === "string" && webSearchUrlWithinScope(result.url, message)) : [];
  });
  const preferred = new Map<unknown, Record<string, unknown>>();
  for (const result of results) {
    const previous = preferred.get(result.url);
    // Prefer the most recent query; an unread duplicate must not erase an
    // earlier verified page retrieval.
    const previousRead = typeof previous?.url === "string" && validatedWebSourcePage(previous.page, previous.url)?.status === "read";
    const currentRead = typeof result.url === "string" && validatedWebSourcePage(result.page, result.url)?.status === "read";
    if (!previous || (!previousRead && currentRead)) preferred.set(result.url, result);
  }
  const unique = [...preferred.values()];
  const read = unique.flatMap((result) => {
    if (typeof result.url !== "string" || !safeUrl(result.url)) return [];
    const page = validatedWebSourcePage(result.page, result.url);
    return page?.status === "read" && page.passages ? [{ result, page }] : [];
  }).slice(0, 3);
  const chinese = /[\u3400-\u9fff]/u.test(message);
  const literal = (text: string) => text.replace(/[\\`*_{}\[\]()<>!#]/gu, "\\$&");
  if (!unique.length) return chinese ? "本轮网页检索失败，没有取得可核验的来源；无法确认所询问的文档、版本或建议。" : "The web lookup failed; no verifiable source was retrieved, so the requested documentation, versions or advice could not be confirmed.";
  if (!read.length) return (chinese ? "已找到候选链接，但未取得可核验的相关正文；以下仅为检索结果，不能据此确认版本兼容或操作建议：\n" : "Candidate links were discovered, but no relevant page text was retrieved. These results do not verify compatibility or instructions:\n")
    + unique.slice(0, 3).map((result) => `${literal(String(result.title))}\n${String(result.url)}`).join("\n\n");
  return (chinese ? "已读取来源正文，以下为与查询相关的原文摘录（仅代表所读段落，未据此确认某个插件的版本兼容性）：\n\n" : "Retrieved source passages relevant to the query (limited excerpts; these do not verify a specific plugin's version compatibility):\n\n")
    + read.map(({ result, page }) => `[${literal(String(result.title))}](${String(page.url).replace(/\)/gu, "%29")})\n`
      + page.passages!.map((text) => `> ${literal(text)}`).join("\n>\n")
      + (chinese ? `\n读取时间：${page.fetched_at}` : `\nRetrieved: ${page.fetched_at}`)).join("\n\n");
}

export function publicSourceSearchCompletion(message: string, observations: AgentLoopObservation[]): { decision: AgentLoopDecision; verified: boolean } | undefined {
  if (!/(?:搜索|检索|网上|网络|文档|\b(?:search|web|documentation|docs|look up)\b)/iu.test(message)
    || !observations.length || observations.some((item) => item.tool !== "web.search")) return undefined;
  const affirmative = message.replace(/(?:先别|不要|不必|无需|别|不)\s*(?:安装|下载|重启|更新|修改|配置|执行)/gu, "")
    .replace(/(?:do not|don't|without)\s+(?:install|download|restart|update|modify|configure|execute)/giu, "");
  if (/(?:并|然后|接着|再|帮我|替我).{0,24}(?:安装|装上|部署|重启|停服|开服|修改|执行|下载)|把.{0,60}(?:改成|设置成)|\b(?:and|then|afterwards)\s+(?:install|deploy|restart|stop|start|configure|change|set|update|download|execute)\b/iu.test(affirmative)) return undefined;
  const pages = observations.filter((item) => item.status === "succeeded").flatMap((item) => {
    const read = readResultForObservation(item);
    return read && Array.isArray(read.value.results) ? read.value.results.filter(plainObject) : [];
  });
  // Older agents only supply discovery snippets; their existing continuation
  // remains available. The new source-reading pipeline is already bounded.
  if (!pages.some((page) => page.page != null) && observations.some((item) => item.status === "succeeded")) return undefined;
  const answer = renderWebSourceFinal(message, observations);
  if (!answer) return undefined;
  const verified = pages.some((page) => typeof page.url === "string" && webSearchUrlWithinScope(page.url, message) && validatedWebSourcePage(page.page, page.url)?.status === "read");
  return { verified, decision: verified
    ? { action: "final", answer, citations: observations.filter((item) => item.status === "succeeded").map((item) => item.tool_call_id) }
    : { action: "cannot_proceed", answer } };
}

function validConfig(value: Record<string, unknown>, args: Record<string, unknown>) {
  const path = canonicalPath(args.path, false);
  const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
  if (!path || value.path !== path || !Array.isArray(value.entries) || value.entries.length !== keys.length || !validDigest(value)) return false;
  return value.entries.every((entry, index) => plainObject(entry) && entry.key === keys[index] && typeof entry.present === "boolean"
    && (!entry.present ? exactKeys(entry, ["key", "present"])
      : entry.redacted === true ? exactKeys(entry, ["key", "present", "redacted"])
        : exactKeys(entry, ["key", "present", "value"]) && ["string", "number", "boolean"].includes(typeof entry.value)));
}

function validFiles(value: Record<string, unknown>, args: Record<string, unknown>) {
  const path = canonicalPath(args.path ?? "/", true);
  const suffix = args.suffix === undefined ? undefined : String(args.suffix);
  if (!path || value.path !== path || value.truncated !== false || !integer(value.total) || Number(value.total) > 200
    || !integer(value.filtered_count) || Number(value.filtered_count) > Number(value.total) || !Array.isArray(value.entries)
    || value.entries.length !== value.filtered_count || value.suffix !== suffix || !validDigest(value)) return false;
  const names = new Set<string>();
  return value.entries.every((entry) => plainObject(entry) && exactKeys(entry, ["name"]) && safeName(entry.name)
    && !names.has(String(entry.name)) && (names.add(String(entry.name)), !suffix || String(entry.name).toLowerCase().endsWith(suffix.toLowerCase())));
}

function validLogs(value: Record<string, unknown>, args: Record<string, unknown>) {
  const filter = plainObject(args.filter_query) ? args.filter_query : undefined;
  return exactKeys(value, ["schema_version", "matches", "window_minutes", "scanned_lines", "samples", "query_digest"])
    && integer(value.matches) && integer(value.scanned_lines) && value.window_minutes === args.window_minutes
    && Array.isArray(value.samples) && value.samples.length <= 5 && value.samples.every((item) => bounded(item, 1, 2_000))
    && Number(value.matches) >= value.samples.length && typeof filter?.digest === "string" && value.query_digest === filter.digest;
}

function validWeb(value: Record<string, unknown>, args: Record<string, unknown>) {
  if (value.query !== args.query || !bounded(value.provider, 1, 64) || !Array.isArray(value.results) || value.results.length < 1 || value.results.length > 10) return false;
  return value.results.every((item) => plainObject(item) && bounded(item.title, 1, 300) && bounded(item.url, 1, 2_048)
    && bounded(item.snippet, 1, 1_200) && typeof item.date === "string" && item.date.length <= 100 && safeUrl(String(item.url)));
}

function validDigest(value: Record<string, unknown>) {
  if (typeof value.result_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.result_digest)) return false;
  const copy = structuredClone(value); delete copy.result_digest;
  return createHash("sha256").update(digestDomain).update(JSON.stringify(copy)).digest("hex") === value.result_digest;
}

function canonicalPath(value: unknown, allowRoot: boolean) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\\:\0\r\n]/u.test(value)) return undefined;
  const segments = value.replace(/^\/+|\/+$/gu, "").split("/");
  if (segments.some((part) => part === "..")) return undefined;
  const clean = segments.filter((part) => part && part !== ".").join("/");
  return clean || (allowRoot ? "." : undefined);
}
function integer(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0; }
function bounded(value: unknown, min: number, max: number) { return typeof value === "string" && value.length >= min && value.length <= max; }
function safeName(value: unknown) { return bounded(value, 1, 255) && value !== "." && value !== ".." && !/[\\/\0\r\n]/u.test(String(value)); }
function safeUrl(value: string) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; } }
function plainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]) { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
