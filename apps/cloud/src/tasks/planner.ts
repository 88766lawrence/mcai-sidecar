import { createHash, randomUUID } from "node:crypto";
import type { GoalPredicate, GoalRequirement, RiskLevel, SourceGoal, TaskPlan, ValidatedIntentIR } from "@mcai/contracts";
import { intrinsicToolPolicy, normalizeStepPolicy, OPERATION_POLICY_DIGEST, OPERATION_POLICY_VERSION, TASK_PLAN_SCHEMA_VERSION } from "@mcai/contracts";
import type { AgentLoopToolCall } from "../chat/agent-loop";
import {
  classifyOperationalLanguage,
  deriveOperationObjective,
  extractActionbarConsoleCommand,
  extractBroadcastConsoleCommand,
  extractTitleConsoleCommand,
  extractExplicitConsoleCommand,
  hasInstanceLifecycleLanguage,
  hasPositiveOperationalMatch,
  resolveInstanceLifecycleIntent,
  resolveConsoleOperations,
} from "./operation-intent";
import {
  buildGoalRequirements,
  buildClauseRoleLedger,
  buildSourceAtomLedger,
  configIdentifierScope,
  constraintViolations,
  extractPlanConstraints,
  extractConfigReadIntent,
  hasUnsafeInstanceFilesystemPath,
  extractReadGoals,
  extractSourceGoals,
  deriveMetaPolicies,
  extractLogQueryIntent,
  requestsForSourceGoals,
  requestedGoalSteps,
  type RequestedGoal,
} from "./goal-requirements";
import { capabilityForIntentGoal } from "./intent-ir";
import { canonicalizeLogFilterGroups, compileLogFilterQuery, logEventFilters } from "./log-filter-query";
import { projectRegisteredCapabilityClauses, type RegisteredCapability } from "./capability-registry";
import { extractPluginResolveIntent } from "./plugin-resolve-intent";
export { extractPluginResolveIntent } from "./plugin-resolve-intent";

interface DraftPlanOptions {
  preferredTool?: string;
  platform?: string;
  minecraftVersion?: string;
  loader?: string;
  intentIR?: ValidatedIntentIR;
  registeredCapability?: RegisteredCapability;
}


