import { createHash } from "node:crypto";
import {
  INTENT_CANDIDATE_SCHEMA_VERSION,
  INTENT_CANDIDATE_V2_SCHEMA_VERSION,
  INTENT_IR_SCHEMA_VERSION,
  INTENT_SOURCE_CATALOG_SCHEMA_VERSION,
  INTENT_SEMANTIC_FRAME_PLAN_VERSION,
  INTENT_SEMANTIC_FRAME_SCHEMA_VERSION,
  type IntentCandidate,
  type IntentCandidateV2,
  type IntentCandidateV2Ref,
  type IntentCandidateRef,
  type IntentIRConstraint,
  type IntentIRGoal,
  type IntentIRProposal,
  type IntentIRSpan,
  type IntentSourceCatalog,
  type IntentSourceRef,
  type IntentSemanticFrameBatch,
  type IntentSemanticFramePlan,
  type ValidatedIntentIR,
} from "@mcai/contracts";
import { canonicalizeLogFilterGroups } from "./log-filter-query";

export interface IntentIRValidationError {
  code: string;
  path: string;
  message: string;
}

export type IntentIRValidationResult = { ok: true }
  | { ok: false; errors: IntentIRValidationError[] };

export type IntentIRCompileResult = { ok: true; ir: ValidatedIntentIR }
  | { ok: false; errors: IntentIRValidationError[] };

export type IntentCandidateCompileResult = { ok: true; proposal: IntentIRProposal }
  | { ok: false; errors: IntentIRValidationError[] };

export type IntentSemanticFrameMergeResult = { ok: true; candidate: IntentCandidateV2 }
  | { ok: false; errors: IntentIRValidationError[] };

type Capability = {
  domain: string;
  resultKinds: IntentIRGoal["result_kind"][];
  tool?: string;
  parameters: Record<string, "string" | "number" | "boolean" | "string_array" | "log_filter_groups">;
  requiredParameters?: string[];
  description?: string;
  semantics?: Record<string, unknown>;
  fixed?: Record<string, unknown>;
  scope?: { depth?: number[]; window?: boolean; filter?: boolean };
};

export const INTENT_CAPABILITIES: Record<string, Capability> = {
  "server.version": { domain: "server", resultKinds: ["fact"], tool: "console.command", parameters: { command: "string" }, fixed: { command: "version" } },
  "server.performance": { domain: "server", resultKinds: ["fact"], tool: "console.command", parameters: { command: "string" } },
  "players.online": { domain: "players", resultKinds: ["collection", "count"], tool: "console.command", parameters: { command: "string" }, fixed: { command: "list" }, description: "Observe the current online-player collection or its count." },
  "plugins.loaded": { domain: "plugin", resultKinds: ["collection", "count"], tool: "console.command", parameters: { command: "string" }, fixed: { command: "plugins" }, description: "Observe the loaded plugin names or their count; never use for installation." },
  "filesystem.list": { domain: "filesystem", resultKinds: ["collection"], tool: "files.list", parameters: { path: "string" }, scope: { depth: [1], filter: true } },
  "filesystem.count": { domain: "filesystem", resultKinds: ["count"], parameters: {}, scope: { filter: true } },
  "filesystem.filtered_count": { domain: "filesystem", resultKinds: ["filtered_count"], parameters: {}, scope: { filter: true } },
  "logs.query": {
    domain: "diagnosis", resultKinds: ["collection", "count", "fact", "judgement"], tool: "logs.query",
    parameters: { window_minutes: "number", max_lines: "number", filter_groups: "log_filter_groups" },
    requiredParameters: ["window_minutes", "max_lines", "filter_groups"], scope: { window: true, filter: true },
    description: "Query recent logs with bounded Boolean groups. Different OR branches are separate groups; within a group all_of is AND and any_of is OR.",
    semantics: { group_relation: "OR", all_of_relation: "AND", any_of_relation: "OR" },
  },
  "config.inspect": { domain: "config", resultKinds: ["fact", "collection"], tool: "config.inspect", parameters: { path: "string", keys: "string_array" }, requiredParameters: ["path", "keys"], description: "Read exact keys from one configuration path." },
  "plugin.resolve": { domain: "plugin", resultKinds: ["fact"], tool: "plugin.resolve", parameters: { project: "string", source: "string", platform: "string", minecraft_version: "string", loader: "string" } },
  "plugin.install": { domain: "plugin", resultKinds: ["fact"], tool: "plugin.install", parameters: { project: "string" } },
  "config.patch": { domain: "config", resultKinds: ["fact"], tool: "config.patch", parameters: { path: "string" } },
  "server.install": { domain: "server", resultKinds: ["fact"], tool: "server.install", parameters: { platform: "string", minecraft_version: "string", target: "string", accept_eula: "boolean" } },
  "instance.start": { domain: "instance", resultKinds: ["fact"], tool: "instance.start", parameters: {} },
  "instance.stop": { domain: "instance", resultKinds: ["fact"], tool: "instance.stop", parameters: {} },
  "instance.restart": { domain: "instance", resultKinds: ["fact"], tool: "instance.restart", parameters: {} },
  "console.command": { domain: "console", resultKinds: ["fact", "collection", "count"], tool: "console.command", parameters: { command: "string" } },
};

const CANDIDATE_ARRAYS = ["clauses", "goals", "scopes", "constraints", "evidence_requirements", "response_requirements", "predicates", "unknown_goals"] as const;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceCatalogDigest(catalog: Omit<IntentSourceCatalog, "digest">) {
  return sha256(JSON.stringify(canonical(catalog)));
}

export function buildIntentSourceCatalog(source: string): IntentSourceCatalog {
  const runes = [...source];
  const refs: IntentSourceRef[] = [];
  let segmentStart = 0;
  const emit = (rawStart: number, rawEnd: number) => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/u.test(runes[start])) start += 1;
    while (end > start && /\s/u.test(runes[end - 1])) end -= 1;
    if (start === end) return;
    refs.push({ id: `src-${String(refs.length + 1).padStart(4, "0")}`, source_start: start, source_end: end, text: runes.slice(start, end).join(""), order: refs.length });
  };
  for (let index = 0; index < runes.length; index += 1) {
    if (/[;；。！？!?\n]/u.test(runes[index])) {
      emit(segmentStart, index + 1);
      segmentStart = index + 1;
    }
  }
  emit(segmentStart, runes.length);
  const base = { schema_version: INTENT_SOURCE_CATALOG_SCHEMA_VERSION, source_digest: sha256(source), refs } as const;
  return { ...base, digest: sourceCatalogDigest(base) };
}

const FRAME_ESTIMATED_CHARS_PER_REF = 1_100;
const FRAME_SIMPLE_MAX_REFS = 2;
const FRAME_SIMPLE_MAX_OUTPUT_CHARS = 2_400;
const FRAME_MAX_OUTPUT_TOKENS = 1_024;

