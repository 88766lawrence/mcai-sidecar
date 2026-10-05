export interface TypedCompletionGoal {
  id: string;
  domain: string;
  target: string;
  resultKind: string;
  filter?: { field: string; operator: string; value: string };
  required: boolean;
  semanticKey?: string;
}

export interface TypedCompletionResult {
  goalId: string;
  status: string;
  observed?: unknown;
  capacity?: number;
}

export interface TypedCompletionContext {
  intent: string;
  state: string;
  action: string;
  goals: TypedCompletionGoal[];
  results: TypedCompletionResult[];
}

interface ResultGroup {
  domain: string;
  target: string;
  filter?: TypedCompletionGoal["filter"];
  collection?: unknown[];
  count?: number;
  judgement?: boolean;
  judgementKey?: string;
  facts: Array<{ goal: TypedCompletionGoal; value: unknown; capacity?: number }>;
}

export function renderTypedReadCompletion(context: TypedCompletionContext): string | undefined {
  if (context.state !== "SUCCEEDED" || !["read", "diagnose"].includes(context.action)) return undefined;
  const required = context.goals.filter((goal) => goal.required);
  if (!required.length) return undefined;
  const byResult = new Map(context.results.map((result) => [result.goalId, result]));
  if (required.some((goal) => {
    const result = byResult.get(goal.id);
    return !result || result.status !== "satisfied" || result.observed === undefined;
  })) return undefined;

  const groups = new Map<string, ResultGroup>();
  for (const goal of required) {
    const result = byResult.get(goal.id)!;
    const value = result.observed;
    const key = groupKey(goal);
    const group = groups.get(key) ?? { domain: goal.domain, target: goal.target, filter: goal.filter, facts: [] };
    if (goal.resultKind === "collection") {
      if (!Array.isArray(value)) return undefined;
      group.collection = value;
    } else if (["count", "filtered_count"].includes(goal.resultKind)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
      group.count = value;
    } else if (goal.resultKind === "judgement") {
      if (!(goal.domain === "diagnosis" && goal.target === "recent-logs")
        && !(goal.domain === "world" && ["world.difficulty-peaceful", "world.day-period", "world.gametime-positive"].includes(goal.semanticKey ?? ""))
        && !(goal.domain === "gamerule" && (goal.semanticKey ?? "").startsWith("gamerule.judgement:"))
        && !(goal.domain === "performance" && goal.target === "resource-pressure")) return undefined;
      if (typeof value !== "boolean") return undefined;
      group.judgement = value;
      group.judgementKey = goal.semanticKey;
    } else if (["fact", "metric"].includes(goal.resultKind)) {
      group.facts.push({ goal, value, capacity: result.capacity });
    } else {
      return undefined;
    }
    groups.set(key, group);
  }

  const chinese = /[\p{Script=Han}]/u.test(context.intent);
  const handlingJudgement = /(?:需要|要不要|需不需要).{0,8}(?:处理|干预|处置)|(?:action|intervention|attention)\s+is\s+(?:needed|required)|needs?\s+(?:action|intervention|attention)/i.test(context.intent);
  const rendered: string[] = [];
  const consumed = new Set<string>();
  const loadedPlugins = [...groups.entries()].find(([, group]) => group.domain === "plugin" && group.target === "loaded");
  if (loadedPlugins) {
    const [key, group] = loadedPlugins;
    const collection = group.collection;
    const count = group.count;
    if (!collection || count === undefined || count !== collection.length || !collection.every(isDisplayScalar)) return undefined;
    consumed.add(key);
    const items = collection.map(displayScalar);
    rendered.push(chinese
      ? count ? `\u5f53\u524d\u5df2\u52a0\u8f7d ${count} \u4e2a\u63d2\u4ef6\uff1a\n${bullets(items)}` : "\u5f53\u524d\u6ca1\u6709\u5df2\u52a0\u8f7d\u7684\u63d2\u4ef6\uff0c\u6570\u91cf\u4e3a 0\u3002"
      : count ? `${count} plugins are currently loaded:\n${bullets(items)}` : "No plugins are currently loaded; count: 0.");
  }
  const occupancyCountGoal = required.find((goal) => goal.semanticKey === "players.online-count"
    || (goal.domain === "players" && goal.target === "online" && ["collection", "count"].includes(goal.resultKind)));
  const occupancyCapacityGoal = required.find((goal) => goal.semanticKey === "config.value:server.properties:max-players"
    || (goal.domain === "config" && goal.target === "server.properties#max-players" && goal.resultKind === "fact"));
  const occupancyRatioGoal = required.find((goal) => goal.semanticKey === "players.occupancy-ratio"
    || (goal.domain === "players" && goal.target === "occupancy" && goal.resultKind === "fact"));
  const occupancyCount = occupancyCountGoal ? [groupKey(occupancyCountGoal), groups.get(groupKey(occupancyCountGoal))] as const : undefined;
  const occupancyCapacity = occupancyCapacityGoal ? [groupKey(occupancyCapacityGoal), groups.get(groupKey(occupancyCapacityGoal))] as const : undefined;
  const occupancyRatio = occupancyRatioGoal ? [groupKey(occupancyRatioGoal), groups.get(groupKey(occupancyRatioGoal))] as const : undefined;
  if (occupancyCount?.[1] && occupancyCapacity?.[1] && occupancyRatio?.[1]) {
    const online = occupancyCount[1].count ?? occupancyCount[1].collection?.length;
    const capacity = Number(occupancyCapacity[1].facts[0].value);
    const ratio = Number(occupancyRatio[1].facts[0].value);
    if (online === undefined || !Number.isSafeInteger(online) || online < 0
      || !Number.isSafeInteger(capacity) || capacity <= 0 || online > capacity
      || !Number.isFinite(ratio) || ratio < 0 || ratio > 1
      || Math.abs(ratio - online / capacity) > 0.000_001) return undefined;
    const percent = `${Number((ratio * 100).toFixed(2))}%`;
    rendered.push(chinese
      ? `当前在线 ${online} 人，玩家上限 ${capacity} 人，占用率 ${percent}。`
      : `${online} ${online === 1 ? "player is" : "players are"} online out of a capacity of ${capacity}; occupancy is ${percent}.`);
    consumed.add(occupancyCount[0]);
    consumed.add(occupancyCapacity[0]);
    consumed.add(occupancyRatio[0]);
  }
  if (occupancyCount?.[1] && occupancyCapacity?.[1] && !occupancyRatioGoal) {
    const online = occupancyCount[1].count ?? occupancyCount[1].collection?.length;
    const capacity = Number(occupancyCapacity[1].facts[0].value);
    if (online === undefined || !Number.isSafeInteger(online) || online < 0
      || !Number.isSafeInteger(capacity) || capacity <= 0 || online > capacity) return undefined;
    rendered.push(chinese
      ? `当前在线 ${online} 人，最大容量 ${capacity} 人。`
      : `${online} ${online === 1 ? "player is" : "players are"} currently online; maximum capacity is ${capacity}.`);
    consumed.add(occupancyCount[0]);
    consumed.add(occupancyCapacity[0]);
  }
  const configFacts = [...groups.entries()].filter(([, group]) => group.domain === "config" && group.facts.length === 1 && isDisplayScalar(group.facts[0].value));
  if (configFacts.length >= 2) {
    const byKey = new Map(configFacts.map(([key, group]) => [group.target.slice(group.target.lastIndexOf("#") + 1).toLowerCase(), { key, group }]));
    const ip = byKey.get("server-ip");
    const port = byKey.get("server-port");
    if (ip && port && /(?:监听|绑定|listen|bind)/i.test(context.intent)) {
      const rawIp = String(ip.group.facts[0].value);
      const rawPort = String(port.group.facts[0].value);
      rendered.push(chinese
        ? `${rawIp ? `当前固定绑定地址为 ${rawIp}` : "当前未指定固定绑定地址，服务端按默认可用网络接口监听"}，端口为 ${rawPort}。`
        : `${rawIp ? `The server is bound to ${rawIp}` : "No fixed bind address is configured; the server listens on the default available network interfaces"}, on port ${rawPort}.`);
      consumed.add(ip.key); consumed.add(port.key);
    } else if (/(?:概括|总结|策略|summary|summari[sz]e|policy)/i.test(context.intent)) {
      const clauses = configFacts.map(([key, group]) => {
        consumed.add(key);
        const label = group.target.slice(group.target.lastIndexOf("#") + 1);
        const value = String(group.facts[0].value);
        return chinese ? `${label} 为 ${value}` : `${label} is ${value}`;
      });
      rendered.push(chinese ? `当前配置：${clauses.join("；")}。策略概括：${clauses.map(humanizeBooleanPolicy).join("；")}。`
        : `Current configuration: ${clauses.join("; ")}. Policy summary: ${clauses.map(humanizeBooleanPolicy).join("; ")}.`);
    }
  }

  const performance = [...groups.entries()].filter(([, group]) => group.domain === "performance");
  if (performance.length >= 2) {
    const parts: string[] = [];
    let pressure: boolean | undefined;
    let memoryCapacityPresent = false;
    for (const [key, group] of performance) {
      const fact = group.facts[0];
      if (fact) {
        if (!isDisplayScalar(fact.value)) return undefined;
        if (fact.goal.target === "memory") {
          if (typeof fact.value !== "number" || !Number.isSafeInteger(fact.value) || fact.value < 0) return undefined;
          if (fact.capacity !== undefined) {
            if (!Number.isSafeInteger(fact.capacity) || fact.capacity <= 0 || fact.value > fact.capacity) return undefined;
            memoryCapacityPresent = true;
          }
        }
        parts.push(renderFact(fact.goal, displayScalar(fact.value), chinese, fact.capacity));
      }
      if (group.target === "resource-pressure") pressure = group.judgement;
      consumed.add(key);
    }
    if (pressure !== undefined && !memoryCapacityPresent) return undefined;
    if (pressure !== undefined) parts.push(chinese
      ? pressure ? "综合判断：当前达到高资源压力阈值。" : "综合判断：当前未达到高资源压力阈值。"
      : pressure ? "Overall assessment: resource pressure is high." : "Overall assessment: resource pressure is below the high threshold.");
    if (parts.length) rendered.push(parts.join("\n"));
  }

  for (const [groupId, group] of groups.entries()) {
    if (consumed.has(groupId)) continue;
    if (group.collection) {
      const collection = group.collection;
      const count = group.count ?? collection.length;
      if (count !== collection.length || !collection.every(isDisplayScalar)) return undefined;
      rendered.push(renderCollection(group, collection.map(displayScalar), count, chinese, handlingJudgement));
      continue;
    }
    if (group.count !== undefined) {
      rendered.push(renderCount(group, group.count, chinese));
      continue;
    }
    if (group.domain === "plugin" && group.facts.length) {
      const plugin = renderPluginFacts(group.facts.map((fact) => fact.value), chinese);
      if (!plugin) return undefined;
      rendered.push(plugin);
      continue;
    }
    if (group.judgement !== undefined) {
      for (const fact of group.facts) {
        if (!isDisplayScalar(fact.value)) return undefined;
        rendered.push(renderFact(fact.goal, displayScalar(fact.value), chinese));
      }
      const judgement = renderJudgement(group, chinese);
      if (!judgement) return undefined;
      rendered.push(judgement);
      continue;
    }
    for (const fact of group.facts) {
      if (!isDisplayScalar(fact.value)) return undefined;
      rendered.push(renderFact(fact.goal, displayScalar(fact.value), chinese));
    }
  }
  return rendered.length ? rendered.join("\n\n") : undefined;
}

