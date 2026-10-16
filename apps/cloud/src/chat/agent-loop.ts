import { intrinsicToolPolicy, policyTarget, type ToolPolicy } from "@mcai/contracts";
import { canonicalizeLogFilterGroups, logEventFilters, LOG_FILTER_CONDITION_TOKENS } from "../tasks/log-filter-query";

export const AGENT_LOOP_SCHEMA_VERSION = "agent-loop-decision/v1" as const;
export const AGENT_LOOP_MAX_ROUNDS = 16;
export const AGENT_LOOP_MAX_TOOL_CALLS = 19;

export const AGENT_LOOP_TOOL_CATALOG = [
  tool("console.command", "Run one canonical Minecraft console command. Read-only examples include version, list, plugins, tps, mspt, and gamerule <rule>. TPS and MSPT are separate observations, so call them one at a time. Writes remain subject to canonical risk and confirmation policy.", {
    type: "object", additionalProperties: false, required: ["command"],
    properties: { command: { type: "string", minLength: 1, maxLength: 256 } },
  }),
  tool("config.inspect", "Read exact keys and their current values from one instance configuration file. For Java servers, view-distance, simulation-distance, white-list, online-mode, motd and max-players belong to the root server.properties file. Read all requested keys together. Inspect first when a change depends on the existing value.", {
    type: "object", additionalProperties: false, required: ["path", "keys"],
    properties: { path: { type: "string" }, keys: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } } },
  }),
  tool("files.list", "List entries in one safe instance-relative directory. Use '.' for the instance root; never use '/', a drive path, URL, or parent traversal.", {
    type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, suffix: { type: "string", pattern: "^\\.[A-Za-z0-9_-]{1,32}$" } },
  }),
  tool("logs.query", "Read a bounded recent-log window. filter_query.groups is OR across groups; within each group every all_of condition is required and at least one any_of condition is required. Use separate groups for unrelated alternatives; the schema permits at most 4 groups and at most 8 distinct condition tokens per group. Do not provide schema_version, digest, regex, pattern, or raw search terms.", {
    type: "object", additionalProperties: false, required: ["window_minutes", "max_lines", "filter_query"],
    properties: {
      window_minutes: { type: "integer", minimum: 1, maximum: 1440 },
      max_lines: { type: "integer", minimum: 1, maximum: 1000 },
      filter_query: {
        type: "object", additionalProperties: false, required: ["groups"],
        properties: {
          groups: {
            type: "array", minItems: 1, maxItems: 4,
            items: {
              type: "object", additionalProperties: false, required: ["all_of", "any_of"],
              properties: {
                all_of: { type: "array", minItems: 0, maxItems: 8, uniqueItems: true, items: { enum: LOG_FILTER_CONDITION_TOKENS } },
                any_of: { type: "array", minItems: 0, maxItems: 8, uniqueItems: true, items: { enum: LOG_FILTER_CONDITION_TOKENS } },
              },
            },
          },
        },
      },
    },
  }),
  tool("instance.metrics", "Read process uptime, CPU, memory, and optional authoritative capacity. This tool does not provide Minecraft TPS or MSPT.", {
    type: "object", additionalProperties: false, required: ["schema_version", "metrics", "include_capacity"],
    properties: { schema_version: { const: "instance-metrics/v2" }, metrics: { type: "array", minItems: 1, maxItems: 3, items: { enum: ["uptime", "cpu", "memory"] } }, include_capacity: { type: "boolean" } },
  }),
  tool("players.inspect", "Read the bounded first-online-player gamemode projection.", {
    type: "object", additionalProperties: false, required: ["schema_version", "selector", "fields"],
    properties: { schema_version: { const: "players-inspect/v1" }, selector: { const: "first-online" }, fields: { const: ["gamemode"] } },
  }),
  tool("plugin.resolve", "Resolve plugin metadata only; never download or install bytes.", {
    type: "object", additionalProperties: false, required: ["project", "source", "platform", "minecraft_version", "loader"],
    properties: { project: { type: "string" }, source: { type: "string" }, platform: { type: "string" }, minecraft_version: { type: "string" }, loader: { type: "string" } },
  }),
  tool("web.search", "Search the public web for current or external information. Use it when freshness or facts outside the managed server matter; do not use it for ordinary conversation or stable knowledge.", {
    type: "object", additionalProperties: false, required: ["query"],
    properties: { query: { type: "string", minLength: 1, maxLength: 400 } },
  }),
  tool("file.download", "Download one task-relevant public HTTP(S) resource into a new file under the inert downloads/ staging directory. The AI may choose any public source; there is no repository or domain allowlist. This never overwrites, installs, extracts, executes, starts, stops, or restarts anything. sha256 is optional source integrity input; the result always includes byte-exact size and SHA-256 evidence.", {
    type: "object", additionalProperties: false, required: ["url", "target"],
    properties: {
      url: { type: "string", minLength: 8, maxLength: 2048 },
      target: { type: "string", minLength: 1, maxLength: 256 },
      sha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
    },
  }),
  tool("config.patch", "Apply bounded configuration changes after confirmation. Supply the instance-relative file path and exact key/value changes; Cloud binds the current instance revision. Inspect first when the existing value or path is uncertain.", {
    type: "object", additionalProperties: false, required: ["path", "patch"],
    properties: {
      path: { type: "string" },
      patch: { type: "array", minItems: 1, maxItems: 16, items: {
        type: "object", additionalProperties: false, required: ["op", "key", "value"],
        properties: { op: { enum: ["add", "replace"] }, key: { type: "string", minLength: 1, maxLength: 240 }, value: {} },
      } },
    },
  }),
  tool("plugin.install", "Install one previously resolved artifact after confirmation.", {
    type: "object", additionalProperties: false, required: ["project", "artifact_ref", "expected_integrity"],
    properties: {
      project: { type: "string" }, artifact_ref: { type: "string" },
      expected_integrity: {
        type: "object", additionalProperties: false, required: ["algorithm", "value"],
        properties: { algorithm: { enum: ["sha256", "sha512"] }, value: { type: "string" } },
      },
    },
  }),
  tool("instance.start", "Start the bound instance after confirmation.", lifecycleSchema()),
  tool("instance.stop", "Stop the bound instance after confirmation.", lifecycleSchema()),
  tool("instance.restart", "Restart the bound instance after confirmation.", lifecycleSchema()),
] as const;