export function buildIntentSemanticFramePlan(catalog: IntentSourceCatalog): IntentSemanticFramePlan {
  const refCount = catalog.refs.length;
  const estimated = Math.max(1, refCount) * FRAME_ESTIMATED_CHARS_PER_REF;
  const shardCount = refCount <= FRAME_SIMPLE_MAX_REFS && estimated <= FRAME_SIMPLE_MAX_OUTPUT_CHARS
    ? 1
    : Math.max(1, Math.min(3, refCount));
  const base = Math.floor(refCount / shardCount);
  let extra = refCount % shardCount;
  let offset = 0;
  const context = catalog.refs.map((ref) => ref.id);
  const shards = Array.from({ length: shardCount }, (_, index) => {
    const size = base + (extra-- > 0 ? 1 : 0);
    const assigned = catalog.refs.slice(offset, offset + size).map((ref) => ref.id);
    offset += size;
    const estimatedOutputChars = Math.max(640, assigned.length * FRAME_ESTIMATED_CHARS_PER_REF);
    return {
      id: `frame-shard-${String(index + 1).padStart(2, "0")}`,
      assigned_source_refs: assigned,
      context_source_refs: context,
      estimated_output_chars: estimatedOutputChars,
      max_output_tokens: Math.min(FRAME_MAX_OUTPUT_TOKENS, Math.max(256, Math.ceil(estimatedOutputChars / 4))),
    };
  });
  return {
    schema_version: INTENT_SEMANTIC_FRAME_PLAN_VERSION,
    complexity: shardCount === 1 ? "simple" : "complex",
    total_deadline_ms: 28_000,
    max_concurrency: 3,
    max_provider_calls: 4,
    shards,
  };
}