interface PluginMetadataFact {
  project: string;
  version?: string;
  source?: string;
  artifact?: string;
  compatibility: string;
  resolution?: string;
  checked_source?: string;
  requested_loader?: string;
  requested_minecraft_version?: string;
  sha256?: string;
  source_sha512?: string;
}

function renderPluginFacts(values: unknown[], chinese: boolean) {
  const parsed = values.map(parsePluginMetadataFact);
  if (parsed.some((value) => !value)) return undefined;
  const facts = parsed.filter((value): value is PluginMetadataFact => Boolean(value));
  const unique = new Map(facts.map((fact) => [stablePluginFact(fact), fact]));
  if (unique.size !== 1) return undefined;
  const fact = [...unique.values()][0];
  if (fact.resolution === "search-incomplete") return chinese
    ? `${fact.project}：历史版本查询达到上限，查询不完整，不能判定不存在兼容版本。`
    : `${fact.project}: the history search limit was reached; compatibility remains unresolved.`;
  if (fact.resolution === "no-compatible-artifact") return chinese
    ? `${fact.project}：在可信来源 ${displaySource(fact.checked_source ?? "")} 中未找到适用于 ${fact.requested_loader} ${fact.requested_minecraft_version} 的兼容制品，因此没有可提供的制品版本或校验值。`
    : `${fact.project}: no compatible artifact for ${fact.requested_loader} ${fact.requested_minecraft_version} was found in the trusted source ${displaySource(fact.checked_source ?? "")}; therefore no artifact version or checksum is available.`;
  const name = displayPluginName(fact);
  const compatibility = humanCompatibility(fact.compatibility, chinese);
  const source = displaySource(fact.source ?? "");
  const integrity = fact.sha256
    ? `SHA-256：${fact.sha256}`
    : chinese ? `来源 SHA-512：${fact.source_sha512}` : `Source SHA-512: ${fact.source_sha512}`;
  return chinese
    ? `${name} ${fact.version}：${compatibility}；可信来源：${source}；制品：${fact.artifact}；${integrity}。`
    : `${name} ${fact.version}: ${compatibility}; trusted source: ${source}; artifact: ${fact.artifact}; ${integrity}.`;
}