export function draftPlan(instanceRef: string, inventoryRevision: string, intent: string, options: DraftPlanOptions = {}): TaskPlan {
  const id = `task_${randomUUID()}`;
  if (options.intentIR) return planFromIntentIR(id, instanceRef, inventoryRevision, intent, options.intentIR);
  const adjacentDomainIntent = configIdentifierScope(intent)?.maskedIntent ?? intent;
  const normalized = intent.toLowerCase();
  if (isReadonlyHealthInspection(normalized)) {
    const detectedLogArgs = extractLogQueryIntent(intent) ?? { window_minutes: 60, max_lines: 500, filters: [], filter_query: compileLogFilterQuery("读取最近日志") };
    const logArgs = { ...detectedLogArgs, max_lines: 500 };
    const requested: RequestedGoal[] = [
      { key: "server.version", description: "确认服务端类型与 Minecraft 版本", domain: "server", action: "read", target: "version", tool: "console.command", args: { command: "version" }, order: 0 },
      { key: "plugins.loaded", description: "列出当前已加载插件", domain: "plugin", action: "read", target: "loaded", tool: "console.command", args: { command: "plugins" }, order: 1 },
      { key: "logs.recent", description: "读取近期日志并检查异常证据", domain: "diagnosis", action: "diagnose", target: "recent-logs", tool: "logs.query", args: logArgs, order: 2 },
    ];
    return plan(id, instanceRef, inventoryRevision, intent, [
      { id: "s1", tool: "console.command", args: { command: "version" }, risk: "read" },
      { id: "s2", tool: "console.command", args: { command: "plugins" }, risk: "read" },
      { id: "s3", tool: "logs.query", args: logArgs, risk: "read" },
    ], [], requested);
  }
  const pluginResolve = extractPluginResolveIntent(adjacentDomainIntent);
  const pluginReadProject = pluginResolve?.project;
  const pluginProject = pluginReadProject ?? parsePluginProject(adjacentDomainIntent);
  const sourceGoals = extractSourceGoals(intent, buildClauseRoleLedger(intent));
  const requestedReads = requestsForSourceGoals(sourceGoals, extractReadGoals(intent, {
    pluginProject: pluginReadProject,
    platform: pluginResolve?.platform ?? options.platform,
    minecraftVersion: pluginResolve?.minecraftVersion ?? options.minecraftVersion,
    loader: pluginResolve?.loader ?? options.loader,
  }));
  if (options.registeredCapability?.id === "logs.registered-observation") {
    const args = options.registeredCapability.args;
    const requested: RequestedGoal[] = [
      { key: "logs.events", description: "读取匹配的日志事件", domain: "diagnosis", action: "diagnose", target: "recent-logs", tool: "logs.query", args, order: 0 },
      { key: "logs.event-count", description: "统计匹配的日志事件", domain: "diagnosis", action: "diagnose", target: "recent-logs", tool: "logs.query", args, order: 1 },
      { key: "logs.event-judgement", description: "根据匹配事件判断是否需要处理", domain: "diagnosis", action: "diagnose", target: "recent-logs", tool: "logs.query", args, order: 2 },
    ];
    const spans = options.registeredCapability.sourceSpans;
    const sourceGoals: SourceGoal[] = [
      registeredSourceGoal("sg-reg-logs-events", intent, spans, "logs.events", "diagnosis", "recent-logs", "collection"),
      { ...registeredSourceGoal("sg-reg-logs-count", intent, spans, "logs.event-count", "diagnosis", "recent-logs", "count"), depends_on: ["sg-reg-logs-events"] },
      {
        ...registeredSourceGoal("sg-reg-logs-judgement", intent, spans, "logs.event-judgement", "diagnosis", "recent-logs", "judgement"),
        depends_on: ["sg-reg-logs-events", "sg-reg-logs-count"],
        predicate: { schema_version: "goal-predicate/v1", operator: "gt", expected: true, operands: [{ goal_id: "sg-reg-logs-count", selector: "observed", domain: "diagnosis", entity: "recent-logs", result_kind: "count" }, { value: 0 }] },
      },
    ];
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "logs.query", args, risk: "read" }], [], requested, sourceGoals);
  }
  if (options.registeredCapability?.id === "plugins.loaded-inventory") {
    const args = options.registeredCapability.args;
    const requested: RequestedGoal[] = [
      { key: "plugins.loaded", description: "读取已加载插件名称", domain: "plugin", action: "read", target: "loaded", tool: "console.command", args, order: 0 },
      { key: "plugins.loaded-count", description: "统计已加载插件数量", domain: "plugin", action: "read", target: "loaded", tool: "console.command", args, order: 1 },
    ];
    const spans = options.registeredCapability.sourceSpans;
    const sourceGoals: SourceGoal[] = [
      registeredSourceGoal("sg-reg-plugins", intent, spans, "plugins.loaded", "plugin", "loaded", "collection"),
      { ...registeredSourceGoal("sg-reg-plugins-count", intent, spans, "plugins.loaded-count", "plugin", "loaded", "count"), depends_on: ["sg-reg-plugins"] },
    ];
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "console.command", args, risk: "read" }], [], requested, sourceGoals);
  }
  if (options.preferredTool === "files.list" && hasUnsafeInstanceFilesystemPath(intent)) {
    return plan(id, instanceRef, inventoryRevision, intent, [], []);
  }
  const install = pluginProject && requestedReads.some((goal) => goal.tool === "plugin.resolve")
    ? undefined
    : parseServerInstallIntent(adjacentDomainIntent);
  if (install) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "server.install",
      args: {
        platform: install.platform,
        minecraft_version: install.minecraftVersion,
        target: "/server.jar",
        accept_eula: acceptsMinecraftEula(normalized),
      },
      risk: "high",
      requires_confirmation: true,
    }], [
      // A current Minecraft ready signal is stronger than the panel's
      // asynchronous process-status transition and is the actual user goal.
      { type: "server_ready" },
    ]);
  }
  const lifecycle = resolveInstanceLifecycleIntent(adjacentDomainIntent);
  if (lifecycle && options.preferredTool !== "plugin.install") {
    const expected = lifecycle.action === "stop" ? "stopped" : "running";
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: lifecycle.tool,
      args: { target: instanceRef, timeout_seconds: 120 },
      risk: "read",
    }], [{ type: "instance_state", expected }]);
  }
  if (!lifecycle && hasInstanceLifecycleLanguage(adjacentDomainIntent) && options.preferredTool !== "plugin.install") {
    return plan(id, instanceRef, inventoryRevision, intent, [], []);
  }
  if (/shell|ssh|私钥|任意命令/.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "forbidden.shell", args: {}, risk: "forbidden" }], []);
  }
  const filesystemReads = requestedReads.filter((goal) => goal.tool === "files.list");
  const otherReads = requestedReads.filter((goal) => goal.tool !== "files.list");
  if (filesystemReads.length === 1 && otherReads.length === 0
    && !(options.preferredTool === "config.patch" && extractConfigurationPath(intent))) {
    const path = String(filesystemReads[0].args.path);
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "files.list", args: { path }, risk: "read" }], []);
  }
  if (options.preferredTool === "logs.query" && requestedReads.length > 0 && requestedReads.every((goal) => goal.tool === "logs.query")) {
    const args = requestedReads[0].args;
    return plan(id, instanceRef, inventoryRevision, intent, [{ id: "s1", tool: "logs.query", args, risk: "read" }], [], requestedReads);
  }
  const configPath = extractConfigurationPath(intent);
  const configRead = extractConfigReadIntent(intent);
  if (options.preferredTool === "config.inspect" && configRead && requestedReads.every((goal) => goal.tool === "config.inspect")) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1", tool: "config.inspect", args: { path: configRead.path, keys: configRead.keys }, risk: "read",
    }], [], requestedReads);
  }
  const configPatch = parseConfigurationPatch(intent);
  if (options.preferredTool === "config.patch" && configPatch) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "config.patch",
      args: {
        path: configPatch.path,
        patch: [{ op: "replace", key: configPatch.key, value: configPatch.value }],
        expected_revision: inventoryRevision,
      },
      risk: "medium",
      requires_confirmation: true,
      rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" },
    }, {
      id: "s2",
      tool: "config.inspect",
      args: { path: configPatch.path, expect: `${configPatch.key}=${String(configPatch.value)}` },
      risk: "read",
      purpose: "verify",
    }], [{ type: "config_semantics", expected: `${configPatch.key}=${String(configPatch.value)}` }]);
  }
  if (options.preferredTool === "config.patch" && configPath) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1", tool: "config.inspect", args: { path: configPath }, risk: "read",
    }], []);
  }
  const languageClass = classifyOperationalLanguage(adjacentDomainIntent);
  const resolvedConsoleCommands = languageClass === "none" ? [] : resolveConsoleOperations(adjacentDomainIntent);
  const fallbackConsoleCommand = languageClass === "none" || resolvedConsoleCommands.length ? undefined : extractConsoleCommandIntent(adjacentDomainIntent);
  const consoleCommands = resolvedConsoleCommands.length ? resolvedConsoleCommands : fallbackConsoleCommand ? [fallbackConsoleCommand] : [];
  if ((consoleCommands.length || requestedReads.length) && options.preferredTool !== "plugin.install") {
    const baseReadSteps = requestedGoalSteps(requestedReads);
    const steps: TaskPlan["steps"] = requestsIndependentRecheck(intent)
      ? baseReadSteps.flatMap((step, index) => [
        { ...step, id: `s${index * 2 + 1}` },
        { ...step, id: `s${index * 2 + 2}`, args: { ...step.args }, purpose: "verify" as const },
      ])
      : baseReadSteps;
    const requestedConsoleCommands = new Set(steps.filter((step) => step.tool === "console.command").map((step) => step.args.command));
    for (const consoleCommand of consoleCommands) {
      if (requestedConsoleCommands.has(consoleCommand)) continue;
      const risk = consoleCommandRisk(consoleCommand);
      steps.push({
        id: `s${steps.length + 1}`,
        tool: "console.command",
        args: { command: consoleCommand },
        risk,
        ...(risk === "medium" || risk === "high" ? { requires_confirmation: true } : {}),
      });
      if (risk !== "read") {
        const verification = consoleVerificationStep(consoleCommand, `s${steps.length + 1}`);
        if (verification) steps.push(verification);
      }
    }
    return plan(id, instanceRef, inventoryRevision, intent, steps, [], requestedReads);
  }
  if (hasPositiveOperationalMatch(intent, /(?:下载|download)/i)
    && /(?:下载|download).*(?:paper|1\.21\.1|server\.jar)|(?:paper|1\.21\.1|server\.jar).*(?:下载|download)/i.test(normalized)) {
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "logs.query",
      args: {
        url: "https://fill-data.papermc.io/v1/objects/39bd8c00b9e18de91dcabd3cc3dcfa5328685a53b7187a2f63280c22e2d287b9/paper-1.21.1-133.jar",
        target: "/server.jar",
      },
      risk: "low",
    }], []);
  }
  const viewDistance = intent.match(/(?:视距|view-distance)\D*(\d+)/i)?.[1];
  if (viewDistance) {
    const value = Number(viewDistance);
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "config.patch",
      args: { path: "server.properties", patch: [{ op: "replace", key: "view-distance", value }], expected_revision: inventoryRevision },
      risk: "medium",
      requires_confirmation: true,
      rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" },
    }, {
      id: "s2",
      tool: "config.inspect",
      args: { path: "server.properties", expect: `view-distance=${value}` },
      risk: "read",
      purpose: "verify",
    }], [{ type: "config_semantics", expected: `view-distance=${value}` }]);
  }
  if (pluginProject && options.preferredTool === "plugin.resolve") {
    const platform = pluginResolve?.platform ?? options.platform ?? "unknown";
    const minecraftVersion = pluginResolve?.minecraftVersion ?? options.minecraftVersion ?? "unknown";
    const loader = pluginResolve?.loader ?? options.loader ?? platform;
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "plugin.resolve",
      args: {
        project: pluginProject,
        source: "modrinth",
        platform,
        minecraft_version: minecraftVersion,
        loader,
      },
      risk: "low",
    }], [], requestedReads);
  }
  if (pluginProject && (options.preferredTool === "plugin.install" || /安装|部署|更新|升级|install|deploy|update/i.test(intent))) {
    const steps: TaskPlan["steps"] = [
      { id: "s1", tool: "plugin.resolve", args: {
        project: pluginProject,
        source: "modrinth",
        platform: options.platform ?? "unknown",
        minecraft_version: options.minecraftVersion ?? "unknown",
        loader: options.loader ?? options.platform ?? "unknown",
      }, risk: "low" },
      { id: "s2", tool: "plugin.install", args: { project: pluginProject, artifact_ref: "${s1.artifact}", expected_sha256: "${s1.sha256}" }, risk: "medium", requires_confirmation: true, rollback: { tool: "snapshot.restore", snapshot: "${task.snapshot}" } },
      { id: "s3", tool: "files.list", args: { path: "/plugins", expect: pluginProject }, risk: "read", purpose: "verify" },
    ];
    // Restart is never bundled into the installation confirmation. If the
    // user explicitly requests it, completion may create a separate
    // instance.restart task with its own high-risk confirmation.
    return plan(id, instanceRef, inventoryRevision, intent, steps, []);
  }
  if (/根目录|目录|文件|文件夹|list.*file|files?.*list|directory/.test(normalized)) {
    const path = isPluginDirectoryIntent(intent) ? "/plugins" : "/";
    return plan(id, instanceRef, inventoryRevision, intent, [{
      id: "s1",
      tool: "files.list",
      args: { path },
      risk: "read",
    }], []);
  }
  return plan(id, instanceRef, inventoryRevision, intent, [], []);
}