export function mergeIntentSemanticFrames(
  catalog: IntentSourceCatalog,
  plan: IntentSemanticFramePlan,
  batches: IntentSemanticFrameBatch[],
): IntentSemanticFrameMergeResult {
  const errors: IntentIRValidationError[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (plan.schema_version !== INTENT_SEMANTIC_FRAME_PLAN_VERSION || plan.total_deadline_ms !== 28_000 || plan.max_concurrency !== 3 || plan.max_provider_calls !== 4) {
    add("INVALID_SEMANTIC_FRAME_PLAN", "frame_plan", "semantic frame plan invariants changed");
  }
  if (batches.length !== plan.shards.length) add("SEMANTIC_FRAME_SHARD_COUNT_MISMATCH", "frames", "every planned shard must return exactly once");
  const refs = new Map(catalog.refs.map((ref) => [ref.id, ref]));
  const expectedOwners = plan.shards.flatMap((shard) => shard.assigned_source_refs);
  const ownerFrames = new Map<string, IntentSemanticFrameBatch["frames"][number]>();
  const orderedFrames: IntentSemanticFrameBatch["frames"][number][] = [];
  batches.forEach((batch, batchIndex) => {
    const shard = plan.shards[batchIndex];
    if (!shard) return;
    if (batch.schema_version !== INTENT_SEMANTIC_FRAME_SCHEMA_VERSION) add("UNSUPPORTED_SEMANTIC_FRAME_VERSION", `frames.${batchIndex}.schema_version`, "semantic frame v1 is required");
    if (JSON.stringify(batch.assigned_source_refs) !== JSON.stringify(shard.assigned_source_refs)) add("SEMANTIC_FRAME_ASSIGNMENT_MISMATCH", `frames.${batchIndex}.assigned_source_refs`, "provider cannot change assigned SourceRefs");
    batch.frames.forEach((frame, frameIndex) => {
      const path = `frames.${batchIndex}.frames.${frameIndex}`;
      if (!shard.assigned_source_refs.includes(frame.owner_source_ref)) add("SEMANTIC_FRAME_OWNERSHIP_EXPANDED", `${path}.owner_source_ref`, "frame owner is outside the assigned shard");
      if (ownerFrames.has(frame.owner_source_ref)) add("DUPLICATE_SEMANTIC_FRAME_OWNER", `${path}.owner_source_ref`, "a SourceRef has one frame owner");
      if (!Array.isArray(frame.roles) || !frame.roles.length) add("UNCLASSIFIED_ASSIGNED_SOURCE_REF", `${path}.roles`, "every assigned SourceRef requires an explicit classification");
      ownerFrames.set(frame.owner_source_ref, frame);
    });
  });
  for (const id of expectedOwners) {
    const frame = ownerFrames.get(id);
    if (!frame) add("UNCLASSIFIED_ASSIGNED_SOURCE_REF", `frames.${id}`, "assigned SourceRef was omitted");
    else orderedFrames.push(frame);
  }
  if (errors.length) return { ok: false, errors };

  const candidate: IntentCandidateV2 = {
    schema_version: INTENT_CANDIDATE_V2_SCHEMA_VERSION,
    clauses: [], goals: [], scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [],
  };
  const clauseIndexes = new Map<string, number>();
  const goalIndexes = new Map<string, number>();
  const roleRecords: Array<{ owner: string; roleIndex: number; role: IntentSemanticFrameBatch["frames"][number]["roles"][number]; clause: number }> = [];
  orderedFrames.forEach((frame) => frame.roles.forEach((role, roleIndex) => {
    const clause = candidate.clauses.length;
    const roleKey = `${frame.owner_source_ref}:${roleIndex}`;
    clauseIndexes.set(roleKey, clause);
    candidate.clauses.push({ source_refs: [frame.owner_source_ref], role: role.role, polarity: role.polarity, status: role.status, reason: role.reason });
    roleRecords.push({ owner: frame.owner_source_ref, roleIndex, role, clause });
    for (const goal of role.goals ?? []) {
      if (goalIndexes.has(goal.key)) { add("DUPLICATE_SEMANTIC_GOAL_KEY", `frames.${frame.owner_source_ref}.goals.${goal.key}`, "goal keys must be globally unique"); continue; }
      goalIndexes.set(goal.key, candidate.goals.length);
      candidate.goals.push({
        source_refs: [frame.owner_source_ref], clause, domain: goal.domain, entity: goal.entity, capability: goal.capability,
        target: goal.target, parameters: goal.parameters, result_kind: goal.result_kind, required: goal.required,
        ...(goal.filter ? { filter: goal.filter } : {}), ...(goal.item_schema ? { item_schema: goal.item_schema } : {}),
      });
    }
  }));
  roleRecords.forEach(({ role }, recordIndex) => {
    for (const goal of role.goals ?? []) {
      if (!goal.depends_on?.length) continue;
      const index = goalIndexes.get(goal.key);
      if (index === undefined) continue;
      candidate.goals[index].depends_on = goal.depends_on.map((dependency, dependencyIndex) => {
        const dependencyGoal = goalIndexes.get(dependency);
        if (dependencyGoal === undefined) {
          add("UNKNOWN_SEMANTIC_GOAL_KEY", `roles.${recordIndex}.goals.${goal.key}.depends_on.${dependencyIndex}`, `goal key ${dependency} is unknown`);
          return 0;
        }
        return dependencyGoal;
      });
    }
  });
  const sourceRefs = (owner: string, selected: string[] | undefined, path: string) => {
    const ids = selected?.length ? selected : [owner];
    if (ids[0] !== owner) add("SEMANTIC_FRAME_OWNER_MISMATCH", `${path}.source_refs`, "scope and predicate ownership must begin with the declaring SourceRef");
    for (const id of ids) if (!refs.has(id)) add("UNKNOWN_SOURCE_REF", `${path}.source_refs`, `SourceRef ${id} is absent from catalog`);
    const ordered = [...ids].sort((left, right) => (refs.get(left)?.order ?? Infinity) - (refs.get(right)?.order ?? Infinity));
    if (JSON.stringify(ids) !== JSON.stringify(ordered)) add("SOURCE_REF_ORDER_MISMATCH", `${path}.source_refs`, "cross-frame refs must retain source order");
    return ids;
  };
  const goalIndex = (key: string, path: string) => {
    const index = goalIndexes.get(key);
    if (index === undefined) { add("UNKNOWN_SEMANTIC_GOAL_KEY", path, `goal key ${key} is unknown`); return 0; }
    return index;
  };
  roleRecords.forEach(({ owner, role, clause }, recordIndex) => {
    const base = `roles.${recordIndex}`;
    for (const scope of role.scopes ?? []) candidate.scopes.push({ source_refs: sourceRefs(owner, scope.source_refs, `${base}.scopes`), clause, goal: goalIndex(scope.goal, `${base}.scopes.goal`), kind: scope.kind, value: scope.value });
    for (const constraint of role.constraints ?? []) candidate.constraints.push({ source_refs: [owner], clause, action: constraint.action, effect: constraint.effect });
    for (const requirement of role.evidence_requirements ?? []) candidate.evidence_requirements.push({ source_refs: [owner], clause, kind: requirement.kind, goals: requirement.goals.map((key) => goalIndex(key, `${base}.evidence.goals`)) });
    for (const requirement of role.response_requirements ?? []) candidate.response_requirements.push({ source_refs: [owner], clause, kind: requirement.kind, goals: requirement.goals.map((key) => goalIndex(key, `${base}.response.goals`)) });
    for (const predicate of role.predicates ?? []) {
      const predicateRefs = sourceRefs(owner, predicate.source_refs, `${base}.predicates`);
      if (predicate.kind === "quantifier") candidate.predicates.push({ source_refs: predicateRefs, clause, kind: "quantifier", quantifier: predicate.quantifier, collection_goal: goalIndex(predicate.collection_goal, `${base}.predicates.collection_goal`), filter: predicate.filter, expected: predicate.expected });
      else candidate.predicates.push({
        source_refs: predicateRefs, clause, kind: "binary", operator: predicate.operator, expected: predicate.expected,
        left: { source_refs: sourceRefs(owner, predicate.left.source_refs, `${base}.predicates.left`), ...(predicate.left.goal ? { goal: goalIndex(predicate.left.goal, `${base}.predicates.left.goal`) } : {}), ...(predicate.left.selector ? { selector: predicate.left.selector } : {}), ...(Object.prototype.hasOwnProperty.call(predicate.left, "value") ? { value: predicate.left.value } : {}) },
        right: { source_refs: sourceRefs(owner, predicate.right.source_refs, `${base}.predicates.right`), ...(predicate.right.goal ? { goal: goalIndex(predicate.right.goal, `${base}.predicates.right.goal`) } : {}), ...(predicate.right.selector ? { selector: predicate.right.selector } : {}), ...(Object.prototype.hasOwnProperty.call(predicate.right, "value") ? { value: predicate.right.value } : {}) },
      });
    }
    for (const unknown of role.unknown_goals ?? []) candidate.unknown_goals.push({ source_refs: [owner], clause, reason: unknown.reason });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, candidate };
}

export function validateIntentSourceCatalog(source: string, catalog: IntentSourceCatalog): IntentIRValidationResult {
  const errors: IntentIRValidationError[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (!catalog || catalog.schema_version !== INTENT_SOURCE_CATALOG_SCHEMA_VERSION) return { ok: false, errors: [{ code: "UNSUPPORTED_SOURCE_CATALOG_VERSION", path: "source_catalog.schema_version", message: "source catalog version is unsupported" }] };
  if (catalog.source_digest !== sha256(source)) add("SOURCE_CATALOG_SOURCE_DIGEST_MISMATCH", "source_catalog.source_digest", "catalog source digest does not match the immutable source");
  if (catalog.digest !== sourceCatalogDigest({ schema_version: catalog.schema_version, source_digest: catalog.source_digest, refs: catalog.refs })) add("SOURCE_CATALOG_DIGEST_MISMATCH", "source_catalog.digest", "catalog digest is invalid");
  const runes = [...source];
  const ids = new Set<string>();
  const coverage = new Array(runes.length).fill(false);
  let previousEnd = 0;
  catalog.refs.forEach((ref, index) => {
    const path = `source_catalog.refs.${index}`;
    if (ref.id !== `src-${String(index + 1).padStart(4, "0")}` || ref.order !== index) add("SOURCE_CATALOG_ORDER_MISMATCH", path, "source refs must retain deterministic id and order");
    if (ids.has(ref.id)) add("DUPLICATE_SOURCE_REF", `${path}.id`, "source ref ids must be unique");
    ids.add(ref.id);
    if (!Number.isInteger(ref.source_start) || !Number.isInteger(ref.source_end) || ref.source_start < previousEnd || ref.source_start < 0 || ref.source_end <= ref.source_start || ref.source_end > runes.length) add("INVALID_SOURCE_REF_SPAN", path, "source ref span is invalid or out of order");
    if (runes.slice(ref.source_start, ref.source_end).join("") !== ref.text) add("SOURCE_REF_TEXT_MISMATCH", `${path}.text`, "source ref text must be an exact source substring");
    for (let offset = Math.max(0, ref.source_start); offset < Math.min(runes.length, ref.source_end); offset += 1) coverage[offset] = true;
    previousEnd = Math.max(previousEnd, ref.source_end);
  });
  if (runes.some((rune, index) => !/\s/u.test(rune) && !coverage[index])) add("INCOMPLETE_SOURCE_CATALOG", "source_catalog.refs", "every non-whitespace source region must be traceable");
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function compileIntentCandidateV2(source: string, catalog: IntentSourceCatalog, candidate: IntentCandidateV2): IntentCandidateCompileResult {
  const errors: IntentIRValidationError[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const catalogValidation = validateIntentSourceCatalog(source, catalog);
  if (!catalogValidation.ok) errors.push(...catalogValidation.errors);
  if (!candidate || candidate.schema_version !== INTENT_CANDIDATE_V2_SCHEMA_VERSION) return { ok: false, errors: [{ code: "UNSUPPORTED_CANDIDATE_VERSION", path: "schema_version", message: "intent candidate v2 is required" }] };
  if (CANDIDATE_ARRAYS.some((key) => !Array.isArray(candidate[key]))) return { ok: false, errors: [{ code: "INVALID_CANDIDATE_SHAPE", path: "candidate", message: "compact candidate arrays are missing" }] };
  validateCandidateObject(candidate as unknown as Record<string, unknown>, ["schema_version", ...CANDIDATE_ARRAYS], ["schema_version", ...CANDIDATE_ARRAYS], "candidate", add);
  const shapes: Record<(typeof CANDIDATE_ARRAYS)[number], { required: string[]; allowed: string[] }> = {
    clauses: { required: ["source_refs", "role", "polarity", "status", "reason"], allowed: ["source_refs", "role", "polarity", "status", "reason"] },
    goals: { required: ["source_refs", "clause", "domain", "entity", "capability", "target", "parameters", "result_kind", "required"], allowed: ["source_refs", "clause", "domain", "entity", "capability", "target", "parameters", "result_kind", "filter", "item_schema", "depends_on", "required"] },
    scopes: { required: ["source_refs", "clause", "goal", "kind", "value"], allowed: ["source_refs", "clause", "goal", "kind", "value"] },
    constraints: { required: ["source_refs", "clause", "action", "effect"], allowed: ["source_refs", "clause", "action", "effect"] },
    evidence_requirements: { required: ["source_refs", "clause", "kind", "goals"], allowed: ["source_refs", "clause", "kind", "goals"] },
    response_requirements: { required: ["source_refs", "clause", "kind", "goals"], allowed: ["source_refs", "clause", "kind", "goals"] },
    predicates: { required: ["source_refs", "clause", "expected", "kind"], allowed: ["source_refs", "clause", "expected", "kind", "quantifier", "collection_goal", "filter", "operator", "left", "right"] },
    unknown_goals: { required: ["source_refs", "clause", "reason"], allowed: ["source_refs", "clause", "reason"] },
  };
  for (const key of CANDIDATE_ARRAYS) candidate[key].forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, shapes[key].required, shapes[key].allowed, `${key}.${index}`, add));
  candidate.predicates.forEach((item, index) => {
    if (item.kind === "binary") {
      validateCandidateObject(item.left as unknown as Record<string, unknown>, ["source_refs"], ["source_refs", "goal", "selector", "value"], `predicates.${index}.left`, add);
      validateCandidateObject(item.right as unknown as Record<string, unknown>, ["source_refs"], ["source_refs", "goal", "selector", "value"], `predicates.${index}.right`, add);
    }
  });
  const refs = new Map(catalog.refs.map((ref) => [ref.id, ref]));
  const resolved = new Map<object, { source_refs: string[]; quote: string; occurrence: number }>();
  const resolve = (value: IntentCandidateV2Ref, path: string) => {
    if (!Array.isArray(value?.source_refs) || !value.source_refs.length || value.source_refs.some((id) => typeof id !== "string")) {
      add("INVALID_SOURCE_REF_LIST", `${path}.source_refs`, "source_refs must be a non-empty string array");
      return { source_refs: [], quote: "", occurrence: 1 };
    }
    const selected = value.source_refs.map((id, index) => {
      const ref = refs.get(id);
      if (!ref) add("UNKNOWN_SOURCE_REF", `${path}.source_refs.${index}`, `source ref ${id} is absent from the immutable catalog`);
      return ref;
    }).filter((ref): ref is IntentSourceRef => Boolean(ref));
    const ordered = [...selected].sort((a, b) => a.order - b.order);
    if (ordered.some((ref, index) => ref.id !== selected[index]?.id)) add("SOURCE_REF_ORDER_MISMATCH", `${path}.source_refs`, "source refs must be listed in catalog order");
    if (!ordered.length) return { source_refs: [...value.source_refs], quote: "", occurrence: 1 };
    const start = ordered[0].source_start;
    const end = ordered[ordered.length - 1].source_end;
    const quote = [...source].slice(start, end).join("");
    let occurrence = 0;
    let foundAt = -1;
    for (let offset = 0; offset <= source.length - quote.length;) {
      const found = source.indexOf(quote, offset);
      if (found < 0) break;
      occurrence += 1;
      if ([...source.slice(0, found)].length === start) { foundAt = occurrence; break; }
      offset = found + Math.max(1, quote.length);
    }
    if (foundAt < 1) add("SOURCE_REF_PROJECTION_FAILED", path, "catalog refs cannot be projected back to their exact source span");
    const result = { source_refs: [...value.source_refs], quote, occurrence: Math.max(1, foundAt) };
    resolved.set(value as object, result);
    return result;
  };
  const convert = <T extends IntentCandidateV2Ref>(value: T, path: string) => {
    const { quote, occurrence } = resolve(value, path);
    const { source_refs: _sourceRefs, ...rest } = value;
    return { ...rest, quote, occurrence };
  };
  candidate.clauses.forEach((value, index) => resolve(value, `clauses.${index}`));
  candidate.goals.forEach((value, index) => resolve(value, `goals.${index}`));
  candidate.scopes.forEach((value, index) => resolve(value, `scopes.${index}`));
  candidate.constraints.forEach((value, index) => resolve(value, `constraints.${index}`));
  candidate.evidence_requirements.forEach((value, index) => resolve(value, `evidence_requirements.${index}`));
  candidate.response_requirements.forEach((value, index) => resolve(value, `response_requirements.${index}`));
  candidate.predicates.forEach((value, index) => { resolve(value, `predicates.${index}`); if (value.kind === "binary") { resolve(value.left, `predicates.${index}.left`); resolve(value.right, `predicates.${index}.right`); } });
  candidate.unknown_goals.forEach((value, index) => resolve(value, `unknown_goals.${index}`));
  if (errors.length) return { ok: false, errors };
  const legacy = {
    schema_version: INTENT_CANDIDATE_SCHEMA_VERSION,
    clauses: candidate.clauses.map((value, index) => convert(value, `clauses.${index}`)), goals: candidate.goals.map((value, index) => convert(value, `goals.${index}`)),
    scopes: candidate.scopes.map((value, index) => convert(value, `scopes.${index}`)), constraints: candidate.constraints.map((value, index) => convert(value, `constraints.${index}`)),
    evidence_requirements: candidate.evidence_requirements.map((value, index) => convert(value, `evidence_requirements.${index}`)), response_requirements: candidate.response_requirements.map((value, index) => convert(value, `response_requirements.${index}`)),
    predicates: candidate.predicates.map((value, index) => value.kind === "binary" ? ({ ...convert(value, `predicates.${index}`), left: convert(value.left, `predicates.${index}.left`), right: convert(value.right, `predicates.${index}.right`) }) : convert(value, `predicates.${index}`)),
    unknown_goals: candidate.unknown_goals.map((value, index) => convert(value, `unknown_goals.${index}`)),
  } as IntentCandidate;
  const expanded = compileIntentCandidate(source, legacy, { deferValidation: true });
  if (!expanded.ok) return expanded;
  const attach = (span: IntentIRSpan, original: IntentCandidateV2Ref) => { span.source_ref_ids = [...original.source_refs]; };
  expanded.proposal.clauses.forEach((span, index) => attach(span, candidate.clauses[index]));
  expanded.proposal.goals.forEach((span, index) => attach(span, candidate.goals[index]));
  expanded.proposal.scopes.forEach((span, index) => attach(span, candidate.scopes[index]));
  expanded.proposal.constraints.forEach((span, index) => attach(span, candidate.constraints[index]));
  expanded.proposal.evidence_requirements.forEach((span, index) => attach(span, candidate.evidence_requirements[index]));
  expanded.proposal.response_requirements.forEach((span, index) => attach(span, candidate.response_requirements[index]));
  expanded.proposal.predicates.forEach((span, index) => { attach(span, candidate.predicates[index]); if (span.kind === "binary" && candidate.predicates[index].kind === "binary") { attach(span.left, candidate.predicates[index].left); attach(span.right, candidate.predicates[index].right); } });
  expanded.proposal.unknown_goals.forEach((span, index) => attach(span, candidate.unknown_goals[index]));
  expanded.proposal.source_catalog = structuredClone(catalog);
  const validation = validateIntentIRProposal(source, expanded.proposal);
  return validation.ok ? expanded : validation;
}

export function compileIntentCandidate(source: string, candidate: IntentCandidate, options?: { deferValidation?: boolean }): IntentCandidateCompileResult {
  const errors: IntentIRValidationError[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (!candidate || candidate.schema_version !== INTENT_CANDIDATE_SCHEMA_VERSION) {
    return { ok: false, errors: [{ code: "UNSUPPORTED_CANDIDATE_VERSION", path: "schema_version", message: "intent candidate version is unsupported" }] };
  }
  const arrays = ["clauses", "goals", "scopes", "constraints", "evidence_requirements", "response_requirements", "predicates", "unknown_goals"] as const;
  if (arrays.some((key) => !Array.isArray(candidate[key]))) return { ok: false, errors: [{ code: "INVALID_CANDIDATE_SHAPE", path: "candidate", message: "compact candidate arrays are missing" }] };
  validateCandidateObject(candidate as unknown as Record<string, unknown>, ["schema_version", ...arrays], ["schema_version", ...arrays], "candidate", add);
  candidate.clauses.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "role", "polarity", "status", "reason"], ["quote", "occurrence", "role", "polarity", "status", "reason"], `clauses.${index}`, add));
  candidate.goals.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "clause", "domain", "entity", "capability", "target", "parameters", "result_kind", "required"], ["quote", "occurrence", "clause", "domain", "entity", "capability", "target", "parameters", "result_kind", "filter", "item_schema", "depends_on", "required"], `goals.${index}`, add));
  candidate.scopes.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "clause", "goal", "kind", "value"], ["quote", "occurrence", "clause", "goal", "kind", "value"], `scopes.${index}`, add));
  candidate.constraints.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "clause", "action", "effect"], ["quote", "occurrence", "clause", "action", "effect"], `constraints.${index}`, add));
  candidate.evidence_requirements.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "clause", "kind", "goals"], ["quote", "occurrence", "clause", "kind", "goals"], `evidence_requirements.${index}`, add));
  candidate.response_requirements.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "clause", "kind", "goals"], ["quote", "occurrence", "clause", "kind", "goals"], `response_requirements.${index}`, add));
  candidate.predicates.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, item.kind === "binary" ? ["quote", "occurrence", "clause", "expected", "kind", "operator", "left", "right"] : ["quote", "occurrence", "clause", "expected", "kind", "quantifier", "collection_goal", "filter"], item.kind === "binary" ? ["quote", "occurrence", "clause", "expected", "kind", "operator", "left", "right"] : ["quote", "occurrence", "clause", "expected", "kind", "quantifier", "collection_goal", "filter"], `predicates.${index}`, add));
  candidate.unknown_goals.forEach((item, index) => validateCandidateObject(item as unknown as Record<string, unknown>, ["quote", "occurrence", "clause", "reason"], ["quote", "occurrence", "clause", "reason"], `unknown_goals.${index}`, add));
  if (errors.length) return { ok: false, errors };
  const locate = (ref: IntentCandidateRef, path: string) => locateCandidateSpan(source, ref, path, add);
  const clauses = candidate.clauses.map((item, index) => ({
    id: `clause-${index + 1}`, ...locate(item, `clauses.${index}`), role: item.role, polarity: item.polarity,
    status: item.status, reason: item.reason,
  }));
  const clauseId = (index: number, path: string) => {
    if (!Number.isInteger(index) || !clauses[index]) add("INVALID_CANDIDATE_REFERENCE", path, "clause reference is out of range");
    return clauses[index]?.id ?? "invalid-clause";
  };
  const goals = candidate.goals.map((item, index) => ({
    id: `goal-${index + 1}`, clause_id: clauseId(item.clause, `goals.${index}.clause`), ...locate(item, `goals.${index}`),
    domain: item.domain, entity: item.entity, capability: item.capability, target: item.target, parameters: item.parameters,
    result_kind: item.result_kind, ...(item.filter ? { filter: item.filter } : {}), ...(item.item_schema ? { item_schema: item.item_schema } : {}),
    ...(item.depends_on ? { depends_on: item.depends_on.map((goal, dependency) => goalId(goal, `goals.${index}.depends_on.${dependency}`)) } : {}), required: item.required,
  }));
  function goalId(index: number, path: string) {
    if (!Number.isInteger(index) || !candidate.goals[index]) add("INVALID_CANDIDATE_REFERENCE", path, "goal reference is out of range");
    return `goal-${index + 1}`;
  }
  const proposal: IntentIRProposal = {
    schema_version: INTENT_IR_SCHEMA_VERSION,
    clauses,
    goals,
    scopes: candidate.scopes.map((item, index) => ({ id: `scope-${index + 1}`, clause_id: clauseId(item.clause, `scopes.${index}.clause`), goal_id: goalId(item.goal, `scopes.${index}.goal`), ...locate(item, `scopes.${index}`), kind: item.kind, value: item.value })),
    constraints: candidate.constraints.map((item, index) => ({ id: `constraint-${index + 1}`, clause_id: clauseId(item.clause, `constraints.${index}.clause`), ...locate(item, `constraints.${index}`), action: item.action, effect: item.effect })),
    evidence_requirements: candidate.evidence_requirements.map((item, index) => ({ id: `evidence-${index + 1}`, clause_id: clauseId(item.clause, `evidence_requirements.${index}.clause`), ...locate(item, `evidence_requirements.${index}`), kind: item.kind, goal_ids: item.goals.map((goal, offset) => goalId(goal, `evidence_requirements.${index}.goals.${offset}`)) })),
    response_requirements: candidate.response_requirements.map((item, index) => ({ id: `response-${index + 1}`, clause_id: clauseId(item.clause, `response_requirements.${index}.clause`), ...locate(item, `response_requirements.${index}`), kind: item.kind, goal_ids: item.goals.map((goal, offset) => goalId(goal, `response_requirements.${index}.goals.${offset}`)) })),
    predicates: candidate.predicates.map((item, index) => item.kind === "quantifier" ? ({
      id: `predicate-${index + 1}`, clause_id: clauseId(item.clause, `predicates.${index}.clause`), ...locate(item, `predicates.${index}`), kind: item.kind, quantifier: item.quantifier,
      collection_goal_id: goalId(item.collection_goal, `predicates.${index}.collection_goal`), filter: item.filter, expected: item.expected,
    }) : ({
      id: `predicate-${index + 1}`, clause_id: clauseId(item.clause, `predicates.${index}.clause`), ...locate(item, `predicates.${index}`), kind: item.kind, operator: item.operator,
      left: { ...locate(item.left, `predicates.${index}.left`), ...(item.left.goal === undefined ? {} : { goal_id: goalId(item.left.goal, `predicates.${index}.left.goal`) }), ...(item.left.selector ? { selector: item.left.selector } : {}), ...(item.left.value === undefined ? {} : { value: item.left.value }) },
      right: { ...locate(item.right, `predicates.${index}.right`), ...(item.right.goal === undefined ? {} : { goal_id: goalId(item.right.goal, `predicates.${index}.right.goal`) }), ...(item.right.selector ? { selector: item.right.selector } : {}), ...(item.right.value === undefined ? {} : { value: item.right.value }) }, expected: item.expected,
    })),
    unknown_goals: candidate.unknown_goals.map((item, index) => ({ id: `unknown-${index + 1}`, clause_id: clauseId(item.clause, `unknown_goals.${index}.clause`), ...locate(item, `unknown_goals.${index}`), reason: item.reason })),
  };
  if (errors.length) return { ok: false, errors };
  if (options?.deferValidation) return { ok: true, proposal };
  const validation = validateIntentIRProposal(source, proposal);
  return validation.ok ? { ok: true, proposal } : validation;
}