function parsePluginMetadataFact(value: unknown): PluginMetadataFact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.resolution === "no-compatible-artifact" || record.resolution === "search-incomplete") {
    const required = ["project", "compatibility", "checked_source", "requested_loader", "requested_minecraft_version"] as const;
    if (required.some((key) => typeof record[key] !== "string" || !(record[key] as string).trim()) || !["incompatible", "unverified"].includes(String(record.compatibility))) return undefined;
    return { project: String(record.project), compatibility: String(record.compatibility), resolution: record.resolution, checked_source: String(record.checked_source), requested_loader: String(record.requested_loader), requested_minecraft_version: String(record.requested_minecraft_version) };
  }
  const required = ["project", "version", "source", "artifact", "compatibility"] as const;
  if (required.some((key) => typeof record[key] !== "string" || !(record[key] as string).trim())) return undefined;
  const sha256 = typeof record.sha256 === "string" && /^[a-f0-9]{64}$/i.test(record.sha256) ? record.sha256.toLowerCase() : undefined;
  const sourceSha512 = typeof record.source_sha512 === "string" && /^[a-f0-9]{128}$/i.test(record.source_sha512) ? record.source_sha512.toLowerCase() : undefined;
  if (!sha256 && !sourceSha512) return undefined;
  return {
    project: String(record.project), version: String(record.version), source: String(record.source),
    artifact: String(record.artifact), compatibility: String(record.compatibility),
    ...(sha256 ? { sha256 } : {}), ...(sourceSha512 ? { source_sha512: sourceSha512 } : {}),
  };
}