/**
 * Compile an already schema/policy-validated AI tool decision into the same
 * auditable TaskPlan envelope consumed by the existing Cloud and Go guards.
 * Business selection came from the model; this bridge only binds the selected
 * registered tool to one exact source span and its canonical policy.
 */
export function buildAgentToolCallPlan(
  instanceRef: string,
  inventoryRevision: string,
  intent: string,
  call: AgentLoopToolCall,
): TaskPlan {
  const executionArgs = { ...call.arguments };
  const suffix = call.tool === "files.list" && typeof executionArgs.suffix === "string" ? executionArgs.suffix : undefined;
  delete executionArgs.suffix;
  const step = normalizeStepPolicy({ id: "s1", tool: call.tool, args: executionArgs, risk: "read" });
  const policy = intrinsicToolPolicy(step.tool, step.args);
  const runes = [...intent];
  const lexicalClauses = buildClauseRoleLedger(intent);
  const sourceClause = lexicalClauses.find((clause) => clause.role === "domain_goal" && clause.polarity === "positive")
    ?? lexicalClauses.find((clause) => clause.role === "unknown_business_goal" && clause.polarity === "positive")
    ?? lexicalClauses.find((clause) => clause.polarity !== "negative" && !["evidence_requirement", "response_requirement"].includes(clause.role));
  const sourceText = sourceClause?.source_text ?? intent;
  const sourceStart = sourceClause?.source_start ?? 0;
  const sourceEnd = sourceClause?.source_end ?? runes.length;
  const countClause = suffix ? lexicalClauses.find((clause) => clause !== sourceClause
    && clause.polarity === "positive"
    && ["domain_goal", "unknown_business_goal"].includes(clause.role)
    && /(?:数量|总数|多少|几个|count|number|how\s+many)/iu.test(clause.source_text)) : undefined;
  const sourceGoal: SourceGoal = {
    id: "sg-agent-loop-call",
    source_text: sourceText,
    source_start: sourceStart,
    source_end: sourceEnd,
    normalized: `agent-loop:${call.tool}`,
    domain: call.tool.split(".", 1)[0] || "operation",
    entity: policyTargetForAgentStep(step),
    result_kind: call.tool === "files.list" ? "collection" : "fact",
    ...(suffix ? { filter: { field: "name", operator: "suffix" as const, value: suffix } } : {}),
    depends_on: [],
    required: true,
    status: "mapped",
  };
  const sourceGoals: SourceGoal[] = suffix ? [sourceGoal, {
    ...sourceGoal, id: "sg-agent-loop-count", normalized: `agent-loop:${call.tool}:filtered-count`,
    ...(countClause ? {
      source_text: countClause.source_text,
      source_start: countClause.source_start,
      source_end: countClause.source_end,
    } : {}),
    result_kind: "filtered_count", depends_on: [sourceGoal.id],
  }] : [sourceGoal];
  const requested: RequestedGoal[] = sourceGoals.map((goal, index) => ({
    key: goal.normalized, description: index === 0 ? call.reason : `Count entries matching ${suffix}`,
    domain: goal.domain, action: policy.action, target: goal.entity, tool: call.tool, args: step.args, order: index,
  }));
  return plan(
    `task_${randomUUID()}`,
    instanceRef,
    inventoryRevision,
    intent,
    [step],
    [],
    requested,
    sourceGoals,
    false,
  );
}