function validateCandidateObject(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[], path: string, add: (code: string, path: string, message: string) => void) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add("INVALID_CANDIDATE_SHAPE", path, "candidate item must be an object");
    return;
  }
  for (const key of required) if (!(key in value)) add("MISSING_CANDIDATE_FIELD", `${path}.${key}`, "required compact candidate field is missing");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) add("FORBIDDEN_CANDIDATE_FIELD", `${path}.${key}`, "model candidates cannot provide deterministic or security-owned fields");
}

function locateCandidateSpan(source: string, ref: IntentCandidateRef, path: string, add: (code: string, path: string, message: string) => void) {
  const quote = typeof ref?.quote === "string" ? ref.quote : "";
  const occurrence = ref?.occurrence;
  if (!quote || !Number.isInteger(occurrence) || occurrence < 1) {
    add("INVALID_QUOTE_REFERENCE", path, "quote must be non-empty and occurrence must be a positive integer");
    return { source_text: quote, source_start: -1, source_end: -1 };
  }
  const indexes: number[] = [];
  for (let offset = 0; offset <= source.length - quote.length;) {
    const found = source.indexOf(quote, offset);
    if (found < 0) break;
    indexes.push(found);
    offset = found + Math.max(1, quote.length);
  }
  const utf16Start = indexes[occurrence - 1];
  if (utf16Start === undefined) {
    add("QUOTE_NOT_FOUND", path, `quote occurrence ${occurrence} does not exist in the source`);
    return { source_text: quote, source_start: -1, source_end: -1 };
  }
  const sourceStart = [...source.slice(0, utf16Start)].length;
  return { source_text: quote, source_start: sourceStart, source_end: sourceStart + [...quote].length };
}