function stablePluginFact(fact: PluginMetadataFact) {
  return JSON.stringify({
    project: fact.project.toLowerCase(), version: fact.version ?? "", source: fact.source?.toLowerCase() ?? "", artifact: fact.artifact ?? "",
    compatibility: fact.compatibility.toLowerCase(), sha256: fact.sha256 ?? "", source_sha512: fact.source_sha512 ?? "",
    resolution: fact.resolution ?? "", checked_source: fact.checked_source ?? "", requested_loader: fact.requested_loader ?? "", requested_minecraft_version: fact.requested_minecraft_version ?? "",
  });
}

function displayPluginName(fact: PluginMetadataFact) {
  const stem = (fact.artifact ?? fact.project).replace(/\.jar$/i, "");
  const suffix = `-${fact.version ?? ""}`;
  return stem.endsWith(suffix) ? stem.slice(0, -suffix.length) : fact.project;
}

function displaySource(source: string) {
  if (/^modrinth$/i.test(source)) return "Modrinth";
  if (/^hangar(?:-.+)?$/i.test(source)) return "Hangar";
  if (/^github(?:-.+)?$/i.test(source)) return "GitHub";
  return source;
}

function humanCompatibility(value: string, chinese: boolean) {
  const normalized = value.trim().toLowerCase();
  if (["exact-game-version", "exact-version"].includes(normalized)) {
    return chinese ? "与请求的游戏版本精确匹配" : "Exact match for the requested game version";
  }
  if (["platform-compatible", "loader-compatible"].includes(normalized)) {
    return chinese ? "与请求的平台兼容" : "Compatible with the requested platform";
  }
  const releaseTrain = normalized.match(/^official-release-train:(.+)$/);
  if (releaseTrain) return chinese
    ? `官方发布系列声明覆盖 ${releaseTrain[1]}`
    : `The official release series declares support for ${releaseTrain[1]}`;
  if (/^[a-z0-9._+-]+\s+1\.\d+(?:\.\d+)?$/i.test(value.trim())) return chinese
    ? `来源声明兼容 ${value.trim()}`
    : `The source declares compatibility with ${value.trim()}`;
  return chinese ? "来源提供了兼容性声明" : "The source provides a compatibility declaration";
}