export type AgentLoopToolName = typeof AGENT_LOOP_TOOL_CATALOG[number]["name"];
export type AgentLoopToolCall = {
  action: "tool_call";
  tool: AgentLoopToolName;
  arguments: Record<string, unknown>;
  reason: string;
};
export type AgentLoopDecision = AgentLoopToolCall
  | { action: "final"; answer: string; citations: string[] }
  | { action: "cannot_proceed"; answer: string };
export type AgentLoopObservation = {
  tool_call_id: string;
  tool: AgentLoopToolName;
  status: "succeeded" | "failed" | "indeterminate";
  data?: unknown;
  error?: { code: string; message: string };
  retryable: boolean;
  side_effect: "none" | "possible" | "applied";
  evidence: { ids: string[]; summaries: string[] };
};

export type AgentLoopValidation<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function validateAgentLoopDecision(raw: unknown, successfulCallIds?: Iterable<string>): AgentLoopValidation<AgentLoopDecision> {
  if (!plainObject(raw)) return invalid("AGENT_LOOP_INVALID_JSON", "decision must be one JSON object");
  const value = raw as Record<string, unknown>;
  if (value.action === "tool_call") {
    if (!exactKeys(value, ["action", "tool", "arguments", "reason"])) return invalid("AGENT_LOOP_INVALID_SHAPE", "tool_call contains missing or unknown fields");
    const toolName = typeof value.tool === "string" ? value.tool : "";
    if (!AGENT_LOOP_TOOL_CATALOG.some((entry) => entry.name === toolName)) return invalid("AGENT_LOOP_UNKNOWN_TOOL", "tool is not registered");
    if (!plainObject(value.arguments) || !shortText(value.reason, 240)) return invalid("AGENT_LOOP_INVALID_SHAPE", "tool_call arguments or reason are invalid");
    return { ok: true, value: { action: "tool_call", tool: toolName as AgentLoopToolName, arguments: { ...(value.arguments as Record<string, unknown>) }, reason: String(value.reason).trim() } };
  }
  if (value.action === "final") {
    if (!exactKeys(value, ["action", "answer", "citations"]) || !shortText(value.answer, 4_000) || !Array.isArray(value.citations) || value.citations.some((item) => typeof item !== "string" || !item.trim())) return invalid("AGENT_LOOP_INVALID_FINAL", "final answer or citations are invalid");
    const citations = value.citations.map(String);
    if (new Set(citations).size !== citations.length) return invalid("AGENT_LOOP_INVALID_CITATION", "citations must be unique");
    if (successfulCallIds !== undefined) {
      const allowed = new Set(successfulCallIds);
      if (citations.length === 0) return invalid("AGENT_LOOP_EVIDENCE_REQUIRED", "a tool-backed final answer must cite successful observations");
      if (citations.some((id) => !allowed.has(id))) return invalid("AGENT_LOOP_INVALID_CITATION", "final cites an absent or unsuccessful tool call");
      if (citations.length !== allowed.size) return invalid("AGENT_LOOP_INCOMPLETE_CITATION", "final must account for every successful observation in the run");
    }
    const answer = String(value.answer).trim();
    const answerError = agentUserAnswerError(answer);
    if (answerError) return invalid(answerError, "final answer must be user-facing and terminal; use tool_call to continue work");
    return { ok: true, value: { action: "final", answer, citations } };
  }
  if (value.action === "cannot_proceed") {
    if (!exactKeys(value, ["action", "answer"]) || !shortText(value.answer, 4_000)) return invalid("AGENT_LOOP_INVALID_CANNOT_PROCEED", "cannot_proceed answer is invalid");
    const answer = String(value.answer).trim();
    const answerError = agentUserAnswerError(answer);
    if (answerError) return invalid(answerError, "cannot_proceed answer must be user-facing and terminal");
    return { ok: true, value: { action: "cannot_proceed", answer } };
  }
  return invalid("AGENT_LOOP_INVALID_ACTION", "action is unsupported");
}

