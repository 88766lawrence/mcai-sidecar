import { describe, expect, it } from "vitest";
import { buildAgentToolCallPlan, draftPlan, expandOperationalSkill, extractConsoleCommandIntent, extractFilesListIntent, extractRealtimeLogIntent } from "./planner";
import { validatePlanCompatibility } from "./plan-compatibility";
import { extractSourceGoals } from "./goal-requirements";

describe("draftPlan", () => {
  it("projects an AI-selected registered tool into the strict source/goal/step plan envelope", () => {
    const intent = "Read the exact value of mobGriefing now.";
    const plan = buildAgentToolCallPlan("mcs:daemon:instance", "revision-1", intent, {
      action: "tool_call", tool: "console.command", arguments: { command: "gamerule mobGriefing" }, reason: "Read the requested value.",
    });
    expect(plan).toMatchObject({ coverage: "full", operation: { capability: "console.command", risk: "read", requires_confirmation: false } });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "console.command", args: { command: "gamerule mobGriefing" }, risk: "read" })]);
    expect(plan.source_goals).toHaveLength(1);
    expect(plan.source_atoms).toEqual([expect.objectContaining({ source_goal_ids: [plan.source_goals[0]!.id], status: "mapped" })]);
    expect(plan.clause_ledger.filter((clause) => clause.role === "domain_goal")).toEqual([
      expect.objectContaining({ source_goal_ids: [plan.source_goals[0]!.id], source_atom_ids: [plan.source_atoms[0]!.id] }),
    ]);
    expect(validatePlanCompatibility(plan)).toEqual(expect.objectContaining({ ok: true }));
  });

  it("keeps a negative write constraint separate from an AI-selected read goal", () => {
    const intent = "Read mobGriefing now; do not change any rule.";
    const plan = buildAgentToolCallPlan("mcs:daemon:instance", "revision-1", intent, {
      action: "tool_call", tool: "console.command", arguments: { command: "gamerule mobGriefing" }, reason: "Read only.",
    });
    expect(plan.constraints).toEqual([expect.objectContaining({ action: "write", effect: "forbid", source: expect.stringContaining("do not change any rule") })]);
    expect(plan.source_goals[0]?.source_text).not.toContain("do not change");
    expect(validatePlanCompatibility(plan)).toEqual(expect.objectContaining({ ok: true }));
  });

  it("merges adjacent presentation wording into one fully reverse-mapped AI file capability clause", () => {
    const plan = buildAgentToolCallPlan(
      "mcs:daemon:instance", "revision-1",
      "盘点一下 /plugins 里面以 .jar 结尾的文件，给我完整名字和数量。",
      { action: "tool_call", tool: "files.list", arguments: { path: "/plugins", suffix: ".jar" }, reason: "列出匹配文件并统计数量" },
    );
    const domainClauses = plan.clause_ledger.filter((clause) => clause.role === "domain_goal");
    expect(domainClauses).toHaveLength(2);
    expect(domainClauses.every((clause) => clause.source_goal_ids.length > 0 && clause.source_atom_ids.length > 0)).toBe(true);
    expect(validatePlanCompatibility(plan)).toEqual(expect.objectContaining({ ok: true }));
  });

  it("keeps an AI-selected medium write canonical and confirmable without pre-dispatch", () => {
    const plan = buildAgentToolCallPlan("mcs:daemon:instance", "revision-1", "Make the weather clear.", {
      action: "tool_call", tool: "console.command", arguments: { command: "weather clear" }, reason: "Apply the requested weather change.",
    });
    expect(plan).toMatchObject({ coverage: "full", operation: { action: "write", risk: "medium", requires_confirmation: true } });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "console.command", args: { command: "weather clear" }, risk: "medium", requires_confirmation: true })]);
    expect(validatePlanCompatibility(plan)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    "麻烦查清当前这个游戏节点实际使用的服务端内核，以及 Minecraft 正在运行哪个版本。",
    "核实当前节点采用的服务端内核，并说明正在运行的 Minecraft 版本",
    "Which server implementation and Minecraft version is this instance currently running?",
    "当前实例实际使用什么平台，Minecraft 版本是什么",
  ])("binds every positive runtime identity clause to the shared typed goal and atom: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    const domainClauses = plan.clause_ledger.filter((clause) => clause.role === "domain_goal");
    expect(domainClauses.length).toBeGreaterThan(0);
    expect(domainClauses.every((clause) => clause.polarity === "positive"
      && clause.status === "mapped"
      && clause.source_goal_ids.length > 0
      && clause.source_atom_ids.length > 0)).toBe(true);
  });

  it.each([
    "核对本实例当前服务端发行版和 Minecraft 版本",
    "Report the live runtime implementation and MC build for this host",
    "这台游戏服现在采用什么内核、跑哪个 Minecraft release",
    "Identify the actual server platform, build and game version",
  ])("builds one real version observation with a structured required result: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.coverage).toBe("full");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "version" }, risk: "read" }]);
    expect(plan.goal_requirements).toEqual([expect.objectContaining({
      domain: "server", target: "version", result_kind: "fact", execute_step_ids: ["s1"],
      evidence: expect.arrayContaining([expect.objectContaining({ kind: "console", tool: "console.command", parameters: { command: "version" } })]),
    })]);
  });

  it.each([
    ["Read current memory consumption, then report TPS", ["instance.metrics", "console.command"], ["memory", "tps"]],
    ["给我当前TPS以及RAM用了多少", ["console.command", "instance.metrics"], ["tps", "memory"]],
    ["这台服性能是否平稳？先看内存使用，再查MSPT", ["instance.metrics", "console.command"], ["memory", "mspt"]],
    ["Report the tick rate and current heap utilization", ["console.command", "instance.metrics"], ["tps", "memory"]],
    ["先看 RAM consumption，再读 milliseconds per tick", ["instance.metrics", "console.command"], ["memory", "mspt"]],
    ["读一下当前 tick 速率并报告 heap usage", ["console.command", "instance.metrics"], ["tps", "memory"]],
  ])("builds a complete ordered multi-metric read plan: %s", (intent, tools, targets) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.coverage).toBe("full");
    expect(plan.steps.map((step) => step.tool)).toEqual(tools);
    expect(plan.steps.map((step) => step.tool === "console.command" ? step.args.command : Array.isArray(step.args.metrics) ? step.args.metrics[0] : step.args.target)).toEqual(targets);
    expect(plan.steps.every((step) => step.risk === "read" && !step.requires_confirmation)).toBe(true);
    expect(plan.goal_requirements).toHaveLength(2);
    expect(plan.goal_requirements.every((goal) => goal.execute_step_ids.length === 1 && goal.evidence.length > 0)).toBe(true);
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
  });

  it("creates a controlled Paper installation plan for any supported release", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Download Paper 1.21.1 as server.jar");

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "server.install",
      args: {
        platform: "paper",
        minecraft_version: "1.21.1",
        target: "/server.jar",
        accept_eula: false,
      },
      risk: "high",
      requires_confirmation: true,
    }]);
    expect(plan.acceptance).toEqual([{ type: "server_ready" }]);
  });

  it("recognizes Chinese Fabric installation requests", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "下载 Fabric 1.20.4 并自动开服");

    expect(plan.steps[0]).toMatchObject({
      tool: "server.install",
      args: { platform: "fabric", minecraft_version: "1.20.4", target: "/server.jar" },
    });
  });

  it("carries explicit Minecraft EULA consent into the controlled installer", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "我同意 Minecraft EULA，请安装 Paper 1.21.1");

    expect(plan.steps[0]).toMatchObject({
      tool: "server.install",
      args: { platform: "paper", minecraft_version: "1.21.1", accept_eula: true },
    });
  });

  it("requires confirmation before stopping an instance", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Stop the server");

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "instance.stop",
      args: { target: "mcs:daemon:instance", timeout_seconds: 120 },
      risk: "high",
      requires_confirmation: true,
    }]);
    expect(plan.operation).toMatchObject({
      schema_version: "operation-objective/v2",
      action: "lifecycle",
      requires_confirmation: true,
      verification_evidence: [{ kind: "verification" }],
    });
    expect(plan.acceptance).toEqual([{ type: "instance_state", expected: "stopped" }]);
  });

  it.each([
    ["把当前游戏节点开起来，别重启或停服", "instance.start", "medium", "running"],
    ["Launch this bound server without rebooting or shutting it down", "instance.start", "medium", "running"],
    ["这台联机服还离线，只需把它启动；停止和重启都不要执行", "instance.start", "medium", "running"],
    ["Stop and restart are forbidden; bring the current game host online", "instance.start", "medium", "running"],
    ["不要关机，也不要重开；让眼前这台服务运行起来", "instance.start", "medium", "running"],
    ["这台实例尚未运行；送它进入在线状态，下线和重新启动除外", "instance.start", "medium", "running"],
    ["The current host stays offline. Move it to running; stop and restart are excluded.", "instance.start", "medium", "running"],
    ["关闭当前实例，但不要重启", "instance.stop", "high", "stopped"],
    ["当前服务仍在线；使它变为离线状态，开机和重启都不考虑", "instance.stop", "high", "stopped"],
    ["只关闭这台游戏服，启动和重启一概不要", "instance.stop", "high", "stopped"],
    ["Reboot this server only; do not power off another instance", "instance.restart", "high", "running"],
    ["This node is online; restart it, while start and shutdown remain out of scope.", "instance.restart", "high", "running"],
    ["Starting and stopping are not allowed; reboot this bound node", "instance.restart", "high", "running"],
  ])("builds one canonical lifecycle step for %s", (intent, tool, risk, expected) => {
    const plan = draftPlan("mcs:daemon:bound", "revision-1", intent);
    expect(plan.steps).toEqual([{
      id: "s1", tool, args: { target: "mcs:daemon:bound", timeout_seconds: 120 }, risk, requires_confirmation: true,
    }]);
    expect(plan.operation).toMatchObject({ capability: tool, action: "lifecycle", target: "mcs:daemon:bound", risk, requires_confirmation: true });
    expect(plan.acceptance).toEqual([{ type: "instance_state", expected }]);
    expect(plan.steps.some((step) => step.tool === "console.command")).toBe(false);
  });

  it.each([
    "启动还是重启当前实例，选一个合适的",
    "Either stop or restart this bound service",
  ])("fails closed instead of using console.command for ambiguous lifecycle language: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:bound", "revision-1", intent, { preferredTool: "console.command" });
    expect(plan.coverage).not.toBe("full");
    expect(plan.steps).toEqual([]);
  });

  it("builds a multi-step read-only health inspection without obeying negated stop text", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "对当前实例完成只读健康检查：执行 version、plugins 并读取最近日志；不要重启或停止服务器。",
      { preferredTool: "logs.query" },
    );

    expect(plan.steps).toEqual([
      { id: "s1", tool: "console.command", args: { command: "version" }, risk: "read" },
      { id: "s2", tool: "console.command", args: { command: "plugins" }, risk: "read" },
      expect.objectContaining({ id: "s3", tool: "logs.query", args: expect.objectContaining({ window_minutes: 60, max_lines: 500 }), risk: "read" }),
    ]);
    expect(plan.steps[2].args.filter_query).toMatchObject({ schema_version: "log-filter-query/v1", groups: [{ all_of: ["all"], any_of: [] }] });
  });

  it.each(["检查服务器健康", "看看这台服务器有没有问题", "服务器正常吗", "给当前实例做个巡检"])(
    "expands the short health request %s into the complete read-only skill",
    (intent) => {
      expect(expandOperationalSkill(intent)).toContain("执行 version");
      expect(draftPlan("mcs:daemon:instance", "revision-1", intent).steps.map((step) => step.tool))
        .toEqual(["console.command", "console.command", "logs.query"]);
    },
  );

  it("does not turn a general health-check tutorial question into a live server task", () => {
    expect(expandOperationalSkill("Minecraft 服务器健康检查一般怎么做？")).toBeUndefined();
  });

  it("does not treat a negated stop instruction as authorization to stop", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "检查日志，但不要停止服务器", { preferredTool: "logs.query" });
    expect(plan.steps[0]?.tool).toBe("logs.query");
  });

  it("creates a read-only console plan for list", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "在控制台执行 list");

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "console.command",
      args: { command: "list" },
      risk: "read",
    }]);
  });

  it("uses the console for a natural-language online player query", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "\u5e2e\u6211\u770b\u770b\u73b0\u5728\u6709\u591a\u5c11\u73a9\u5bb6\u5728\u7ebf",
    );

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "console.command",
      args: { command: "list" },
      risk: "read",
    }]);
  });

  it("requires confirmation for gameplay-changing console commands", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "控制台输入 time set day");

    expect(plan.steps[0]).toEqual({
      id: "s1",
      tool: "console.command",
      args: { command: "time set day" },
      risk: "medium",
      requires_confirmation: true,
    });
  });

  it.each([
    ["把天气切成雷雨", "weather thunder", undefined],
    ["turn the whitelist on for this server", "whitelist on", "config.inspect"],
    ["将游戏规则 keepInventory 设为 true", "gamerule keepInventory true", "console.command"],
    ["Set player NovaRider gamemode to spectator", "gamemode spectator NovaRider", "console.command"],
  ])("creates an approved execute-and-verify plan for %s", (intent, command, verifyTool) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);

    expect(plan.steps[0]).toMatchObject({
      tool: "console.command", args: { command }, risk: "medium", requires_confirmation: true,
    });
    if (verifyTool) expect(plan.steps[1]).toMatchObject({ tool: verifyTool, risk: "read", purpose: "verify" });
    else expect(plan.steps).toHaveLength(1);
    expect(plan.operation).toMatchObject({ action: "write", risk: "medium", requires_confirmation: true });
    expect(plan.operation.execution_evidence).toContainEqual(expect.objectContaining({ kind: "console" }));
    if (verifyTool) expect(plan.operation.verification_evidence[0]?.kind).toMatch(/^verification\./);
    else expect(plan.operation.verification_evidence).toEqual([]);
  });

  it("translates a natural-language difficulty change into an approved console command", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "把当前服务器游戏难度调成简单，完成后确认结果，不要重启。");

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "console.command",
      args: { command: "difficulty easy" },
      risk: "medium",
      requires_confirmation: true,
    }, {
      id: "s2",
      tool: "console.command",
      args: { command: "difficulty", expect: "easy" },
      risk: "read",
      purpose: "verify",
    }]);
    expect(plan.operation).toMatchObject({
      schema_version: "operation-objective/v2",
      action: "write",
      requires_confirmation: true,
      verification_evidence: [{ kind: "verification.console", contains: ["easy"] }],
    });
  });

  it("queries the current difficulty without requesting mutation approval", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "只读查询当前服务器游戏难度并告诉我结果，不要修改。");

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "console.command",
      args: { command: "difficulty" },
      risk: "read",
    }]);
  });

  it("treats administrator console commands as high risk", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "向控制台发送 op Steve");

    expect(plan.steps[0]).toMatchObject({
      tool: "console.command",
      args: { command: "op Steve" },
      risk: "high",
      requires_confirmation: true,
    });
  });

  it("detects real-time log diagnosis without matching general knowledge", () => {
    expect(extractRealtimeLogIntent("读取这台服务器最近一小时日志并分析崩服原因")).toBeTruthy();
    expect(extractRealtimeLogIntent("为什么这个实例刚才报错了？")).toBeTruthy();
    expect(extractRealtimeLogIntent("Minecraft 日志一般保存在哪里？")).toBeUndefined();
  });

  it("plans the requested EssentialsX project instead of hardcoding LuckPerms", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "帮我安装 EssentialsX", {
      platform: "paper",
      minecraftVersion: "1.21.1",
      loader: "paper",
    });

    expect(plan.steps[0]).toMatchObject({
      tool: "plugin.resolve",
      args: { project: "essentialsx", source: "modrinth", platform: "paper", minecraft_version: "1.21.1" },
    });
    expect(plan.steps.map((step) => step.tool)).toEqual(["plugin.resolve", "plugin.install", "files.list"]);
    expect(plan.steps.some((step) => step.tool === "instance.restart")).toBe(false);
    expect(plan.operation.verification_evidence).toContainEqual(expect.objectContaining({ kind: "verification.files" }));
  });

  it("installs a plugin without restarting when the user explicitly forbids restart", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "下载并安装 EssentialsX 插件，但不要重启服务器", {
      preferredTool: "plugin.install",
      platform: "paper",
      minecraftVersion: "1.21.1",
      loader: "paper",
    });

    expect(plan.steps.map((step) => step.tool)).toEqual(["plugin.resolve", "plugin.install", "files.list"]);
    expect(plan.steps.at(-1)).toMatchObject({ purpose: "verify", args: { path: "/plugins", expect: "essentialsx" } });
    expect(plan.steps.some((step) => step.tool === "instance.restart")).toBe(false);
    expect(plan.acceptance).toEqual([]);
  });

  it("does not bundle an explicitly requested restart into the install approval", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "安装 BlueMap，完成后重启服务器", {
      preferredTool: "plugin.install", platform: "paper", minecraftVersion: "1.21.1", loader: "paper",
    });

    expect(plan.steps.map((step) => step.tool)).toEqual(["plugin.resolve", "plugin.install", "files.list"]);
    expect(plan.steps.some((step) => step.tool === "instance.restart")).toBe(false);
  });

  it("keeps download, install and file verification under one no-restart confirmation", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "帮我下载并安装 LuckPerms 插件，不要重启服务器；安装后确认文件已经落盘。", {
      preferredTool: "plugin.install", platform: "paper", minecraftVersion: "1.21.1", loader: "paper",
    });
    expect(plan.steps.map((step) => step.tool)).toEqual(["plugin.resolve", "plugin.install", "files.list"]);
    expect(plan.steps.filter((step) => step.requires_confirmation)).toHaveLength(1);
    expect(plan.steps.at(-1)).toMatchObject({ tool: "files.list", purpose: "verify", args: { path: "/plugins", expect: "luckperms" } });
    expect(plan.steps.some((step) => ["instance.start", "instance.stop", "instance.restart"].includes(step.tool))).toBe(false);
  });

  it("resolves plugin metadata without creating an installation plan", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "解析 EssentialsX 兼容版本和制品，但不要安装", {
      preferredTool: "plugin.resolve",
      platform: "paper",
      minecraftVersion: "1.21.1",
      loader: "paper",
    });

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "plugin.resolve",
      args: {
        project: "essentialsx",
        source: "modrinth",
        platform: "paper",
        minecraft_version: "1.21.1",
        loader: "paper",
      },
      risk: "read",
    }]);
    expect(plan.acceptance).toEqual([]);
  });

  it("keeps an arbitrary plugin name from a short negated-install request", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "看看 ProtocolLib 能不能装，先别安装\n\nAgent operation: resolve ProtocolLib 兼容版本",
      { preferredTool: "plugin.resolve", platform: "paper", minecraftVersion: "1.21.1", loader: "paper" },
    );
    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "plugin.resolve",
      args: {
        project: "protocollib",
        source: "modrinth",
        platform: "paper",
        minecraft_version: "1.21.1",
        loader: "paper",
      },
      risk: "read",
    }]);
  });

  it("does not depend on a hard-coded plugin list for colloquial queries", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "看看 Citizens 能不能装，先别安装",
      { preferredTool: "plugin.resolve", platform: "paper", minecraftVersion: "1.21.1", loader: "paper" },
    );
    expect(plan.steps[0]?.args.project).toBe("citizens");
  });

  it("honors a controlled files continuation and targets the plugins directory", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "列出当前实例 /plugins 目录", {
      preferredTool: "files.list",
    });

    expect(plan.steps).toEqual([{ id: "s1", tool: "files.list", args: { path: "/plugins" }, risk: "read" }]);
  });

  it("plans a grounded read before changing an underspecified plugin config", () => {
    const plan = draftPlan(
      "mcs:daemon:instance", "revision-1",
      "请配置 plugins/Lobby/config.yml 的欢迎消息",
      { preferredTool: "config.patch" },
    );
    expect(plan.steps).toEqual([{
      id: "s1", tool: "config.inspect", args: { path: "plugins/Lobby/config.yml" }, risk: "read",
    }]);
  });

  it("does not invent a default configuration key or value for a vague write goal", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "帮我改一下当前插件的配置文件", {
      preferredTool: "config.patch",
    });

    expect(plan.steps.some((step) => step.tool === "config.patch")).toBe(false);
    expect(plan.operation.action).not.toBe("write");
  });

  it("turns the refiner config marker into a confirmed structured YAML patch", () => {
    const plan = draftPlan(
      "mcs:daemon:instance", "revision-1",
      '设置大厅欢迎语\nMCAI_CONFIG path=plugins/Lobby/config.yml key=welcome.message value_json="欢迎来到服务器"',
      { preferredTool: "config.patch" },
    );
    expect(plan.steps[0]).toMatchObject({
      tool: "config.patch",
      args: {
        path: "plugins/Lobby/config.yml",
        patch: [{ op: "replace", key: "welcome.message", value: "欢迎来到服务器" }],
      },
      risk: "medium",
      requires_confirmation: true,
    });
  });

  it("uses the read-only plugins console command for a natural-language plugin inventory query", () => {
    expect(extractConsoleCommandIntent("查看服务器插件有哪些")).toBe("plugins");
    expect(draftPlan("mcs:daemon:instance", "revision-1", "查看服务器插件有哪些").steps).toEqual([{
      id: "s1", tool: "console.command", args: { command: "plugins" }, risk: "read",
    }]);
  });

  it("treats an explicit plugin-directory correction as a files tool request", () => {
    expect(extractConsoleCommandIntent("我说插件目录")).toBeUndefined();
    expect(extractFilesListIntent("我说插件目录")).toContain("/plugins");
    expect(draftPlan("mcs:daemon:instance", "revision-1", "我说插件目录", { preferredTool: "files.list" }).steps)
      .toEqual([{ id: "s1", tool: "files.list", args: { path: "/plugins" }, risk: "read" }]);
  });

  it("orders each execute before its own verification for a new compound goal", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "先设为白天，然后换成雨天，别重启");
    expect(plan.steps.map((step) => [step.args.command, step.purpose])).toEqual([
      ["time set day", undefined],
      ["time query daytime", "verify"],
      ["weather rain", undefined],
    ]);
    expect(plan.operation).toMatchObject({ action: "write", risk: "medium", requires_confirmation: true });
  });

  it("keeps a later positive whitelist goal outside an earlier negative scope", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "别停用白名单；把 FrostLynx 加到里面");
    expect(plan.steps[0]).toMatchObject({ args: { command: "whitelist add FrostLynx" }, requires_confirmation: true });
    expect(plan.steps.some((step) => step.args.command === "whitelist off")).toBe(false);
  });

  it("labels a resolve-only capability as read even when its transport risk is low", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Resolve Dynmap only; do not install it.", {
      preferredTool: "plugin.resolve", platform: "paper", minecraftVersion: "1.21.1", loader: "paper",
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.operation).toMatchObject({ capability: "plugin.resolve", action: "read", risk: "read", requires_confirmation: false });
  });

  it("puts an unseen explicit console mutation behind high-risk approval", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Command: forceload add 10 20");
    expect(plan.steps[0]).toMatchObject({ tool: "console.command", args: { command: "forceload add 10 20" }, risk: "high", requires_confirmation: true });
    expect(plan.steps).toHaveLength(1);
    expect(plan.operation.verification_evidence).toEqual([]);
  });

  it.each([
    ["Can RelayBridge be installed? Resolve compatibility only; never deploy.", "relaybridge"],
    ["Resolve the PrismGuard plugin artifact, without installing it.", "prismguard"],
    ["查询 EchoMap 插件的兼容版本，只解析不要安装", "echomap"],
    ["看看 SentinelChat plugin 能否安装；仅做兼容性解析", "sentinelchat"],
    ["Is HarborSync installable? Please resolve its plugin metadata only.", "harborsync"],
    ["校验 MoonLedger 插件制品，不落盘", "moonledger"],
    ["Find the compatible NorthstarTools plugin release; no deployment.", "northstartools"],
    ["确认 RiverProxy plugin 是否兼容，先只查询", "riverproxy"],
  ])("extracts the schema-bound plugin entity rather than a trailing modifier: %s", (intent, project) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent, {
      preferredTool: "plugin.resolve", platform: "paper", minecraftVersion: "1.21.1", loader: "paper",
    });
    expect(plan.steps[0]).toMatchObject({ tool: "plugin.resolve", args: { project } });
    expect(plan.operation.action).toBe("read");
  });

  it.each([
    ["Set weather rain, 然后 difficulty hard, but never restart, 最后 time set night", ["weather rain", "difficulty hard", "time set night"]],
    ["先设为雷雨，再把时间调到白天，然后改成简单；不要停服", ["weather thunder", "time set day", "difficulty easy"]],
    ["difficulty peaceful, then weather clear, 然后 gamerule doFireTick false", ["difficulty peaceful", "weather clear", "gamerule doFireTick false"]],
    ["把 QuartzOtter 改成 survival，然后 time set noon，最后 weather rain；别重启", ["gamemode survival QuartzOtter", "time set noon", "weather rain"]],
    ["先查白名单，然后添加 PineBadger，再查一次；不要关闭", ["whitelist list", "whitelist add PineBadger", "whitelist list"]],
  ])("keeps three ordered positive subgoals across languages and local negation: %s", (intent, expected) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.steps.filter((step) => step.purpose !== "verify").map((step) => step.args.command)).toEqual(expected);
    expect(plan.steps.filter((step) => step.purpose === "verify")).toHaveLength(expected.filter((command) => /^(?:difficulty\b|time\b|gamerule\b|gamemode\b|whitelist (?:add|remove|on|off)\b)/.test(command)).length);
  });

  it("derives a versioned operation digest and step-bound evidence from normalized steps", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Command: op QuartzOtter");
    expect(plan.operation.schema_version).toBe("operation-objective/v2");
    expect(plan.operation.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.operation.target).toBe("op QuartzOtter");
    expect(plan.operation.parameters).toEqual({ command: "op QuartzOtter" });
    expect(plan.operation.execution_evidence[0]).toMatchObject({ step_id: "s1", tool: "console.command", target: "op QuartzOtter", order: 0 });
    expect(plan.operation.verification_evidence).toEqual([]);
  });
});