function groupKey(goal: TypedCompletionGoal) {
  const filter = goal.filter ? `${goal.filter.field}:${goal.filter.operator}:${goal.filter.value.toLowerCase()}` : "";
  return `${goal.domain}\u0000${goal.target}\u0000${filter}`;
}

function renderCollection(group: ResultGroup, items: string[], count: number, chinese: boolean, handlingJudgement: boolean) {
  if (group.domain === "plugin" && group.target === "loaded") {
    if (!count) return chinese ? "当前没有已加载的插件，数量为 0。" : "No plugins are currently loaded; count: 0.";
    return chinese ? `当前已加载 ${count} 个插件：\n${bullets(items)}` : `${count} plugins are currently loaded:\n${bullets(items)}`;
  }
  if (group.domain === "access" && group.target === "whitelist") {
    if (!count) return chinese ? "白名单中没有成员，人数为 0。" : "The whitelist has no members; count: 0.";
    return chinese ? `白名单共有 ${count} 名成员：\n${bullets(items)}` : `The whitelist has ${count} members:\n${bullets(items)}`;
  }
  if (isPlayerDomain(group)) {
    if (!count) return chinese ? "当前没有在线玩家，人数为 0。" : "There are no players online; count: 0.";
    return chinese ? `当前有 ${count} 名在线玩家：\n${bullets(items)}` : `There are ${count} players online:\n${bullets(items)}`;
  }
  if (group.domain === "diagnosis" && group.target === "recent-logs") {
    const conclusion = group.judgement === undefined ? "" : chinese
      ? handlingJudgement
        ? group.judgement ? "\n当前存在需要处理的迹象。" : "\n当前未发现需要处理的迹象。"
        : group.judgement ? "\n综合判断：发现相应异常迹象。" : "\n综合判断：未发现相应异常迹象。"
      : handlingJudgement
        ? group.judgement ? "\nThe matching evidence indicates that attention is needed." : "\nNo matching evidence currently indicates that action is needed."
        : group.judgement ? "\nConclusion: matching warning signs were found." : "\nConclusion: no matching warning signs were found.";
    if (!count) return (chinese ? "未找到符合条件的日志条目，数量为 0。" : "No matching log entries were found; count: 0.") + conclusion;
    return (chinese ? `找到 ${count} 条符合条件的日志：\n${bullets(items)}` : `Found ${count} matching log ${count === 1 ? "entry" : "entries"}:\n${bullets(items)}`) + conclusion;
  }
  if (group.domain === "filesystem") {
    const conditionZh = group.filter?.operator === "suffix" ? `符合 ${group.filter.value} 后缀的` : "符合条件的";
    const conditionEn = group.filter?.operator === "suffix" ? ` matching the ${group.filter.value} suffix` : " matching the requested filter";
    if (!count) return chinese
      ? `目录 ${group.target} 中未找到${conditionZh}文件，数量为 0。`
      : `No files${conditionEn} were found in ${group.target}; count: 0.`;
    return chinese
      ? `目录 ${group.target} 中找到 ${count} 个${conditionZh}文件：\n${bullets(items)}`
      : `Found ${count} matching ${count === 1 ? "file" : "files"} in ${group.target}:\n${bullets(items)}`;
  }
  if (group.domain === "world" && group.target === "world.datapacks-enabled") {
    if (!count) return chinese ? "当前没有已启用的数据包，数量为 0。" : "There are no enabled data packs; count: 0.";
    return chinese ? `当前已启用 ${count} 个数据包：\n${bullets(items)}` : `${count} data ${count === 1 ? "pack is" : "packs are"} enabled:\n${bullets(items)}`;
  }
  const noun = chinese ? "条目" : count === 1 ? "entry" : "entries";
  if (!count) return chinese ? "未找到符合条件的条目，数量为 0。" : "No matching entries were found; count: 0.";
  return chinese ? `找到 ${count} 个${noun}：\n${bullets(items)}` : `Found ${count} matching ${noun}:\n${bullets(items)}`;
}

