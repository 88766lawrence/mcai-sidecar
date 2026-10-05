import type { AgentLoopObservation } from "./agent-loop";

type Fact = Record<string, unknown>;
const record = (value: unknown): value is Fact => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function facts(observation: AgentLoopObservation): Fact[] {
  if (!record(observation.data)) return [];
  return [observation.data.observations, observation.data.goal_results].flatMap((items) =>
    Array.isArray(items) ? items.flatMap((item) => record(item) && record(item.observed) ? [item.observed] : []) : []);
}

function loadedAfterInstall(project: string, installed: Fact, observations: AgentLoopObservation[]) {
  const installIndex = observations.flatMap((item, index) => item.tool === "plugin.install" && record(item.data)
    && record(item.data.call_arguments) && item.data.call_arguments.project === project && item.status === "succeeded" ? [index] : []).at(-1) ?? -1;
  const activation = observations.flatMap((item, index) => index > installIndex
    && ["instance.start", "instance.restart"].includes(item.tool) && item.status === "succeeded" ? [index] : []).at(-1) ?? -1;
  if (activation < 0) return false;
  const later = observations.slice(activation + 1).filter((item) => item.status === "succeeded");
  const listing = later.filter((item) => item.tool === "files.list").flatMap(facts)
    .find((fact) => fact.schema_version === "files-list-result/v1" && fact.path === "plugins" && fact.truncated === false);
  const inventory = later.filter((item) => item.tool === "console.command").flatMap(facts)
    .find((fact) => fact.schema_version === "loaded-plugins-result/v1");
  if (!listing || !inventory || !Array.isArray(listing.entries) || !Array.isArray(inventory.names)
    || inventory.total !== inventory.names.length || typeof installed.plugin_name !== "string") return false;
  const entries = listing.entries.flatMap((item) => record(item) ? [item.name] : []);
  const replaced = typeof installed.replaces_path === "string" ? installed.replaces_path.split("/").at(-1) : "";
  return entries.filter((name) => name === installed.artifact).length === 1
    && (!replaced || replaced === installed.artifact || !entries.includes(replaced))
    && inventory.names.some((name) => typeof name === "string" && name.toLowerCase() === String(installed.plugin_name).toLowerCase());
}

/** Only rendered when synthesis cannot proceed or a negative resolution needs an honest partial answer. */
export function renderPluginOutcomeFinal(request: string, observations: AgentLoopObservation[]) {
  if (!/(?:安装|装上|帮我安排|部署|升级|更新|\binstall\b|\bdeploy\b|\bupdate\b)/iu.test(request)
    || /(?:不要|禁止|别|仅|只)[^，。；;\r\n]{0,16}(?:安装|装|部署|更新|升级)|(?:do not|don't|without)\s+install/iu.test(request)) return undefined;
  const projects = new Map<string, { resolved?: Fact; installed?: Fact; failed?: boolean }>();
  for (const observation of observations) {
    if (!["plugin.resolve", "plugin.install"].includes(observation.tool) || !record(observation.data)) continue;
    const args = observation.data.call_arguments;
    const project = record(args) && typeof args.project === "string" ? args.project.toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(project)) continue;
    const state = projects.get(project) ?? {};
    projects.set(project, state);
    for (const fact of facts(observation)) {
      if (observation.tool === "plugin.resolve" && (fact.schema_version === "resolved-plugin/v1" || !fact.schema_version && fact.resolution)) state.resolved = fact;
      if (observation.tool === "plugin.install" && observation.status === "succeeded" && fact.schema_version === "plugin-install-result/v1") state.installed = fact;
    }
    if (observation.status !== "succeeded") state.failed = true;
  }
  const chinese = /[\u3400-\u9fff]/u.test(request);
  const lines: string[] = [];
  let blocked = false;
  for (const [project, state] of projects) {
    if (state.installed) {
      const same = state.installed.already_present === true && typeof state.installed.sha256 === "string"
        && /^[a-f0-9]{64}$/u.test(state.installed.sha256) && typeof state.installed.installed_path === "string"
        && state.installed.installed_path.startsWith("plugins/");
      const loaded = !same && loadedAfterInstall(project, state.installed, observations);
      lines.push(chinese
        ? `${project}：${same ? "已有文件与请求制品校验一致，无需重复安装或重启；本轮未重新核验加载状态" : loaded ? "插件文件已安装，启动后文件与实际加载列表核验通过" : "插件文件已安装，尚未确认完成启动和实际加载核验"}。`
        : `${project}: ${same ? "the existing artifact matches; no repeat installation or restart is needed; loading was not rechecked" : loaded ? "plugin files installed; files and runtime loading verified after startup" : "plugin files installed; startup and loading are not yet verified"}.`);
      continue;
    }
    const resolution = state.resolved?.resolution;
    if (["no-compatible-artifact", "search-incomplete", "query-failed"].includes(String(resolution))) {
      blocked = true;
      const version = String(state.resolved?.requested_minecraft_version ?? "");
      const checked = state.resolved?.checked_sources;
      const sources = Array.isArray(checked) && checked.length ? checked.join(", ") : String(state.resolved?.checked_source ?? "checked sources");
      const reason = resolution === "no-compatible-artifact"
        ? chinese ? `在 ${sources} 未找到适用于目标 Minecraft ${version} 的兼容制品` : `no compatible artifact for Minecraft ${version} was found in ${sources}`
        : resolution === "search-incomplete"
          ? chinese ? "历史版本查询达到上限，查询不完整，不能判定不存在兼容版本" : "the history search limit was reached; compatibility remains unresolved"
          : chinese ? "来源查询或制品校验失败，不能判定兼容版本是否存在" : "source lookup or integrity verification failed; compatibility remains unresolved";
      lines.push(chinese ? `${project}：未安装；${reason}。` : `${project}: not installed; ${reason}.`);
    } else if (state.failed) {
      blocked = true;
      lines.push(chinese ? `${project}：操作失败，无法确认安装完成。` : `${project}: the operation failed; installation is not confirmed.`);
    } else if (state.resolved) {
      lines.push(chinese ? `${project}：已找到制品，但没有本轮安装成功的证据。` : `${project}: an artifact was resolved, but installation is not confirmed.`);
    }
  }
  return lines.length ? { answer: (chinese ? "已核对的插件结果：\n" : "Observed plugin outcomes:\n") + lines.join("\n"), blocked } : undefined;
}