describe("goal-complete planning and intrinsic policy", () => {
  it.each([
    ["Show online players, TPS, the plugins folder, and inspect recent warnings", ["list", "tps", "/plugins", "logs.query"]],
    ["查在线人数、MSPT、插件文件，并分析最近报错", ["list", "mspt", "/plugins", "logs.query"]],
    ["Read the server version, loaded plugins, and recent crash evidence", ["version", "plugins", "logs.query"]],
    ["确认 Minecraft 版本，同时列出已加载插件并检查最近日志", ["version", "plugins", "logs.query"]],
    ["Inspect /plugins and TPS before checking warnings", ["/plugins", "tps", "logs.query"]],
    ["先看当前在线玩家，再查服务器版本和错误日志", ["list", "version", "logs.query"]],
  ])("persists every independent read goal for: %s", (intent, targets) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent, { platform: "paper", minecraftVersion: "1.21.4", loader: "paper" });
    const actual = plan.steps.map((step) => step.tool === "console.command" ? step.args.command : step.tool === "files.list" ? step.args.path : step.tool);
    expect(actual).toEqual(targets);
    expect(plan.coverage).toBe("full");
    expect(plan.goal_requirements.length).toBeGreaterThanOrEqual(targets.length);
    expect(plan.goal_requirements.every((goal) => goal.execute_step_ids.length === 1 && goal.evidence.length > 0)).toBe(true);
  });

  it.each([
    "FeatherBoard", "CoreProtect", "ChunkyBorder", "PlanAnalytics", "DiscordSRV", "GriefPrevention",
    "BlueMapPlus", "SparkMonitor", "LuckPermsBridge", "GeyserConnect",
  ])("keeps read-only plugin research for unseen project %s separate from server installation", (project) => {
    const plan = draftPlan(
      "mcs:daemon:instance", "revision-1",
      `Audit ${project} plugin compatibility, exact artifact, trusted source and checksum; never download, install, or restart.`,
      { preferredTool: "server.install", platform: "paper", minecraftVersion: "1.21.4", loader: "paper" },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "plugin.resolve", args: { project: project.toLowerCase() }, risk: "read" });
    expect(plan.steps[0].requires_confirmation).toBeUndefined();
    expect(plan.steps.some((step) => step.tool === "server.install" || step.tool === "plugin.install")).toBe(false);
    expect(plan.constraints.map((item) => item.action)).toEqual(expect.arrayContaining(["download", "install", "restart"]));
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["Install Paper 1.21.4", "server.install", "high"],
    ["启动当前实例", "instance.start", "medium"],
    ["console command: say maintenance soon", "console.command", "medium"],
    ["安装 Vault 插件", "plugin.install", "medium"],
  ])("derives intrinsic approval policy for %s", (intent, tool, risk) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent, { platform: "paper", minecraftVersion: "1.21.4", loader: "paper" });
    const step = plan.steps.find((candidate) => candidate.tool === tool);
    expect(step).toMatchObject({ risk, requires_confirmation: true });
    expect(plan.operation.requires_confirmation).toBe(true);
  });

  it.each([
    ["Download Fabric 1.21.3 but do not download, install, or start anything", ["download", "install", "start"]],
    ["只分析 Paper 1.20.6，不要下载、安装或重启", ["download", "install", "restart"]],
    ["Inspect the config read-only; never write, restart, or stop", ["write", "restart", "stop"]],
    ["Check logs without starting or stopping the instance", ["start", "stop"]],
  ])("persists non-bypassable negative constraints for %s", (intent, actions) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.constraints.map((constraint) => constraint.action)).toEqual(expect.arrayContaining(actions));
    expect(plan.steps.every((step) => !["server.install", "plugin.install", "instance.start", "instance.stop", "instance.restart"].includes(step.tool))).toBe(true);
    expect(["full", "partial", "waiting"]).toContain(plan.coverage);
  });

  it.each([
    "修复这个实例里我刚才提到的那个问题",
    "Operate the unknown subsystem and make it right",
    "把未说明的资源处理好",
  ])("waits instead of inventing a successful fallback for an uncovered goal: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.coverage).toBe("waiting");
    expect(plan.steps).toEqual([]);
    expect(plan.goal_requirements.some((goal) => goal.status === "unsupported")).toBe(true);
  });
});