function policyTargetForAgentStep(step: TaskPlan["steps"][number]) {
  for (const key of ["path", "project", "command", "platform", "target"]) {
    const value = step.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return step.tool;
}

function planFromIntentIR(id: string, instanceRef: string, inventoryRevision: string, intent: string, ir: ValidatedIntentIR): TaskPlan {
  const steps: TaskPlan["steps"] = [];
  const stepByCapability = new Map<string, string>();
  for (const goal of ir.goals) {
    const capability = capabilityForIntentGoal(goal);
    if (!capability?.tool) continue;
    const args = intentGoalArgs(goal, ir);
    const identity = JSON.stringify([capability.tool, canonicalDigestValue(args)]);
    if (stepByCapability.has(identity)) continue;
    const step = normalizeStepPolicy({ id: `s${steps.length + 1}`, tool: capability.tool, args, risk: "read" });
    steps.push(step);
    stepByCapability.set(identity, step.id);
  }
  const verificationByExecute = new Map<string, string[]>();
  const independentGoalIds = new Set(ir.evidence_requirements.filter((value) => value.kind === "independent_verification").flatMap((value) => value.goal_ids));
  for (const goal of ir.goals.filter((value) => independentGoalIds.has(value.id))) {
    const execute = stepForIRGoal(goal, ir, steps, stepByCapability);
    if (!execute || intrinsicToolPolicy(execute.tool, execute.args).mutates) continue;
    const verify = normalizeStepPolicy({ ...execute, id: `s${steps.length + 1}`, args: { ...execute.args }, risk: "read", purpose: "verify" });
    steps.push(verify);
    verificationByExecute.set(execute.id, [verify.id]);
  }
  for (const execute of [...steps]) {
    if (execute.purpose === "verify") continue;
    const policy = intrinsicToolPolicy(execute.tool, execute.args);
    if (!policy.mutates) continue;
    const verification = deterministicVerificationStep(execute, steps.length + 1);
    if (!verification) continue;
    steps.push(normalizeStepPolicy(verification));
    verificationByExecute.set(execute.id, [verification.id]);
  }
  const sourceGoals: SourceGoal[] = ir.goals.map((goal) => ({
    id: `sg-${goal.id}`, source_text: goal.source_text, source_start: goal.source_start, source_end: goal.source_end,
    normalized: goal.capability, domain: goal.domain, entity: goal.entity, result_kind: goal.result_kind,
    ...(goal.filter ? { filter: goal.filter } : {}), ...(goal.item_schema ? { item_schema: goal.item_schema } : {}),
    depends_on: (goal.depends_on ?? []).map((dependency) => `sg-${dependency}`), required: goal.required, status: "mapped",
  }));
  for (const predicate of ir.predicates) {
    const mapped = predicate.kind === "quantifier"
      ? quantifierPredicate(predicate, ir)
      : binaryPredicate(predicate, ir);
    sourceGoals.push({
      id: `sg-${predicate.id}`, source_text: predicate.source_text, source_start: predicate.source_start, source_end: predicate.source_end,
      normalized: `predicate.${predicate.kind}`, domain: mapped.domain, entity: mapped.entity, result_kind: "judgement",
      predicate: mapped.predicate, depends_on: mapped.dependsOn, required: true, status: "mapped",
    });
  }
  const constraints = ir.constraints.map((constraint) => ({ action: constraint.action, effect: constraint.effect, source: constraint.source_text, source_start: constraint.source_start, source_end: constraint.source_end, clause_id: constraint.clause_id }));
  const acceptance: TaskPlan["acceptance"] = intentIRAcceptance(ir);
  const operation = deriveOperationObjective(intent, steps, acceptance);
  const sourceById = new Map(sourceGoals.map((source) => [source.id, source]));
  const stepIdsForSource = (source: SourceGoal, seen = new Set<string>()): string[] => {
    if (seen.has(source.id)) return [];
    seen.add(source.id);
    const irGoal = ir.goals.find((goal) => `sg-${goal.id}` === source.id);
    const direct = irGoal ? stepForIRGoal(irGoal, ir, steps, stepByCapability) : undefined;
    if (direct) return [direct.id];
    return [...new Set(source.depends_on.flatMap((dependency) => {
      const candidate = sourceById.get(dependency);
      return candidate ? stepIdsForSource(candidate, seen) : [];
    }))];
  };
  const goalRequirements: GoalRequirement[] = sourceGoals.map((source) => {
    const executeStepIds = stepIdsForSource(source);
    const directStep = steps.find((step) => executeStepIds.includes(step.id));
    return {
      id: `g-${source.id}`, description: source.source_text, domain: source.domain, action: directStep ? intrinsicToolPolicy(directStep.tool, directStep.args).action : "read",
      target: source.entity, required: source.required, source_goal_ids: [source.id], result_kind: source.result_kind,
      ...(source.filter ? { filter: source.filter } : {}), ...(source.predicate ? { predicate: remapTypedPredicate(source.predicate) } : {}),
      ...(source.depends_on.length ? { depends_on_goal_ids: source.depends_on.map((value) => `g-${value}`) } : {}),
      execute_step_ids: executeStepIds, verify_step_ids: executeStepIds.flatMap((id) => verificationByExecute.get(id) ?? []),
      evidence: [...operation.execution_evidence, ...operation.verification_evidence].filter((item) => executeStepIds.includes(item.step_id ?? "") || executeStepIds.flatMap((id) => verificationByExecute.get(id) ?? []).includes(item.step_id ?? "") || item.step_id === "terminal" || item.step_id === "acceptance"), status: "pending",
    };
  });
  const clauseLedger = ir.clauses.map((clause) => ({
    id: clause.id, source_text: clause.source_text, source_start: clause.source_start, source_end: clause.source_end,
    role: clause.role, polarity: clause.polarity, status: clause.status, reason: clause.reason,
    source_atom_ids: [...ir.goals.filter((goal) => goal.clause_id === clause.id).map((goal) => `atom-${goal.id}`), ...ir.predicates.filter((predicate) => predicate.clause_id === clause.id).map((predicate) => `atom-${predicate.id}`)],
    source_goal_ids: sourceGoals.filter((goal) => ir.goals.some((candidate) => candidate.clause_id === clause.id && `sg-${candidate.id}` === goal.id) || ir.predicates.some((candidate) => candidate.clause_id === clause.id && `sg-${candidate.id}` === goal.id)).map((goal) => goal.id),
    constraint_actions: constraints.filter((constraint) => constraint.clause_id === clause.id).map((constraint) => constraint.action),
  }));
  const sourceAtoms: TaskPlan["source_atoms"] = [
    ...ir.goals.map((goal) => ({ id: `atom-${goal.id}`, source_text: goal.source_text, source_start: goal.source_start, source_end: goal.source_end, polarity: "positive" as const, role: goal.result_kind, normalized: goal.capability, required: goal.required, status: "mapped" as const, source_goal_ids: [`sg-${goal.id}`], reason: "validated typed intent goal", clause_id: goal.clause_id })),
    ...ir.predicates.map((predicate) => ({ id: `atom-${predicate.id}`, source_text: predicate.source_text, source_start: predicate.source_start, source_end: predicate.source_end, polarity: "positive" as const, role: "judgement" as const, normalized: `predicate.${predicate.kind}`, required: true, status: "mapped" as const, source_goal_ids: [`sg-${predicate.id}`], reason: "validated typed intent predicate", clause_id: predicate.clause_id })),
  ];
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION, policy_version: OPERATION_POLICY_VERSION, policy_digest: OPERATION_POLICY_DIGEST,
    task_id: id, instance_ref: instanceRef, intent, intent_ir: ir, intent_ir_digest: ir.digest, inventory_revision: inventoryRevision, operation,
    clause_ledger: clauseLedger, clause_ledger_digest: createHash("sha256").update(JSON.stringify(canonicalDigestValue({ intent, clause_ledger: clauseLedger }))).digest("hex"),
    evidence_policy: {
      require_real_callback_per_goal: ir.evidence_requirements.some((value) => value.kind === "real_callback_per_goal"),
      require_independent_verification: ir.evidence_requirements.some((value) => value.kind === "independent_verification"),
      clause_ids: ir.evidence_requirements.map((value) => value.clause_id),
    },
    response_policy: {
      cover_all_required_goals: ir.response_requirements.some((value) => value.kind === "cover_all" || value.kind === "synthesis"),
      require_synthesis: ir.response_requirements.some((value) => value.kind === "synthesis"),
      clause_ids: ir.response_requirements.map((value) => value.clause_id),
    },
    source_atoms: sourceAtoms, source_atom_digest: sourceAtomDigest(intent, sourceAtoms), source_goals: sourceGoals,
    source_goal_digest: sourceGoalDigest(intent, sourceGoals, sourceAtoms), goal_requirements: goalRequirements,
    constraints, coverage: ir.unknown_goals.length || goalRequirements.some((goal) => !goal.execute_step_ids.length && !goal.depends_on_goal_ids?.length) ? "waiting" : "full",
    steps, acceptance,
  };
}