export function agentUserAnswerError(answer: string) {
  const toolNames = AGENT_LOOP_TOOL_CATALOG.map((entry) => entry.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (new RegExp(`(?:^|[^A-Za-z0-9_.-])(?:${toolNames.join("|")})(?:$|[^A-Za-z0-9_.-])`, "iu").test(answer)) return "AGENT_LOOP_INTERNAL_TOOL_LEAK";
  const internalDetail = /(?:\bmcs:[A-Za-z0-9:_-]{12,}\b|(?:实例|instance)\s*[（(:]?\s*[a-f0-9]{8}(?:[a-f0-9]{8,}|…)|\b(?:[A-Za-z_$][\w$]*Exception|FileNotFoundException|stack\s*trace)\b|https?:\/\/\S+|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|(?:控制台|console)\s*(?:命令|command|输出|output|未返回))/iu;
  if (internalDetail.test(answer)) return "AGENT_LOOP_INTERNAL_DETAIL_LEAK";
  const futureAction = /(?:接下来|下面|然后|下一步|我(?:将|会)|将会|准备|改用|继续)[^。.!！\n]{0,48}(?:调用|查询|获取|读取|检查|执行|使用|命令)|\b(?:next|then|I\s*(?:will|'ll)|going\s+to)\b[^.!?\n]{0,64}\b(?:call|query|fetch|read|inspect|execute|use|run)\b/iu;
  return futureAction.test(answer) ? "AGENT_LOOP_NON_TERMINAL_FINAL" : undefined;
}

export function extractAgentLoopDecision(content: string, successfulCallIds?: Iterable<string>): AgentLoopValidation<AgentLoopDecision> {
  const objects = topLevelJsonObjects(content);
  if (objects.length !== 1) return invalid("AGENT_LOOP_JSON_OBJECT_COUNT", "model content must contain exactly one JSON object");
  try { return validateAgentLoopDecision(JSON.parse(objects[0]), successfulCallIds); }
  catch { return invalid("AGENT_LOOP_INVALID_JSON", "model content contains invalid JSON"); }
}

export function validateAgentToolCall(decision: AgentLoopToolCall, instanceRef: string, inventoryRevision?: string): AgentLoopValidation<AgentLoopToolCall & { policy: ToolPolicy; target: string }> {
  const args = canonicalArguments(decision.arguments);
  const schemaError = validateToolArguments(decision.tool, args, instanceRef, inventoryRevision);
  if (schemaError) return schemaError;
  const policy = intrinsicToolPolicy(decision.tool, args);
  if (policy.risk === "forbidden") return invalid("AGENT_LOOP_TOOL_RISK_REJECTED", "forbidden or unknown operations are not executable from the agent loop");
  return { ok: true, value: { ...decision, arguments: args, policy, target: policyTarget({ tool: decision.tool, args }) } };
}

export function bindAgentToolCallToObservations(decision: AgentLoopToolCall, observations: AgentLoopObservation[]) {
  if (decision.tool !== "plugin.install") return decision;
  const project = String(decision.arguments.project ?? "").toLowerCase();
  if (!project) return undefined;
  const candidates = new Map<string, {
    project: string;
    artifact_ref: string;
    expected_integrity: { algorithm: "sha256" | "sha512"; value: string };
    source_task_id: string;
    source_call_id: string;
  }>();
  for (const observation of observations) {
    if (observation.tool !== "plugin.resolve" || observation.status !== "succeeded" || !plainObject(observation.data)) continue;
    const taskId = typeof observation.data.task_id === "string" ? observation.data.task_id : "";
    const results = Array.isArray(observation.data.goal_results) ? observation.data.goal_results : [];
    const evidenceFacts = Array.isArray(observation.data.observations)
      ? observation.data.observations.filter(plainObject).map((item) => ({ observed: item.observed }))
      : [];
    for (const result of [...results, ...evidenceFacts]) {
      if (!plainObject(result) || !plainObject(result.observed)) continue;
      const fact = result.observed;
      const resolvedProject = String(fact.project ?? "").toLowerCase();
      const artifact = String(fact.artifact ?? "");
      const sha256 = String(fact.sha256 ?? "").toLowerCase();
      const sha512 = String(fact.source_sha512 ?? "").toLowerCase();
      if (resolvedProject !== project || !shortText(artifact, 512) || !taskId) continue;
      const integrity = /^[a-f0-9]{64}$/u.test(sha256)
        ? { algorithm: "sha256" as const, value: sha256 }
        : /^[a-f0-9]{128}$/u.test(sha512)
          ? { algorithm: "sha512" as const, value: sha512 }
          : undefined;
      if (!integrity) continue;
      const candidate = {
        project: resolvedProject,
        artifact_ref: artifact,
        expected_integrity: integrity,
        source_task_id: taskId,
        source_call_id: observation.tool_call_id,
      };
      candidates.set(JSON.stringify(canonical(candidate)), candidate);
    }
  }
  if (candidates.size !== 1) return undefined;
  return { ...decision, arguments: candidates.values().next().value! };
}

export function canonicalAgentToolCallKey(call: Pick<AgentLoopToolCall, "tool" | "arguments">) {
  return `${call.tool}:${JSON.stringify(canonical(call.arguments))}`;
}

function validateToolArguments(toolName: AgentLoopToolName, args: Record<string, unknown>, instanceRef: string, inventoryRevision?: string): AgentLoopValidation<never> | undefined {
  if (toolName === "console.command") {
    if (!exactKeys(args, ["command"]) || typeof args.command !== "string" || !args.command.trim() || args.command.length > 256 || /[\r\n\0]/u.test(args.command)) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "console.command requires one safe command string");
    args.command = args.command.trim().replace(/^\//u, "");
  } else if (toolName === "files.list") {
    const path = canonicalInstancePath(args.path, true);
    if (!onlyKeys(args, ["path", "suffix"]) || !path || args.suffix !== undefined && (typeof args.suffix !== "string" || !/^\.[A-Za-z0-9_-]{1,32}$/u.test(args.suffix))) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "files.list requires one safe instance path and optional suffix");
    args.path = path;
  } else if (toolName === "config.inspect") {
    const path = canonicalInstancePath(args.path);
    if (!exactKeys(args, ["path", "keys"]) || !path || !stringArray(args.keys, 1, 32, /^[A-Za-z0-9_.-]{1,128}$/u)) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "config.inspect path or keys are invalid");
    args.path = path;
  } else if (toolName === "logs.query") {
    if (Number.isInteger(args.max_lines) && Number(args.max_lines) > 1000) args.max_lines = 1000;
    if (!exactKeys(args, ["window_minutes", "max_lines", "filter_query"]) || !integer(args.window_minutes, 1, 1440) || !integer(args.max_lines, 1, 1000) || !plainObject(args.filter_query) || !exactKeys(args.filter_query, ["groups"])) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "logs.query requires bounds and filter_query.groups");
    const canonicalQuery = canonicalizeLogFilterGroups(args.filter_query.groups);
    if (!canonicalQuery.ok) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", canonicalQuery.reason);
    args.filter_query = canonicalQuery.query;
    args.filters = logEventFilters(canonicalQuery.query);
  } else if (toolName === "instance.metrics") {
    if (!exactKeys(args, ["schema_version", "metrics", "include_capacity"]) || args.schema_version !== "instance-metrics/v2" || !stringArray(args.metrics, 1, 3) || !(args.metrics as string[]).every((item) => ["uptime", "cpu", "memory"].includes(item)) || typeof args.include_capacity !== "boolean") return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "instance.metrics v2 arguments are invalid");
  } else if (toolName === "players.inspect") {
    if (JSON.stringify(canonical(args)) !== JSON.stringify(canonical({ schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] }))) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "players.inspect is limited to first-online gamemode");
  } else if (toolName === "plugin.resolve") {
    if (!exactKeys(args, ["project", "source", "platform", "minecraft_version", "loader"]) || !["project", "source", "platform", "minecraft_version", "loader"].every((key) => shortText(args[key], 128))) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "plugin.resolve metadata arguments are invalid");
    const project = String(args.project).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(project)) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "plugin.resolve project is not a safe project slug");
    args.project = project;
  } else if (toolName === "web.search") {
    if (!exactKeys(args, ["query"]) || !shortText(args.query, 400) || String(args.query).trim().split(/\s+/u).length > 50 || /[\u0000-\u001f\u007f]/u.test(String(args.query))) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "web.search query arguments are invalid");
    args.query = String(args.query).trim().replace(/\s+/gu, " ");
  } else if (toolName === "file.download") {
    const target = canonicalDownloadTarget(args.target);
    const canonicalURL = canonicalPublicDownloadURL(args.url);
    if (!onlyKeys(args, ["url", "target", "sha256"]) || !target || !canonicalURL
      || args.sha256 !== undefined && (typeof args.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(args.sha256))) {
      return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "file.download requires one public HTTP(S) URL, one new downloads/<filename> target, and an optional SHA-256");
    }
    args.url = canonicalURL;
    args.target = target;
    if (typeof args.sha256 === "string") args.sha256 = args.sha256.toLowerCase();
  } else if (toolName.startsWith("instance.")) {
    if (!onlyKeys(args, ["target", "timeout_seconds"]) || args.target !== instanceRef || args.timeout_seconds !== undefined && !integer(args.timeout_seconds, 1, 300)) return invalid("AGENT_LOOP_INSTANCE_SCOPE_MISMATCH", "lifecycle target must be the bound instance");
    args.target = instanceRef;
    args.timeout_seconds ??= 120;
  } else if (toolName === "config.patch") {
    const path = canonicalInstancePath(args.path);
    if (!exactKeys(args, ["path", "patch"]) || !path || !Array.isArray(args.patch) || args.patch.length < 1 || args.patch.length > 16
      || !shortText(inventoryRevision, 256)
      || !args.patch.every((item) => plainObject(item) && exactKeys(item, ["op", "key", "value"])
        && ["add", "replace"].includes(String(item.op)) && typeof item.key === "string"
        && item.key.length <= 240 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(item.key))
      || JSON.stringify(args.patch).length > 8_192) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "config.patch arguments are invalid");
    args.path = path;
    args.expected_revision = inventoryRevision;
  } else if (toolName === "plugin.install") {
    const integrity = plainObject(args.expected_integrity) ? args.expected_integrity : undefined;
    const algorithm = integrity?.algorithm;
    const hashLength = algorithm === "sha256" ? 64 : algorithm === "sha512" ? 128 : 0;
    if (!onlyKeys(args, ["project", "artifact_ref", "expected_integrity", "source_task_id", "source_call_id"]) || !["project", "artifact_ref", "expected_integrity", "source_task_id", "source_call_id"].every((key) => key in args) || !shortText(args.project, 128) || !shortText(args.artifact_ref, 512) || !integrity || !exactKeys(integrity, ["algorithm", "value"]) || typeof integrity.value !== "string" || !new RegExp(`^[a-f0-9]{${hashLength}}$`, "iu").test(integrity.value) || !shortText(args.source_task_id, 128) || !shortText(args.source_call_id, 128)) return invalid("AGENT_LOOP_INVALID_ARGUMENTS", "plugin.install arguments are invalid");
  }
  return undefined;
}