describe("source-goal coverage and result semantics", () => {
  it("binds five mixed atomic goals to ordered non-overlapping Unicode spans", () => {
    const intent = "Show server version，在线玩家名单, TPS、MSPT; and plugin directory files";
    const goals = extractSourceGoals(intent).filter((goal) => goal.result_kind !== "judgement");
    expect(goals.map((goal) => goal.normalized)).toEqual([
      "server.version", "players.online", "performance.tps", "performance.mspt", "plugins.files",
    ]);
    for (const [index, goal] of goals.entries()) {
      expect([...intent].slice(goal.source_start, goal.source_end).join("")).toBe(goal.source_text);
      if (index > 0) expect(goal.source_start).toBeGreaterThanOrEqual(goals[index - 1].source_end);
    }
  });

  it("encodes an auditable collection predicate in the source-goal digest", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "List plugin directory files, then judge whether all entries have suffix .jar");
    const judgement = plan.source_goals.find((goal) => goal.result_kind === "judgement");
    expect(judgement?.predicate).toMatchObject({ schema_version: "goal-predicate/v2", quantifier: "all", operator: "equals", expected: true });
    expect(plan.goal_requirements.find((goal) => goal.result_kind === "judgement")?.predicate?.operands[0].goal_id).toMatch(/^g-/);
  });
  it.each([
    [
      "只做观察：先报服务端版本，统计已加载插件数量，汇总最近错误条数，最后判断今晚能否维护；不要写配置。",
      ["fact", "count", "count", "judgement"],
      "partial",
    ],
    [
      "Without changing state, give the online roster, TPS, count only .jar files under /plugins, then recommend whether traffic should stay open.",
      ["collection", "fact", "collection", "filtered_count", "judgement"],
      "partial",
    ],
    [
      "先看 MSPT，再列当前在线成员；read recent crash events and count them，最后给一个综合判断，但别重启。",
      ["fact", "collection", "collection", "count", "judgement"],
      "partial",
    ],
  ])("keeps every source atom and its requested result shape for: %s", (intent, resultKinds, expectedCoverage) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent);
    expect(plan.source_goals.map((goal) => goal.result_kind)).toEqual(resultKinds);
    expect(plan.source_goals.every((goal) => goal.source_text && goal.source_start >= 0 && goal.source_end > goal.source_start)).toBe(true);
    expect(plan.goal_requirements.flatMap((goal) => goal.source_goal_ids).sort())
      .toEqual(plan.source_goals.map((goal) => goal.id).sort());
    expect(plan.coverage).toBe(expectedCoverage);
  });

  it("does not turn a local negative constraint into a positive source goal", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "列出已加载插件并统计数量，然后总结异常；不要下载、不要安装，也不要重启。",
    );
    expect(plan.source_goals.map((goal) => goal.normalized)).not.toEqual(expect.arrayContaining(["download", "install", "restart"]));
    expect(plan.constraints.map((constraint) => constraint.action)).toEqual(expect.arrayContaining(["download", "install", "restart"]));
  });

  it("exposes an unmapped atom instead of silently deleting it", () => {
    const source = extractSourceGoals("读取服务器版本、量化星门稳定系数，最后判断是否适合迁移");
    expect(source.some((goal) => goal.domain === "unknown" && goal.status === "unmapped")).toBe(true);
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "读取服务器版本、量化星门稳定系数，最后判断是否适合迁移");
    expect(plan.coverage).not.toBe("full");
    expect(plan.goal_requirements.some((goal) => goal.status === "unsupported")).toBe(true);
  });

  it("distinguishes a collection from a filtered count even when both use files.list", () => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "列出 /plugins 下的条目，同时只统计扩展名为 .jar 的文件数量",
    );
    expect(plan.source_goals.map((goal) => goal.result_kind)).toEqual(["collection", "filtered_count"]);
    expect(plan.source_goals[1].filter).toEqual({ field: "name", operator: "suffix", value: ".jar" });
    expect(plan.goal_requirements).toHaveLength(2);
    expect(new Set(plan.goal_requirements.flatMap((goal) => goal.execute_step_ids))).toEqual(new Set(["s1"]));
  });

  it.each([0, 1, 3])("refuses full coverage when source goal %s is missing from the goal mapping", (removed) => {
    const plan = draftPlan(
      "mcs:daemon:instance",
      "revision-1",
      "读取服务端版本、在线成员、TPS，并据此给出容量建议",
    );
    const sourceId = plan.source_goals[removed].id;
    for (const goal of plan.goal_requirements) goal.source_goal_ids = goal.source_goal_ids.filter((id) => id !== sourceId);
    const mapped = new Set(plan.goal_requirements.flatMap((goal) => goal.source_goal_ids));
    expect(mapped.has(sourceId)).toBe(false);
    expect(plan.source_goals.some((goal) => !mapped.has(goal.id))).toBe(true);
  });
});
