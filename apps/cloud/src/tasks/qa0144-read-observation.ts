import { createHash } from "node:crypto";
import type { AgentLoopObservation, AgentLoopToolName } from "../chat/agent-loop";

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

export function groundedQa0144WebFinal(answer: string, observations: AgentLoopObservation[]) {
  if (!answer || answer.length > 4_000 || observations.length === 0) return false;
  const results = observations.map((item) => plainObject(item.data) ? item.data.qa0144_read_result : undefined);
  if (results.some((item) => !plainObject(item) || item.output_schema_id !== "web-search-result/v1" || !plainObject(item.value))) return false;
  const allowed = results.flatMap((item) => ((item as Qa0144ReadResult).value.results as Record<string, unknown>[]).map((result) => String(result.url)));
  const cited = answer.match(/https?:\/\/[^\s)\]}>，。；、]+/giu) ?? [];
  return cited.length > 0 && cited.every((url) => allowed.includes(url));
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