function intentIRAcceptance(ir: ValidatedIntentIR): TaskPlan["acceptance"] {
  const rules: TaskPlan["acceptance"] = [];
  for (const goal of ir.goals) {
    if (goal.capability === "instance.start" || goal.capability === "instance.restart") rules.push({ type: "instance_state", expected: "running" });
    else if (goal.capability === "instance.stop") rules.push({ type: "instance_state", expected: "stopped" });
    else if (goal.capability === "server.install") rules.push({ type: "server_ready" });
    else if (goal.capability === "plugin.install") rules.push({ type: "plugin_enabled", name: String(goal.parameters.project ?? goal.entity) });
  }
  return rules;
}

function deterministicVerificationStep(execute: TaskPlan["steps"][number], order: number): TaskPlan["steps"][number] | undefined {
  if (execute.tool === "plugin.install") return { id: `s${order}`, tool: "files.list", args: { path: "/plugins" }, risk: "read", purpose: "verify" };
  if (execute.tool === "config.patch" && typeof execute.args.path === "string") return { id: `s${order}`, tool: "config.inspect", args: { path: execute.args.path }, risk: "read", purpose: "verify" };
  if (execute.tool === "console.command") {
    const command = String(execute.args.command ?? "").trim().split(/\s+/);
    let readback = "";
    if (command[0]?.toLowerCase() === "difficulty") readback = "difficulty";
    else if (command[0]?.toLowerCase() === "time") readback = "time query daytime";
    else if (command[0]?.toLowerCase() === "gamerule" && command[1]) readback = `gamerule ${command[1]}`;
    else if (command[0]?.toLowerCase() === "whitelist") readback = "whitelist list";
    else if (command[0]?.toLowerCase() === "gamemode" && command[2]) readback = `data get entity ${command[2]} playergametype`;
    if (readback) return { id: `s${order}`, tool: "console.command", args: { command: readback }, risk: "read", purpose: "verify" };
  }
  return undefined;
}

function stepForIRGoal(goal: ValidatedIntentIR["goals"][number], ir: ValidatedIntentIR, steps: TaskPlan["steps"], index: Map<string, string>) {
  const capability = capabilityForIntentGoal(goal);
  if (!capability?.tool) return undefined;
  const args = intentGoalArgs(goal, ir);
  const id = index.get(JSON.stringify([capability.tool, canonicalDigestValue(args)]));
  return steps.find((step) => step.id === id);
}

function intentGoalArgs(goal: ValidatedIntentIR["goals"][number], ir: ValidatedIntentIR): Record<string, unknown> {
  const args: Record<string, unknown> = { ...goal.parameters };
  if (goal.capability === "logs.query" && "filter_groups" in args) {
    const canonical = canonicalizeLogFilterGroups(args.filter_groups);
    if (canonical.ok) {
      args.filter_query = canonical.query;
      args.filters = logEventFilters(canonical.query);
    }
  }
  for (const scope of ir.scopes.filter((value) => value.goal_id === goal.id)) args[scope.kind] = scope.value;
  return args;
}

function quantifierPredicate(predicate: Extract<ValidatedIntentIR["predicates"][number], { kind: "quantifier" }>, ir: ValidatedIntentIR) {
  const collection = ir.goals.find((goal) => goal.id === predicate.collection_goal_id)!;
  const span = { source_text: predicate.source_text, source_start: predicate.source_start, source_end: predicate.source_end };
  const left = { goal_id: `sg-${collection.id}`, selector: "filtered_count" as const, filter: predicate.filter, domain: collection.domain, entity: collection.entity, result_kind: collection.result_kind, ...span, source_role: "left" as const };
  const right = predicate.quantifier === "any"
    ? { value: 0, ...span, source_role: "right" as const }
    : { goal_id: `sg-${collection.id}`, selector: "count" as const, domain: collection.domain, entity: collection.entity, result_kind: collection.result_kind, ...span, source_role: "right" as const };
  return { domain: collection.domain, entity: collection.entity, dependsOn: [`sg-${collection.id}`], predicate: { schema_version: "goal-predicate/v2" as const, operator: predicate.quantifier === "any" ? "gt" as const : "equals" as const, operands: [left, right], left, right, quantifier: predicate.quantifier, filter: predicate.filter, expected: predicate.expected } };
}

function binaryPredicate(predicate: Extract<ValidatedIntentIR["predicates"][number], { kind: "binary" }>, ir: ValidatedIntentIR) {
  const toOperand = (operand: typeof predicate.left, role: "left" | "right") => {
    const goal = operand.goal_id ? ir.goals.find((value) => value.id === operand.goal_id) : undefined;
    return { ...(operand.goal_id ? { goal_id: `sg-${operand.goal_id}` } : {}), ...(operand.selector ? { selector: operand.selector } : {}), ...(operand.value !== undefined ? { value: operand.value } : {}), ...(goal ? { domain: goal.domain, entity: goal.entity, result_kind: goal.result_kind } : {}), source_text: operand.source_text, source_start: operand.source_start, source_end: operand.source_end, source_role: role };
  };
  const left = toOperand(predicate.left, "left"); const right = toOperand(predicate.right, "right");
  const owner = predicate.left.goal_id ? ir.goals.find((goal) => goal.id === predicate.left.goal_id)! : ir.goals.find((goal) => goal.id === predicate.right.goal_id)!;
  return { domain: owner.domain, entity: owner.entity, dependsOn: [predicate.left.goal_id, predicate.right.goal_id].filter(Boolean).map((value) => `sg-${value}`), predicate: { schema_version: "goal-predicate/v2" as const, operator: predicate.operator, operands: [left, right], left, right, expected: predicate.expected } };
}

function remapTypedPredicate(predicate: GoalPredicate): GoalPredicate {
  const mapOperand = (operand: GoalPredicate["operands"][number]): GoalPredicate["operands"][number] => ({ ...operand, ...(operand.goal_id ? { goal_id: `g-${operand.goal_id}` } : {}), ...(operand.predicate ? { predicate: remapTypedPredicate(operand.predicate) } : {}) });
  return { ...predicate, operands: predicate.operands.map(mapOperand), ...(predicate.left ? { left: mapOperand(predicate.left) } : {}), ...(predicate.right ? { right: mapOperand(predicate.right) } : {}) };
}

function requestsIndependentRecheck(intent: string) {
  return /(?:独立复验|再次核对|二次确认|重新读取验证|independent(?:ly)?\s+(?:recheck|verification)|read\s+again\s+to\s+verify|verify\s+with\s+a\s+second\s+read)/i.test(intent);
}

