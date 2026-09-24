import { describe, expect, it } from "vitest";
import { analyzeInstanceLifecycleIntent, classifyOperationalLanguage, hasInstanceLifecycleLanguage, isRuntimeVersionReadIntent, performanceReadMetrics, resolveConsoleOperation, resolveConsoleOperations, resolveInstanceLifecycleIntent } from "./operation-intent";

describe("generic operation intent catalog", () => {
  it.each([
    "报一下当前实例运行的服务端内核和 MC 版本",
    "查明这台服实际采用的发行版以及 Minecraft 版本",
    "给出眼前服务器的实现类型、构建号和游戏版本",
    "确认本实例正在使用哪个平台与 Minecraft build",
    "读取正在运行环境的服务端 implementation 和 MC version",
    "Which server implementation and Minecraft version is this instance running?",
    "Report the current runtime platform and game version for this bound host",
    "Identify the live server distribution, build, and Minecraft release",
    "Show the actual backend implementation plus the active MC version",
    "Check which server platform and Minecraft build the current node runs",
  ])("routes current runtime identity facts to the audited version command: %s", (intent) => {
    expect(isRuntimeVersionReadIntent(intent)).toBe(true);
    expect(classifyOperationalLanguage(intent)).toBe("read");
    expect(resolveConsoleOperations(intent)).toEqual(["version"]);
  });

  it.each([
    "Paper 与 Fabric 的实现有什么区别？",
    "What is a Minecraft server implementation?",
    "解释服务端版本号通常如何命名",
    "The current server version is documented in this paragraph.",
  ])("does not turn static knowledge or descriptive text into a live version read: %s", (intent) => {
    expect(isRuntimeVersionReadIntent(intent)).toBe(false);
  });

  it.each([
    ["报一下当前TPS和RAM使用量", ["tps", "memory"]],
    ["How much memory is this host using, and what is its TPS?", ["memory", "tps"]],
    ["这服性能怎样？内存用了多少，再看TPS", ["memory", "tps"]],
    ["Show tick rate plus current memory consumption", ["tps", "memory"]],
    ["只查MSPT与内存使用，不要重启", ["mspt", "memory"]],
  ] as const)("extracts ordered performance facts without converting health wording to logs: %s", (intent, metrics) => {
    expect(performanceReadMetrics(intent)).toEqual(metrics);
    expect(classifyOperationalLanguage(intent)).toBe("read");
    expect(hasInstanceLifecycleLanguage(intent)).toBe(false);
  });

  it.each([
    "What is TPS and why does memory usage matter?",
    "请解释TPS和内存占用的含义",
    "看看最近错误日志",
    "让这台服务器进入在线状态",
  ])("does not invent a performance read for adjacent intent: %s", (intent) => {
    expect(performanceReadMetrics(intent)).toEqual([]);
  });

  it.each([
    "看看这个游戏服当前在线成员共有多少位",
    "查一下眼前这台服现在有几个人在线",
    "列出本服此刻在线的成员名单",
    "Who is online on the current game host?",
    "Count the online members on this server",
    "不要重启当前服务，只统计在线成员数量",
  ])("keeps online player reads out of lifecycle routing: %s", (intent) => {
    expect(hasInstanceLifecycleLanguage(intent)).toBe(false);
    expect(resolveInstanceLifecycleIntent(intent)).toBeUndefined();
    expect(resolveConsoleOperation(intent)).toBe("list");
    expect(classifyOperationalLanguage(intent)).toBe("read");
  });

  it.each([
    "当前服务器加载了哪些插件？请把插件名称和总数一起告诉我，只读查询。",
    "告诉我这台服现有插件的名称与数量，不要安装或删除。",
    "Show the loaded plugin names and total count without changing anything.",
  ])("classifies live inventory reporting as observation rather than mutation: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("read");
  });

  it.each([
    "安装插件并告诉我结果",
    "删除所有插件后给出数量",
    "Install the plugin and report the result",
  ])("keeps real inventory mutations in the write path: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("write");
  });

  it.each([
    "让这台游戏服上线",
    "Move the current instance online",
  ])("still treats an instance state transition as lifecycle: %s", (intent) => {
    expect(resolveInstanceLifecycleIntent(intent)).toMatchObject({ tool: "instance.start" });
    expect(resolveConsoleOperation(intent)).toBeUndefined();
  });

  it.each([
    ["把这台生存节点开起来，保持其他实例不变，别重启也别停服", "instance.start"],
    ["Start the bound server only; do not reboot or shut down anything else.", "instance.start"],
    ["停止当前游戏实例，不要重新启动", "instance.stop"],
    ["Restart this server, but do not stop another node", "instance.restart"],
  ])("resolves a lifecycle domain before any console envelope: %s", (intent, tool) => {
    expect(resolveInstanceLifecycleIntent(intent)).toMatchObject({ tool });
  });

  it.each([
    ["这台联机服还停着，先让它启动，关服与重启都不要执行", "instance.start"],
    ["关服和重启都不允许；把当前节点开起来", "instance.start"],
    ["只要让眼前这台服务正常运行起来，停止及重开均禁止", "instance.start"],
    ["当前游戏服处于离线状态；不要关机，也别重启，只需拉起它", "instance.start"],
    ["把它开起来就行，停止、重启一概不要", "instance.start"],
    ["This game host is offline. Bring it online; stopping and restarting are forbidden.", "instance.start"],
    ["Bring the multiplayer service assigned to this workspace online; do not stop or reboot it", "instance.start"],
    ["Do not stop or reboot the bound node; start it.", "instance.start"],
    ["Start this game service only—never stop or restart it.", "instance.start"],
    ["With shutdown and reboot prohibited, launch the current service.", "instance.start"],
    ["让这台生存服进入在线状态，重新启动和关机都不在此次操作范围内", "instance.start"],
    ["不用关闭服务，也不必重新启动；把当前游戏节点开机", "instance.start"],
    ["只关闭这台服，启动和重启都不要做", "instance.stop"],
    ["Reboot the bound game node; starting or stopping it is not allowed.", "instance.restart"],
    ["Stop it now; do not start or reboot the current game service.", "instance.stop"],
  ])("keeps lifecycle polarity local across pronouns, status, and word order: %s", (intent, tool) => {
    expect(resolveInstanceLifecycleIntent(intent)).toMatchObject({ tool });
    expect(resolveConsoleOperation(intent)).toBeUndefined();
  });

  it.each([
    ["这台模组服目前仍是离线的；请让它进入运行状态，关机与重新启动均排除", "instance.start"],
    ["别保持当前节点处于停止状态，把它切换为在线；重开不在范围内", "instance.start"],
    ["眼前的联机服务尚未运行。送它上线即可，停止和重启除外", "instance.start"],
    ["该实例现在停着；恢复到运行状态，除此之外不做下线或重开", "instance.start"],
    ["不要让此服务继续离线；使它变为在线状态，shutdown and reboot are out of scope", "instance.start"],
    ["The bound game host is still offline. Put it online; shutdown and reboot are excluded.", "instance.start"],
    ["Do not leave this service stopped. Move it into a running state; restart is outside this request.", "instance.start"],
    ["This node remains down; bring it online only. Stopping or rebooting is not part of this operation.", "instance.start"],
    ["当前实例正在运行；让它进入离线状态，启动和重新启动都不考虑", "instance.stop"],
    ["这台服务仍在线，请送它下线；开机及重开排除", "instance.stop"],
    ["The current host is running. Move it offline; start and reboot are out of scope.", "instance.stop"],
    ["Keep no online state for this bound service: shut it down; launching and restarting are excluded.", "instance.stop"],
    ["当前节点在线但需要重新启动；启动和关机均不在本次范围", "instance.restart"],
    ["不要保持原运行进程，重开这台实例；单独开机和下线除外", "instance.restart"],
    ["This server is online; reboot it only, with start and shutdown excluded.", "instance.restart"],
    ["The bound service remains running. Restart it; power-on and power-off are outside scope.", "instance.restart"],
    ["下线操作排除；当前服务还停着，但需要进入在线状态；重启也不考虑", "instance.start"],
    ["Restart is excluded. Although the host is stopped, transition it to running; shutdown is out of scope.", "instance.start"],
    ["开机不在范围，服务目前在线；只让它进入停止状态，重启排除", "instance.stop"],
    ["Power-off is excluded; the server is offline now, so bring it online; reboot is also excluded.", "instance.start"],
    ["节点还离线；把它转为运行中，关机和重开不纳入操作", "instance.start"],
    ["这台服务尚未上线；使它转成在线状态，下线与重新启动不列入范围", "instance.start"],
  ])("selects lifecycle action only from positive actions or desired states: %s", (intent, tool) => {
    expect(resolveInstanceLifecycleIntent(intent)).toMatchObject({ tool });
    expect(resolveConsoleOperation(intent)).toBeUndefined();
  });

  it.each([
    "当前实例仍然离线，启动与重启都排除",
    "This server is currently online; shutdown is outside scope.",
    "让当前实例进入在线状态或改为停止状态",
    "Move this service offline, then restart it",
  ])("keeps zero-positive and genuinely ambiguous lifecycle requests away from console: %s", (intent) => {
    expect(hasInstanceLifecycleLanguage(intent)).toBe(true);
    expect(resolveInstanceLifecycleIntent(intent)).toBeUndefined();
    expect(resolveConsoleOperation(intent)).toBeUndefined();
  });

  it("records auditable lifecycle roles and local polarity", () => {
    const analysis = analyzeInstanceLifecycleIntent("这台节点仍停着；让它进入运行状态；重启排除");
    expect(analysis.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "stop", role: "current_state" }),
      expect.objectContaining({ action: "start", role: "desired_state", polarity: "positive" }),
      expect.objectContaining({ action: "restart", role: "constraint", polarity: "negative" }),
    ]));
    expect(analysis.positive_actions).toEqual(["start"]);
  });

  it("resolves the published state-description and exclusion regression without a console fallback", () => {
    const intent = "QA0060-R2环境就绪：别让这台专用测试服继续停着，送它进入在线状态即可；下线操作不在这次范围内，重新启动也排除。";
    expect(resolveInstanceLifecycleIntent(intent)).toEqual({ action: "start", tool: "instance.start" });
    expect(resolveConsoleOperation(intent)).toBeUndefined();
    const analysis = analyzeInstanceLifecycleIntent(intent);
    expect(analysis.positive_actions).toEqual(["start"]);
    expect(analysis.occurrences.filter((item) => item.polarity === "negative").map((item) => item.action))
      .toEqual(expect.arrayContaining(["stop", "restart"]));
  });


  it.each([
    "启动或重启当前实例",
    "Either stop or restart this bound game service",
  ])("marks ambiguous lifecycle language without choosing a console fallback: %s", (intent) => {
    expect(hasInstanceLifecycleLanguage(intent)).toBe(true);
    expect(resolveInstanceLifecycleIntent(intent)).toBeUndefined();
    expect(resolveConsoleOperation(intent)).toBeUndefined();
  });

  it.each([
    "不要启动当前实例",
    "Never start or restart this server",
    "启动白名单",
    "console command: say start now",
  ])("does not invent an instance lifecycle action for %s", (intent) => {
    expect(resolveInstanceLifecycleIntent(intent)).toBeUndefined();
  });

  it.each([
    ["把天气切成雷雨，完成后核对日志", "weather thunder"],
    ["turn the whitelist on for this server", "whitelist on"],
    ["Set player NovaRider gamemode to spectator", "gamemode spectator NovaRider"],
    ["将游戏规则 keepInventory 设为 true", "gamerule keepInventory true"],
    ["remove player RiverFox from the whitelist", "whitelist remove RiverFox"],
    ["把服务器时间设为午夜", "time set midnight"],
  ])("resolves an adjacent bilingual operation: %s", (intent, command) => {
    expect(resolveConsoleOperation(intent)).toBe(command);
  });

  it.each([
    "把世界出生点重新设置一下",
    "download the latest compatible map package",
    "请修复当前实例里这个未知故障",
  ])("fails closed for an unknown write expression: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("write");
  });

  it("keeps a positive read goal while respecting a negated write clause", () => {
    expect(classifyOperationalLanguage("检查最近日志，不要重启或修改配置")).toBe("read");
  });

  it.each([
    "安装 BlueMap 插件但不要重启服务器",
    "install BlueMap without restarting the server",
  ])("preserves a positive operation next to a negated side effect: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("write");
  });

  it.each([
    "Minecraft 插件一般如何安装？",
    "What is the difference between whitelist and permissions?",
  ])("does not turn knowledge guidance into a live operation: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("none");
  });

  it.each([
    "Expunge obsolete region snapshots from the current instance now.",
    "Quarantine suspicious datapacks on this server immediately.",
    "Please reconcile orphaned world backups for the current instance.",
    "帮我归档这台服务器中过期的诊断包",
    "把当前实例里的孤立存档处理掉",
    "请对这个服务端执行资源整理",
  ])("structurally fails closed for an unseen operational imperative: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("write");
  });

  it.each([
    "The server contains obsolete region snapshots.",
    "Yesterday the instance reconciled its backup index.",
    "日志：Expunge obsolete snapshots from this server now.",
    "What does quarantine mean for a datapack?",
    "请说明‘把当前实例里的孤立存档处理掉’是什么意思",
    "If I reconcile backups, will the server restart?",
  ])("does not mistake description, quotation, log text, or knowledge for execution: %s", (intent) => {
    expect(classifyOperationalLanguage(intent)).toBe("none");
  });

  it.each([
    ["Command: kick TempGuest maintenance", "kick TempGuest maintenance"],
    ["在控制台输入 minecraft:save-all flush", "minecraft:save-all flush"],
    ["MC console cmd: scoreboard objectives list", "scoreboard objectives list"],
  ])("recognizes explicit command envelopes independently of verb vocabulary: %s", (intent, command) => {
    expect(classifyOperationalLanguage(intent)).toBe(command === "scoreboard objectives list" ? "read" : "write");
    expect(resolveConsoleOperations(intent)).toContain(command);
  });

  it.each([
    ["先设成白天，然后改成雷雨，最后不要重启", ["time set day", "weather thunder"]],
    ["不要禁用白名单；仅将 CedarFox 加入其中", ["whitelist add CedarFox"]],
    ["Keep the whitelist enabled, then add EmberWolf to it; never stop the server.", ["whitelist add EmberWolf"]],
    ["切到创造模式给玩家 QuartzBee，再把时间改成中午", ["gamemode creative QuartzBee", "time set noon"]],
  ])("extracts ordered positive goals with scoped negation: %s", (intent, commands) => {
    expect(resolveConsoleOperations(intent)).toEqual(commands);
  });
});