function renderCount(group: ResultGroup, count: number, chinese: boolean) {
  if (group.domain === "diagnosis" && group.target === "recent-logs") return chinese ? `符合条件的日志数量为 ${count}。` : `Matching log count: ${count}.`;
  if (group.domain === "filesystem") return chinese ? `目录 ${group.target} 中符合条件的文件数量为 ${count}。` : `Matching file count in ${group.target}: ${count}.`;
  return chinese ? `符合条件的条目数量为 ${count}。` : `Matching entry count: ${count}.`;
}

function renderFact(goal: TypedCompletionGoal, value: string, chinese: boolean, capacity?: number) {
  if (goal.domain === "gamerule") return chinese ? `${goal.target} 当前值为 ${value}。` : `The current value of ${goal.target} is ${value}.`;
  if (goal.domain === "world") {
    if (goal.target === "world.seed") return chinese ? `当前世界种子为 ${value}。` : `The current world seed is ${value}.`;
    if (goal.target === "world.difficulty") return chinese ? `当前游戏难度为 ${value}。` : `The current difficulty is ${value}.`;
    if (goal.target === "world.daytime") return chinese ? `当前世界时间为 ${value} 刻。` : `The current daytime value is ${value} ticks.`;
    if (goal.target === "world.gametime") return chinese ? `当前世界累计游戏时间为 ${value} 刻。` : `The accumulated game time is ${value} ticks.`;
    if (goal.target === "world.border-diameter") return chinese ? `当前世界边界直径为 ${value} 格。` : `The current world-border diameter is ${value} blocks.`;
  }
  if (goal.domain === "performance") {
    const numeric = Number(value);
    if (goal.target === "uptime" && Number.isFinite(numeric)) return chinese ? `进程已运行 ${formatSeconds(numeric)}。` : `Process uptime: ${formatSeconds(numeric, false)}.`;
    if (goal.target === "cpu" && Number.isFinite(numeric)) return chinese ? `CPU 占用为 ${numeric.toFixed(2)}%。` : `CPU usage is ${numeric.toFixed(2)}%.`;
    if (goal.target === "memory" && Number.isFinite(numeric)) {
      if (capacity !== undefined) return chinese
        ? `内存占用为 ${formatBinaryBytes(numeric)} / 总容量 ${formatBinaryBytes(capacity)}。`
        : `Memory usage is ${formatBinaryBytes(numeric)} out of ${formatBinaryBytes(capacity)} total.`;
      return chinese ? `内存占用为 ${formatBinaryBytes(numeric)}。` : `Memory usage is ${formatBinaryBytes(numeric)}.`;
    }
  }
  const hash = goal.target.lastIndexOf("#");
  const label = hash >= 0 ? goal.target.slice(hash + 1) : goal.target;
  return chinese ? `${label}：${value}` : `${label}: ${value}`;
}