const readonlyHealthSkillIntent = [
  "对当前实例完成一次只读健康检查：",
  "1. 在 Minecraft 控制台执行 version，确认服务端类型和 Minecraft 版本；",
  "2. 在 Minecraft 控制台执行 plugins，列出已加载插件；",
  "3. 读取最近 60 分钟日志，检查 ERROR、WARN、崩溃、Watchdog、Can't keep up 或卡顿证据；",
  "4. 等待每个工具的真实回调后再继续，最后给出综合健康结论和证据摘要。",
  "不得修改配置、安装内容、重启或停止服务器。",
].join("\n");

export function expandOperationalSkill(intent: string) {
  const message = intent.trim();
  if (!message || /(?:怎么|如何|原理|教程|一般|是什么|what\s+is|how\s+to)/i.test(message)) return undefined;
  const explicitHealth = /(?:健康检查|健康巡检|(?:服务|服务器|服务端|实例).{0,4}巡检|全面体检|只读巡检|health\s*check)/i.test(message);
  const shortHealthRequest = /(?:检查|查看|看看|查查|诊断|评估).{0,10}(?:当前|这台|这个)?(?:服务|实例|服务器|服务端).{0,8}(?:健康|状态|情况|问题|异常|故障|正常)|(?:当前|这台|这个)?(?:服务|实例|服务器|服务端).{0,8}(?:健康吗|正常吗|有没有问题|有问题吗|是否异常|有无异常|是否故障)/i.test(message);
  return explicitHealth || shortHealthRequest ? readonlyHealthSkillIntent : undefined;
}

export function explicitPluginInstallProject(intent: string) {
  const project = parsePluginProject(intent);
  if (!project || !hasPositiveOperationalMatch(intent, /(?:安装|部署|更新|升级|install|deploy|update)/i)) return undefined;
  return project;
}

function isReadonlyHealthInspection(intent: string) {
  if (expandOperationalSkill(intent)) return true;
  const asksForInspection = /(?:只读|健康检查|健康巡检|综合检查|完整检查|health\s*check|inspection)/i.test(intent);
  const asksForVersion = /(?:\bversion\b|版本|服务端类型)/i.test(intent);
  const asksForPlugins = /(?:\bplugins?\b|插件)/i.test(intent);
  const asksForLogs = /(?:日志|\blogs?\b|error|warn|崩溃|卡顿)/i.test(intent);
  return asksForInspection && asksForVersion && asksForPlugins && asksForLogs;
}

function parsePluginProject(intent: string) {
  const metadata = extractPluginResolveIntent(intent);
  if (metadata) return metadata.project;
  const source = intent.split(/\n\s*\nAgent operation:\s*/i)[0];
  const candidates: Array<{ value: string; score: number; index: number }> = [];
  const collect = (pattern: RegExp, score: number) => {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value && /^[a-z0-9][a-z0-9_-]{1,63}$/i.test(value)) {
        candidates.push({ value, score: score + (/[A-Z]/.test(value) ? 20 : 0), index: match.index ?? 0 });
      }
    }
  };
  collect(/\b([a-z0-9][a-z0-9_-]{1,63})\s*(?:插件|plugin)/gi, 100);
  collect(/\b(?:can|could|is)\s+([a-z0-9][a-z0-9_-]{1,63})\s+(?:be\s+)?(?:installed|installable|deployed|compatible)\b/gi, 120);
  collect(/\b([A-Z][A-Za-z0-9_-]{1,63})\s+(?:能不能|是否|能否|可不可以|可以)?\s*(?:安装|装|部署|更新|升级|install)/g, 90);
  collect(/(?:解析|查询|查找|搜索|校验|确认)\s+([a-z0-9][a-z0-9_-]{1,63})/gi, 80);
  collect(/(?:安装|部署|更新|升级)\s+([a-z0-9][a-z0-9_-]{1,63})/gi, 85);
  collect(/\b(?:resolve|find|query|search|check)\s+(?:the\s+)?(?:compatible\s+)?([A-Z][A-Za-z0-9_-]{1,63})\b/gi, 75);
  const selected = candidates.sort((left, right) => right.score - left.score || left.index - right.index)[0];
  if (!selected || selected.score < 80) return undefined;
  if (["minecraft", "server", "paper", "fabric", "forge", "spigot", "version", "current"].includes(selected.value.toLowerCase())) return undefined;
  return selected.value.toLowerCase() === "essentials" ? "essentialsx" : selected.value.toLowerCase();
}