export function validateIntentIRProposal(source: string, proposal: IntentIRProposal): IntentIRValidationResult {
  const errors: IntentIRValidationError[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (!proposal || proposal.schema_version !== INTENT_IR_SCHEMA_VERSION) {
    return { ok: false, errors: [{ code: "UNSUPPORTED_IR_VERSION", path: "schema_version", message: "intent IR version is unsupported" }] };
  }
  if (proposal.source_catalog) {
    const catalogValidation = validateIntentSourceCatalog(source, proposal.source_catalog);
    if (!catalogValidation.ok) errors.push(...catalogValidation.errors);
  }
  const collections = ["clauses", "goals", "scopes", "constraints", "evidence_requirements", "response_requirements", "predicates", "unknown_goals"] as const;
  if (collections.some((key) => !Array.isArray(proposal[key]))) return { ok: false, errors: [{ code: "INVALID_IR_SHAPE", path: "proposal", message: "typed intent IR arrays are missing" }] };
  if (!proposal.clauses.length) add("EMPTY_CLAUSE_LEDGER", "clauses", "the complete source must be represented by typed clauses");
  if (!proposal.goals.length && !proposal.unknown_goals.length) add("EMPTY_GOAL_GRAPH", "goals", "the proposal contains neither registered nor explicit unknown goals");
  const runes = [...source];
  const all = [
    ...proposal.clauses.map((value) => ["clauses", value] as const),
    ...proposal.goals.map((value) => ["goals", value] as const),
    ...proposal.scopes.map((value) => ["scopes", value] as const),
    ...proposal.constraints.map((value) => ["constraints", value] as const),
    ...proposal.evidence_requirements.map((value) => ["evidence_requirements", value] as const),
    ...proposal.response_requirements.map((value) => ["response_requirements", value] as const),
    ...proposal.predicates.map((value) => ["predicates", value] as const),
    ...proposal.unknown_goals.map((value) => ["unknown_goals", value] as const),
  ];
  for (const [collection, item] of all) validateSpan(runes, item, `${collection}.${item.id}`, add);
  if (proposal.source_catalog) {
    const refs = new Map(proposal.source_catalog.refs.map((ref) => [ref.id, ref]));
    const validateProjection = (item: IntentIRSpan, path: string) => {
      if (!Array.isArray(item.source_ref_ids) || !item.source_ref_ids.length) {
        add("MISSING_SOURCE_REF_PROJECTION", `${path}.source_ref_ids`, "v2-derived IR spans must retain immutable source refs");
        return;
      }
      const selected = item.source_ref_ids.map((id, index) => {
        const ref = refs.get(id);
        if (!ref) add("UNKNOWN_SOURCE_REF", `${path}.source_ref_ids.${index}`, "IR references an absent source ref");
        return ref;
      }).filter((ref): ref is IntentSourceRef => Boolean(ref));
      if (!selected.length) return;
      const ordered = [...selected].sort((a, b) => a.order - b.order);
      if (ordered.some((ref, index) => ref.id !== selected[index]?.id)) add("SOURCE_REF_ORDER_MISMATCH", `${path}.source_ref_ids`, "IR source refs are out of catalog order");
      const start = ordered[0].source_start;
      const end = ordered[ordered.length - 1].source_end;
      if (item.source_start !== start || item.source_end !== end || item.source_text !== runes.slice(start, end).join("")) add("SOURCE_REF_PROJECTION_MISMATCH", path, "IR span does not exactly project from its immutable source refs");
    };
    for (const [collection, item] of all) {
      validateProjection(item, `${collection}.${item.id}`);
      if (collection === "predicates" && item.kind === "binary") {
        validateProjection(item.left, `${collection}.${item.id}.left`);
        validateProjection(item.right, `${collection}.${item.id}.right`);
      }
    }
  }
  const ids = new Set<string>();
  for (const [, item] of all) {
    if (ids.has(item.id)) add("DUPLICATE_IR_ID", item.id, "IR ids must be globally unique");
    ids.add(item.id);
  }
  const clauses = new Map(proposal.clauses.map((value) => [value.id, value]));
  const clauseCoverage = new Array(runes.length).fill(false);
  for (const clause of proposal.clauses) for (let index = clause.source_start; index < clause.source_end; index += 1) {
    if (clauseCoverage[index] && !proposal.source_catalog) add("OVERLAPPING_CLAUSE_ROLES", `clauses.${clause.id}`, "legacy clause roles must partition the meaningful source instead of overlapping");
    clauseCoverage[index] = true;
  }
  if (runes.some((rune, index) => /[\p{L}\p{N}_]/u.test(rune) && !clauseCoverage[index])) add("INCOMPLETE_CLAUSE_LEDGER", "clauses", "meaningful source text is missing from the clause role ledger");
  const goals = new Map(proposal.goals.map((value) => [value.id, value]));
  const checkClause = (clauseId: string, role: string, path: string) => {
    const clause = clauses.get(clauseId);
    if (!clause || clause.role !== role) add("CLAUSE_ROLE_MISMATCH", path, `expected a ${role} clause`);
  };
  const identities = new Set<string>();
  for (const goal of proposal.goals) {
    checkClause(goal.clause_id, "domain_goal", `goals.${goal.id}.clause_id`);
    const capability = INTENT_CAPABILITIES[goal.capability];
    if (!capability) add("UNKNOWN_CAPABILITY", `goals.${goal.id}.capability`, "capability is not registered");
    else {
      if (goal.domain !== capability.domain) add("CAPABILITY_DOMAIN_MISMATCH", `goals.${goal.id}.domain`, "goal domain differs from the registered capability");
      if (!capability.resultKinds.includes(goal.result_kind)) add("CAPABILITY_RESULT_MISMATCH", `goals.${goal.id}.result_kind`, "result kind is not supported by the capability");
      validateParameters(goal, capability, add);
      if (goal.capability === "logs.query") {
        const canonicalGroups = canonicalizeLogFilterGroups(goal.parameters.filter_groups);
        const requiredBranches = explicitIndependentOrBranchCount(source);
        if (canonicalGroups.ok && requiredBranches > canonicalGroups.query.groups.length) {
          add("LOG_FILTER_OR_BRANCH_COLLAPSE", `goals.${goal.id}.parameters.filter_groups`, "explicit independent OR branches must remain separate log filter groups");
        }
      }
    }
    const identity = JSON.stringify([goal.clause_id, goal.domain, goal.entity, goal.result_kind, goal.source_start, goal.source_end]);
    if (identities.has(identity)) add("DUPLICATE_GOAL", `goals.${goal.id}`, "the same source goal was proposed more than once");
    identities.add(identity);
    for (const dependency of goal.depends_on ?? []) if (!goals.has(dependency) || dependency === goal.id) add("INVALID_GOAL_DEPENDENCY", `goals.${goal.id}.depends_on`, "goal dependency is absent or self-referential");
    if (goal.result_kind === "filtered_count" && (!goal.filter || !(goal.depends_on ?? []).some((id) => goals.get(id)?.result_kind === "collection"))) add("INVALID_FILTERED_COUNT", `goals.${goal.id}`, "filtered_count requires a filter and collection dependency");
    if (goal.result_kind === "count" && !(goal.depends_on ?? []).some((id) => goals.get(id)?.result_kind === "collection")) add("INVALID_COUNT", `goals.${goal.id}`, "count requires a collection dependency");
  }
  for (const scope of proposal.scopes) {
    const goal = goals.get(scope.goal_id);
    checkClause(scope.clause_id, "domain_goal", `scopes.${scope.id}.clause_id`);
    if (!goal || goal.clause_id !== scope.clause_id) add("SCOPE_GOAL_MISMATCH", `scopes.${scope.id}.goal_id`, "scope is not bound to a goal in the same clause");
    const capability = goal && INTENT_CAPABILITIES[goal.capability];
    if (scope.kind === "depth" && (!capability?.scope?.depth?.includes(Number(scope.value)))) add("SCOPE_EXPANSION", `scopes.${scope.id}.value`, "requested depth is not registered for this capability");
    if (scope.kind === "window" && !capability?.scope?.window) add("SCOPE_EXPANSION", `scopes.${scope.id}`, "window scope is not registered for this capability");
    if (scope.kind === "filter" && !capability?.scope?.filter) add("SCOPE_EXPANSION", `scopes.${scope.id}`, "filter scope is not registered for this capability");
  }
  for (const constraint of proposal.constraints) checkClause(constraint.clause_id, "safety_constraint", `constraints.${constraint.id}.clause_id`);
  for (const requirement of proposal.evidence_requirements) {
    checkClause(requirement.clause_id, "evidence_requirement", `evidence_requirements.${requirement.id}.clause_id`);
    if (!(["real_callback_per_goal", "independent_verification"] as string[]).includes(requirement.kind)) add("INVALID_EVIDENCE_POLICY", `evidence_requirements.${requirement.id}.kind`, "evidence policy kind is not registered");
    if (!requirement.goal_ids.length) add("EMPTY_EVIDENCE_POLICY", `evidence_requirements.${requirement.id}.goal_ids`, "evidence policy must bind at least one goal");
    for (const id of requirement.goal_ids) if (!goals.has(id)) add("UNKNOWN_EVIDENCE_GOAL", `evidence_requirements.${requirement.id}.goal_ids`, "evidence requirement references an unknown goal");
    if (requirement.kind === "real_callback_per_goal" && proposal.goals.some((goal) => goal.required && !requirement.goal_ids.includes(goal.id))) add("INCOMPLETE_EVIDENCE_POLICY", `evidence_requirements.${requirement.id}.goal_ids`, "per-goal callback policy must cover every required goal");
  }
  for (const requirement of proposal.response_requirements) {
    checkClause(requirement.clause_id, "response_requirement", `response_requirements.${requirement.id}.clause_id`);
    if (!(["cover_all", "synthesis", "source_order"] as string[]).includes(requirement.kind)) add("INVALID_RESPONSE_POLICY", `response_requirements.${requirement.id}.kind`, "response policy kind is not registered");
    if (!requirement.goal_ids.length) add("EMPTY_RESPONSE_POLICY", `response_requirements.${requirement.id}.goal_ids`, "response policy must bind at least one goal");
    for (const id of requirement.goal_ids) if (!goals.has(id)) add("UNKNOWN_RESPONSE_GOAL", `response_requirements.${requirement.id}.goal_ids`, "response requirement references an unknown goal");
    if ((requirement.kind === "cover_all" || requirement.kind === "synthesis") && proposal.goals.some((goal) => goal.required && !requirement.goal_ids.includes(goal.id))) add("INCOMPLETE_RESPONSE_POLICY", `response_requirements.${requirement.id}.goal_ids`, "complete response policy must cover every required goal");
  }
  for (const unknown of proposal.unknown_goals) checkClause(unknown.clause_id, "unknown_business_goal", `unknown_goals.${unknown.id}.clause_id`);
  for (const predicate of proposal.predicates) {
    checkClause(predicate.clause_id, "domain_goal", `predicates.${predicate.id}.clause_id`);
    if (predicate.kind === "quantifier") {
      const collection = goals.get(predicate.collection_goal_id);
      if (!collection || collection.result_kind !== "collection" || collection.item_schema?.[predicate.filter.field] !== "string") add("INVALID_QUANTIFIER", `predicates.${predicate.id}`, "quantifier must bind a typed collection and filter field");
      const explicit = /\b(all|every|any)\b|全部|所有|任一|任意/i.exec(predicate.source_text)?.[1]?.toLowerCase();
      const expected = (explicit && ["all", "every"].includes(explicit)) || /全部|所有/.test(predicate.source_text)
        ? "all"
        : explicit === "any" || /任一|任意/.test(predicate.source_text) ? "any" : undefined;
      if (expected && predicate.quantifier !== expected) add("QUANTIFIER_MISMATCH", `predicates.${predicate.id}.quantifier`, "quantifier differs from the explicit source text");
    } else {
      validateSpan(runes, predicate.left, `predicates.${predicate.id}.left`, add);
      validateSpan(runes, predicate.right, `predicates.${predicate.id}.right`, add);
      if (predicate.left.source_start < predicate.source_start || predicate.left.source_end > predicate.source_end || predicate.right.source_start < predicate.source_start || predicate.right.source_end > predicate.source_end) add("OPERAND_SPAN_MISMATCH", `predicates.${predicate.id}`, "binary operand spans must be contained by the predicate source span");
      if (predicate.left.source_start >= predicate.right.source_start) add("OPERAND_ORDER_MISMATCH", `predicates.${predicate.id}`, "binary operands must preserve source order");
      const explicit = runes.slice(predicate.left.source_end, predicate.right.source_start).join("").match(/<=|>=|!=|==|<|>/)?.[0];
      const explicitOperator = explicit ? ({ "<": "lt", "<=": "lte", ">": "gt", ">=": "gte", "==": "equals", "!=": "not_equals" } as const)[explicit as "<" | "<=" | ">" | ">=" | "==" | "!="] : undefined;
      if (explicitOperator && predicate.operator !== explicitOperator) add("OPERATOR_MISMATCH", `predicates.${predicate.id}.operator`, "comparison operator differs from the explicit source token");
      const left = predicate.left.goal_id ? goals.get(predicate.left.goal_id) : undefined;
      const right = predicate.right.goal_id ? goals.get(predicate.right.goal_id) : undefined;
      if (predicate.left.goal_id && !left || predicate.right.goal_id && !right) add("UNKNOWN_PREDICATE_GOAL", `predicates.${predicate.id}`, "predicate references an unknown goal");
      if (left && right && (left.domain !== right.domain || left.entity !== right.entity)) add("CROSS_DOMAIN_PREDICATE", `predicates.${predicate.id}`, "binary operands must share domain and entity");
      if (left && !numericOperand(left, predicate.left.selector) || right && !numericOperand(right, predicate.right.selector)) add("PREDICATE_TYPE_MISMATCH", `predicates.${predicate.id}`, "ordered comparison operands must be numeric");
    }
  }
  for (const conservative of conservativeConstraints(source, proposal.clauses)) {
    if (!proposal.constraints.some((value) => value.action === conservative.action && overlaps(value, conservative))) add("MISSING_CONSERVATIVE_CONSTRAINT", "constraints", `model omitted conservative ${conservative.action} constraint`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function explicitIndependentOrBranchCount(sourceText: string): number {
  const separators = sourceText.match(/(?:[,，;；]\s*(?:or\b|alternatively\b|或者|或是|要么))/giu);
  return separators?.length ? separators.length + 1 : 1;
}

export function compileIntentIR(source: string, proposal: IntentIRProposal, metadata: { providerModel: string; attempt: 1 | 2 }): IntentIRCompileResult {
  const validation = validateIntentIRProposal(source, proposal);
  if (!validation.ok) return validation;
  const base = { ...proposal, source };
  const digest = createHash("sha256").update(JSON.stringify(canonical(base))).digest("hex");
  return { ok: true, ir: { ...base, digest, compiler: { provider_model: metadata.providerModel, attempt: metadata.attempt, deterministic_validator: "intent-ir-validator/v1" } } };
}

export function capabilityForIntentGoal(goal: IntentIRGoal) {
  return INTENT_CAPABILITIES[goal.capability];
}
export function toolForIntentCapability(capability: string) { return INTENT_CAPABILITIES[capability]?.tool; }

function validateSpan(runes: string[], item: { source_text: string; source_start: number; source_end: number }, path: string, add: (code: string, path: string, message: string) => void) {
  if (!Number.isInteger(item.source_start) || !Number.isInteger(item.source_end) || item.source_start < 0 || item.source_end <= item.source_start || runes.slice(item.source_start, item.source_end).join("") !== item.source_text) add("SPAN_MISMATCH", path, "Unicode span does not bind the original source");
}

function validateParameters(goal: IntentIRGoal, capability: Capability, add: (code: string, path: string, message: string) => void) {
  for (const [key, value] of Object.entries(goal.parameters)) {
    const expected = capability.parameters[key];
    const valid = expected === "string_array"
      ? Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128)
      : expected === "log_filter_groups"
        ? canonicalizeLogFilterGroups(value).ok
        : Boolean(expected) && typeof value === expected;
    if (!valid) add("INVALID_CAPABILITY_PARAMETER", `goals.${goal.id}.parameters.${key}`, "parameter is absent from capability schema or has the wrong type");
  }
  for (const key of capability.requiredParameters ?? []) if (!(key in goal.parameters)) add("MISSING_CAPABILITY_PARAMETER", `goals.${goal.id}.parameters.${key}`, "required capability parameter is missing");
  for (const [key, value] of Object.entries(capability.fixed ?? {})) if (goal.parameters[key] !== value) add("FIXED_PARAMETER_MISMATCH", `goals.${goal.id}.parameters.${key}`, "fixed capability parameter was changed");
  if (goal.target !== goal.entity && !["server.version", "server.performance", "players.online", "plugins.loaded"].includes(goal.capability)) add("TARGET_SCOPE_MISMATCH", `goals.${goal.id}.target`, "target must match the typed entity");
}

function numericOperand(goal: IntentIRGoal, selector: string | undefined) {
  return goal.result_kind === "count" || goal.result_kind === "filtered_count" || goal.result_kind === "collection" && (selector === "count" || selector === "filtered_count");
}

function conservativeConstraints(source: string, clauses: IntentIRProposal["clauses"]): IntentIRConstraint[] {
  const actions: Array<[IntentIRConstraint["action"], RegExp]> = [
    ["download", /(?:download|fetch|下载|拉取)/i], ["install", /(?:install|deploy|安装|部署)/i],
    ["restart", /(?:restart|reboot|重启)/i], ["start", /(?:\bstart\b|启动|开服)/i],
    ["stop", /(?:\bstop\b|shutdown|停止|关服)/i], ["write", /(?:write|alter|change|modify|edit|settings?|config|写入|修改|更改|配置)/i],
  ];
  const negative = /(?:\b(?:never|not|without|avoid|forbid)\b|不要|不得|禁止|避免|不可)/i;
  return clauses.filter((clause) => negative.test(clause.source_text)).flatMap((clause) => actions.filter(([, pattern]) => pattern.test(clause.source_text)).map(([action], index) => ({ id: `guard-${clause.id}-${index}`, clause_id: clause.id, source_text: clause.source_text, source_start: clause.source_start, source_end: clause.source_end, action, effect: "forbid" as const })));
}

function overlaps(left: IntentIRConstraint, right: IntentIRConstraint) { return left.source_start < right.source_end && left.source_end > right.source_start; }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