function renderJudgement(group: ResultGroup, chinese: boolean) {
  if (group.judgement === undefined) return undefined;
  if (group.domain === "gamerule") {
    if ((group.judgementKey ?? "").toLowerCase().includes("randomtickspeed")) return chinese
      ? group.judgement ? "判断结果：随机刻已停用。" : "判断结果：随机刻仍在运行。"
      : group.judgement ? "Conclusion: random ticking is disabled." : "Conclusion: random ticking remains active.";
    if ((group.judgementKey ?? "").toLowerCase().includes("domobspawning")) return chinese
      ? group.judgement ? "判断结果：规则允许生物自然生成。" : "判断结果：规则禁止生物自然生成。"
      : group.judgement ? "Conclusion: natural mob spawning is enabled." : "Conclusion: natural mob spawning is disabled.";
  }
  if (group.domain !== "world") return undefined;
  if (group.judgementKey === "world.difficulty-peaceful") return chinese
    ? group.judgement ? "判断结果：当前处于和平难度。" : "判断结果：当前不是和平难度。"
    : group.judgement ? "Conclusion: the current difficulty is peaceful." : "Conclusion: the current difficulty is not peaceful.";
  if (group.judgementKey === "world.day-period") return chinese
    ? `判断结果：当前是${group.judgement ? "白天" : "夜晚"}。`
    : `Conclusion: it is currently ${group.judgement ? "daytime" : "nighttime"}.`;
  if (group.judgementKey === "world.gametime-positive") return chinese
    ? group.judgement ? "判断结果：累计游戏刻数大于 0。" : "判断结果：累计游戏刻数不大于 0。"
    : group.judgement ? "Conclusion: accumulated game time is above zero." : "Conclusion: accumulated game time is not above zero.";
  return undefined;
}

function isPlayerDomain(group: ResultGroup) {
  return ["player", "players"].includes(group.domain) || /(?:online[-_ ]?players?|roster)/i.test(group.target);
}

function bullets(items: string[]) { return items.map((item) => `- ${item}`).join("\n"); }
function isDisplayScalar(value: unknown): value is string | number | boolean { return ["string", "number", "boolean"].includes(typeof value); }
function displayScalar(value: string | number | boolean) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function humanizeBooleanPolicy(clause: string) {
  return clause.replace(/\s+(?:为|is)\s+true$/i, " 已启用").replace(/\s+(?:为|is)\s+false$/i, " 已停用");
}

function formatSeconds(value: number, chinese = true) {
  const seconds = Math.max(0, Math.floor(value));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (!chinese) return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes || (!days && !hours) ? `${minutes}m` : ""].filter(Boolean).join(" ");
  return [days ? `${days}天` : "", hours ? `${hours}小时` : "", minutes || (!days && !hours) ? `${minutes}分钟` : ""].filter(Boolean).join("");
}

function formatBinaryBytes(value: number) {
  return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
}