function topLevelJsonObjects(value: string) {
  const results: string[] = [];
  let start = -1; let depth = 0; let quoted = false; let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === "\"") quoted = false; continue; }
    if (char === "\"") { quoted = true; continue; }
    if (char === "{") { if (depth === 0) start = index; depth += 1; }
    else if (char === "}" && depth > 0) { depth -= 1; if (depth === 0 && start >= 0) { results.push(value.slice(start, index + 1)); start = -1; } }
  }
  return depth === 0 && !quoted ? results : [];
}

function canonicalArguments(args: Record<string, unknown>) { return canonical({ ...args }) as Record<string, unknown>; }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (plainObject(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && onlyKeys(value, keys); }
function onlyKeys(value: Record<string, unknown>, keys: string[]) { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function plainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function shortText(value: unknown, max: number) { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max; }
function integer(value: unknown, min: number, max: number) { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max; }
function stringArray(value: unknown, min: number, max: number, pattern?: RegExp): value is string[] { return Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128 && (!pattern || pattern.test(item))); }
function canonicalInstancePath(value: unknown, allowRoot = false) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0-\x1f\x7f\\:]/u.test(value) || /^\/\//u.test(value)) return undefined;
  const rootHintRemoved = value.startsWith("/") ? value.slice(1) : value;
  const segments = rootHintRemoved.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = segments.join("/");
  return normalized || allowRoot ? normalized || "." : undefined;
}
function canonicalPublicDownloadURL(value: unknown) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname || parsed.hash) return undefined;
    const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1"
      || /^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host)
      || /^169\.254\./u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return undefined;
    return parsed.toString();
  } catch { return undefined; }
}
function canonicalDownloadTarget(value: unknown) {
  if (typeof value !== "string" || value.length < 11 || value.length > 170 || /[\0-\x1f\x7f\\:]/u.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.length !== 2 || segments[0] !== "downloads") return undefined;
  const fileName = segments[1];
  if (!fileName || fileName === "." || fileName === ".." || fileName.length > 160
    || fileName.trim() !== fileName || /[<>"|?*;]/u.test(fileName)) return undefined;
  return value;
}
function invalid<T = never>(code: string, message: string): AgentLoopValidation<T> { return { ok: false, code, message }; }
function tool<const Name extends string>(name: Name, description: string, input_schema: Record<string, unknown>) { return { name, description, input_schema }; }
function lifecycleSchema() { return { type: "object", additionalProperties: false, required: ["target"], properties: { target: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } } }; }