function extractConfigurationPath(intent: string) {
  const marker = intent.match(/\bMCAI_CONFIG\s+path=([^\s]+\.(?:ya?ml|json|properties|conf))\b/i)?.[1];
  const natural = intent.match(/\b((?:plugins|config)\/[A-Za-z0-9_.\/-]+\.(?:ya?ml|json|properties|conf)|server\.properties)\b/i)?.[1];
  return (marker ?? natural)?.replace(/^\//, "");
}

function parseConfigurationPatch(intent: string): { path: string; key: string; value: unknown } | undefined {
  const path = extractConfigurationPath(intent);
  if (!path) return undefined;
  const marker = intent.match(/\bMCAI_CONFIG\s+path=[^\s]+\s+key=([A-Za-z0-9_.-]+)\s+value_json=([^\r\n]+)/i);
  if (marker) {
    try {
      return { path, key: marker[1], value: JSON.parse(marker[2].trim()) };
    } catch {
      return undefined;
    }
  }
  const natural = intent.match(/(?:配置项|键|key)\s*[：:=]\s*([A-Za-z0-9_.-]+)[^\r\n]{0,32}?(?:设为|设置为|改为|value\s*[：:=]|to)\s*["“]?([^"”\r\n]+)["”]?/i);
  if (!natural) return undefined;
  const raw = natural[2].trim();
  let value: unknown = raw;
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(raw)) {
    try { value = JSON.parse(raw.toLowerCase()); } catch { value = raw; }
  }
  return { path, key: natural[1], value };
}

function parseServerInstallIntent(intent: string) {
  const isInstallAction = hasPositiveOperationalMatch(intent, /(?:download|install|setup|deploy|launch|start|create|\u4e0b\u8f7d|\u5b89\u88c5|\u90e8\u7f72|\u542f\u52a8|\u5f00\u670d|\u521b\u5efa|\u8fd0\u884c)/i);
  if (!isInstallAction) return undefined;
  const platform = /\bpaper\b/i.test(intent) ? "paper" : /\bfabric\b/i.test(intent) ? "fabric" : undefined;
  const minecraftVersion = intent.match(/(?:minecraft|mc|\u7248\u672c|version)?\s*(\d+\.\d+(?:\.\d+)?(?:-[a-z0-9._-]+)?)/i)?.[1];
  if (!platform || !minecraftVersion) return undefined;
  return { platform, minecraftVersion };
}

function acceptsMinecraftEula(intent: string) {
  const consent = /(?:\b(?:i\s+)?accept\b|\bagree\b|同意|接受)/i;
  const eula = /(?:minecraft\s+)?eula/i;
  const consentMatch = intent.match(consent);
  const eulaMatch = intent.match(eula);
  return Boolean(consentMatch && eulaMatch && Math.abs((consentMatch.index ?? 0) - (eulaMatch.index ?? 0)) <= 80);
}

export function extractConsoleCommandIntent(intent: string) {
  const explicit = extractExplicitConsoleCommand(intent);
  if (explicit) return explicit;
  const title = extractTitleConsoleCommand(intent);
  if (title) return title;
  const actionbar = extractActionbarConsoleCommand(intent);
  if (actionbar) return actionbar;
  const broadcast = extractBroadcastConsoleCommand(intent);
  if (broadcast) return broadcast;

  const difficultyChange = intent.match(
    /(?:把|将|设置|调整|修改|改成|调成|set|change).{0,20}(?:游戏|服务器|世界)?\s*(?:难度|difficulty).{0,12}(?:为|成|到|to)?\s*(和平|简单|普通|困难|peaceful|easy|normal|hard)|(?:游戏|服务器|世界)?\s*(?:难度|difficulty).{0,12}(?:设置|调整|修改|改成|调成|set|change).{0,12}(?:为|成|到|to)?\s*(和平|简单|普通|困难|peaceful|easy|normal|hard)/i,
  );
  if (difficultyChange) {
    const value = (difficultyChange[1] ?? difficultyChange[2]).toLowerCase();
    const modes: Record<string, string> = { 和平: "peaceful", 简单: "easy", 普通: "normal", 困难: "hard" };
    return `difficulty ${modes[value] ?? value}`;
  }
  if (/(?:查询|查看|读取|确认|告诉我|当前|现在|what|show|check).{0,16}(?:游戏|服务器|世界)?\s*(?:难度|difficulty)|(?:游戏|服务器|世界)?\s*(?:难度|difficulty).{0,16}(?:是什么|多少|查询|查看|读取|确认|当前|现在|what|show|check)/i.test(intent)) {
    return "difficulty";
  }

  // Common read-only operations should stay available even when the model
  // gateway is busy. They map to the same audited console tool as explicit
  // commands and never bypass the instance binding or risk policy.
  if (/\b(?:online players?|player count)\b|\u5728\u7ebf.{0,8}\u73a9\u5bb6|\u73a9\u5bb6.{0,8}\u5728\u7ebf|\u591a\u5c11.{0,4}\u73a9\u5bb6|\u5728\u7ebf.{0,4}\u4eba\u6570/i.test(intent)) {
    return "list";
  }
  if (/\b(?:tps|mspt)\b/i.test(intent)) return /\bmspt\b/i.test(intent) ? "mspt" : "tps";
  if (/\b(?:server version|minecraft version)\b|\u670d\u52a1\u7aef.{0,4}\u7248\u672c|\u670d\u52a1\u5668.{0,4}\u7248\u672c/i.test(intent)) {
    return "version";
  }
  const explicitlyRequestsPluginFiles = isPluginDirectoryIntent(intent);
  if (!explicitlyRequestsPluginFiles && (/\b(?:plugin list|installed plugins?|what plugins?)\b|插件.{0,8}(?:列表|有哪些|有什么|多少|已安装)|(?:查看|查询|列出|显示).{0,10}(?:服务器|服务端|当前)?\s*插件|已安装.{0,4}插件/i.test(intent))) {
    return "plugins";
  }
  return undefined;
}

export function extractFilesListIntent(intent: string) {
  if (isPluginDirectoryIntent(intent)
    && /(?:查看|读取|列出|显示|检查|打开|里面|内容|文件|目录|我说|show|read|list|inspect)/i.test(intent)) {
    return "列出当前实例 /plugins 目录并返回实际插件文件清单";
  }
  const filesystemGoals = extractSourceGoals(intent).filter((goal) => goal.domain === "filesystem" && goal.status === "mapped");
  if (!filesystemGoals.some((goal) => goal.result_kind === "collection")) return undefined;
  if (!filesystemGoals.some((goal) => ["collection", "count", "filtered_count"].includes(goal.result_kind))) return undefined;
  return intent;
}

export function extractConfigInspectIntent(intent: string) {
  return extractConfigReadIntent(intent);
}

function isPluginDirectoryIntent(intent: string) {
  return /(?:\/plugins\b|plugins[\\/]|plugins\s*(?:目录|文件夹|folder|directory)|插件\s*(?:目录|文件夹|文件|jar))/i.test(intent);
}

export function extractRealtimeLogIntent(intent: string) {
  const message = intent.trim();
  const logSubject = /日志|崩服|崩溃|报错|错误|异常|卡服|无响应|logs?|crash(?:ed|es)?|errors?|exceptions?|stack\s*trace/i;
  if (!message || !logSubject.test(message)) return undefined;
  const realtimeSignal = /读取|查看|查询|检查|调取|获取|排查|诊断|最近|刚才|当前|实时|这台|这个实例|原因|为什么|read|show|query|check|inspect|fetch|recent|current|live|diagnos|why|cause/i;
  return realtimeSignal.test(message) ? message : undefined;
}

function consoleCommandRisk(command: string): RiskLevel {
  return intrinsicToolPolicy("console.command", { command }).risk;
}

function consoleVerificationStep(command: string, id = "s2"): TaskPlan["steps"][number] | undefined {
  const normalized = command.trim().replace(/^minecraft:/i, "");
  const parts = normalized.split(/\s+/);
  const verb = parts[0]?.toLowerCase() ?? "";
  let verificationCommand: string | undefined;
  if (verb === "difficulty") verificationCommand = "difficulty";
  else if (verb === "time") verificationCommand = "time query daytime";
  else if (verb === "gamerule" && parts[1]) verificationCommand = `gamerule ${parts[1]}`;
  else if (verb === "whitelist") verificationCommand = "whitelist list";

  if (verb === "whitelist" && ["on", "off"].includes(parts[1] ?? "")) {
    return {
      id,
      tool: "config.inspect",
      args: { path: "server.properties", expect: `white-list=${parts[1] === "on" ? "true" : "false"}` },
      risk: "read",
      purpose: "verify",
    };
  }
  if (verb === "gamemode" && parts[2]) {
    const gameModeIds: Record<string, string> = { survival: "0", creative: "1", adventure: "2", spectator: "3" };
    return {
      id,
      tool: "console.command",
      args: { command: `data get entity ${parts[2]} playerGameType`, expect: `value ${gameModeIds[parts[1]] ?? ""}`.trim() },
      risk: "read",
      purpose: "verify",
    };
  }

  if (verificationCommand) {
    const expected = verb === "difficulty" ? parts.at(-1)
      : verb === "gamerule" ? parts.at(-1)
        : verb === "whitelist" && ["add", "remove"].includes(parts[1] ?? "") ? parts.at(-1)
          : undefined;
    return {
      id,
      tool: "console.command",
      args: { command: verificationCommand, ...(expected ? { expect: expected } : {}) },
      risk: "read",
      purpose: "verify",
    };
  }
  return undefined;
}

function plan(
  id: string,
  instanceRef: string,
  inventoryRevision: string,
  intent: string,
  steps: TaskPlan["steps"],
  acceptance: TaskPlan["acceptance"],
  requested: RequestedGoal[] = [],
  suppliedSourceGoals: SourceGoal[] = [],
  projectRegisteredSources = true,
): TaskPlan {
  const extractedClauseLedger = buildClauseRoleLedger(intent);
  const clauseLedger = suppliedSourceGoals.length && projectRegisteredSources
    ? projectRegisteredCapabilityClauses(intent, extractedClauseLedger, suppliedSourceGoals)
    : extractedClauseLedger;
  const extractedSourceGoals = suppliedSourceGoals.length ? suppliedSourceGoals : extractSourceGoals(intent, clauseLedger);
  const constraints = extractPlanConstraints(intent, clauseLedger);
  const metaPolicies = deriveMetaPolicies(clauseLedger);
  const normalizedSteps = steps.map((step) => {
    if (step.tool !== "logs.query") return step;
    const extracted = extractLogQueryIntent(intent);
    const existing = step.args.filter_query ?? extracted?.filter_query;
    const filterQuery = existing && typeof existing === "object" ? existing as ReturnType<typeof compileLogFilterQuery> : compileLogFilterQuery(intent);
    return { ...step, args: { ...step.args, filter_query: filterQuery, filters: logEventFilters(filterQuery) } };
  }).map(normalizeStepPolicy);
  const violations = constraintViolations(normalizedSteps, constraints);
  const safeSteps = normalizedSteps.filter((step) => !violations.some((violation) => violation.id === step.id));
  const sourceGoals = extractedSourceGoals.length ? extractedSourceGoals : safeSteps.filter((step) => step.purpose !== "verify").slice(0, 1).map((step) => ({
    id: "sg-1-operation-intent",
    source_text: intent,
    source_start: 0,
    source_end: [...intent].length,
    normalized: "operation.intent",
    domain: step.tool.split(".", 1)[0] ?? "operation",
    entity: String(step.args.path ?? step.args.project ?? step.args.command ?? step.args.platform ?? step.tool),
    result_kind: "fact" as const,
    depends_on: [],
    required: true,
    status: "mapped" as const,
  }));
  const initialOperation = deriveOperationObjective(intent, safeSteps, acceptance);
  const initialRequirements = buildGoalRequirements(intent, safeSteps, initialOperation, requestsForSourceGoals(sourceGoals, requested), sourceGoals);
  const tracedStepIds = new Set(initialRequirements.goals.flatMap((goal) => [...goal.execute_step_ids, ...goal.verify_step_ids]));
  const readOnlyPlan = safeSteps.every((step) => !intrinsicToolPolicy(step.tool, step.args).mutates);
  const tracedSteps = readOnlyPlan && requested.length
    ? safeSteps.filter((step) => tracedStepIds.has(step.id) || requested.some((goal) => requestedStepMatches(step, goal)))
    : safeSteps;
  const operation = deriveOperationObjective(intent, tracedSteps, acceptance);
  const requirements = buildGoalRequirements(intent, tracedSteps, operation, requestsForSourceGoals(sourceGoals, requested), sourceGoals);
  const goalRequirements = requirements.goals;
  const sourceAtoms = buildSourceAtomLedger(intent, clauseLedger, sourceGoals, constraints);
  const requiredAtoms = sourceAtoms.filter((atom) => atom.required && atom.polarity === "positive");
  const atomCoverage = requiredAtoms.every((atom) => atom.status === "mapped" && atom.source_goal_ids.length === 1);
  const coverage = atomCoverage ? requirements.coverage : requirements.coverage === "waiting" ? "waiting" : "partial";
  return {
    schema_version: TASK_PLAN_SCHEMA_VERSION,
    policy_version: OPERATION_POLICY_VERSION,
    policy_digest: OPERATION_POLICY_DIGEST,
    task_id: id,
    instance_ref: instanceRef,
    intent,
    inventory_revision: inventoryRevision,
    operation,
    clause_ledger: clauseLedger,
    clause_ledger_digest: createHash("sha256").update(JSON.stringify(canonicalDigestValue({ intent, clause_ledger: clauseLedger }))).digest("hex"),
    evidence_policy: metaPolicies.evidence,
    response_policy: metaPolicies.response,
    source_atoms: sourceAtoms,
    source_atom_digest: sourceAtomDigest(intent, sourceAtoms),
    source_goals: sourceGoals,
    source_goal_digest: sourceGoalDigest(intent, sourceGoals, sourceAtoms),
    goal_requirements: goalRequirements,
    constraints,
    coverage,
    steps: tracedSteps,
    acceptance,
  };
}

function registeredSourceGoal(
  id: string,
  intent: string,
  spans: Array<{ start: number; end: number; text: string }>,
  normalized: string,
  domain: string,
  entity: string,
  resultKind: SourceGoal["result_kind"],
): SourceGoal {
  const start = Math.min(...spans.map((span) => span.start));
  const end = Math.max(...spans.map((span) => span.end));
  return {
    id, source_text: intent.slice(start, end), source_start: [...intent.slice(0, start)].length,
    source_end: [...intent.slice(0, end)].length, normalized, domain, entity, result_kind: resultKind,
    depends_on: [], required: true, status: "mapped",
  };
}


function requestedStepMatches(step: TaskPlan["steps"][number], goal: RequestedGoal) {
  if (step.tool !== goal.tool) return false;
  if (step.tool === "console.command") return String(step.args.command ?? "").toLowerCase() === String(goal.args.command ?? "").toLowerCase();
  if (step.tool === "files.list" || step.tool === "config.inspect") return String(step.args.path ?? "") === String(goal.args.path ?? "");
  if (step.tool === "plugin.resolve") return String(step.args.project ?? "").toLowerCase() === String(goal.args.project ?? "").toLowerCase();
  if (step.tool === "logs.query") return true;
  return JSON.stringify(step.args) === JSON.stringify(goal.args);
}

function sourceAtomDigest(intent: string, sourceAtoms: TaskPlan["source_atoms"]) {
  return createHash("sha256").update(JSON.stringify(canonicalDigestValue({ intent, source_atoms: sourceAtoms }))).digest("hex");
}

function sourceGoalDigest(intent: string, sourceGoals: TaskPlan["source_goals"], sourceAtoms: TaskPlan["source_atoms"]) {
  const normalized = sourceGoals.map((goal) => ({
    id: goal.id, source_text: goal.source_text, source_start: goal.source_start, source_end: goal.source_end,
    normalized: goal.normalized, domain: goal.domain, entity: goal.entity, result_kind: goal.result_kind,
    filter: goal.filter ?? null, item_schema: goal.item_schema ?? null, predicate: goal.predicate ?? null, depends_on: goal.depends_on, required: goal.required, status: goal.status,
  }));
  return createHash("sha256").update(JSON.stringify(canonicalDigestValue({ intent, source_atoms: sourceAtoms, source_goals: normalized }))).digest("hex");
}

function canonicalDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDigestValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalDigestValue(item)]));
  return value;
}
