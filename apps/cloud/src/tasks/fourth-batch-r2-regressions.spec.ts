import { describe, expect, it } from "vitest";
import { draftPlan, extractPluginResolveIntent } from "./planner";

const instance = "mcs:daemon:fourth-r2";

function planFor(intent: string, preferredTool?: string) {
  return draftPlan(instance, "rev-fourth-r2", intent, preferredTool ? { preferredTool } : undefined);
}

describe("fourth-batch R2 product regressions", () => {
  it.each([
    ["仅做资料研究：判断 BlueMap 是否有适用于 Paper 1.21.1 的可信制品并给出校验信息，禁止下载和安装。", "bluemap"],
    ["Review whether Aurora Bridge has an artifact for Purpur 1.20.6, including provenance and checksum; never fetch or install it.", "aurora-bridge"],
  ])("routes an applicability-style plugin entity through the metadata-only chain: %s", (intent, project) => {
    expect(extractPluginResolveIntent(intent)).toMatchObject({ project });
    const plan = planFor(intent, "plugin.resolve");
    expect(plan.coverage).toBe("full");
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "plugin.resolve", risk: "read", args: expect.objectContaining({ project }) })]);
    expect(plan.constraints.map((constraint) => constraint.action)).toEqual(expect.arrayContaining(["download", "install"]));
  });

  it.each([
    "只读算一下当前在线人数占最大玩家容量的比例，同时给出人数和上限，别改设置。",
    "请读取现有连接人数、服务器玩家上限，并计算当前席位使用百分比；不要调整配置。",
  ])("preserves the online count, capacity and ratio for %s", (intent) => {
    const plan = planFor(intent);
    expect(plan.steps.map((step) => [step.tool, step.args])).toEqual([
      ["console.command", { command: "list" }],
      ["config.inspect", { path: "server.properties", keys: ["max-players"] }],
    ]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.target).sort()).toEqual([
      "occupancy",
      "online",
      "server.properties#max-players",
    ]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    "先看有没有人在线；如果有，只读查第一个人的当前游戏模式，没人就直接说明没人，别改玩家状态。",
    "先确认是否存在连接成员；有人的话读取首位成员的游戏模式，没有则说明空结果，禁止修改玩家。",
  ])("keeps a conditional player observation separate from its write forbid: %s", (intent) => {
    const plan = planFor(intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "players.inspect", args: { schema_version: "players-inspect/v1", selector: "first-online", fields: ["gamemode"] }, risk: "read" }]);
    expect(plan.constraints).toEqual([expect.objectContaining({ action: "write", effect: "forbid" })]);
    expect(plan.clause_ledger.filter((clause) => clause.role === "safety_constraint").every((clause) => clause.polarity === "negative" && clause.source_goal_ids.length === 0)).toBe(true);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    "只读检查crash-reports目录里现有多少个txt崩溃报告，若没有就明确说零，并列出实际文件名。",
    "请列出error-dumps文件夹中的log故障报告并统计数量，只查看不要改动。",
  ])("routes an explicit report directory to one filesystem read: %s", (intent) => {
    const plan = planFor(intent);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "files.list", risk: "read" });
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind).sort()).toEqual(["collection", "filtered_count"]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["查最近日志里有没有内存不足、堆空间耗尽或GC开销过高，给出匹配数量并判断是否存在内存故障迹象。", ["out_of_memory", "heap_exhaustion", "gc_overhead"]],
    ["Review recent logs for heap exhaustion, excessive garbage-collection overhead, or an out-of-memory condition; count matches and assess memory trouble.", ["heap_exhaustion", "gc_overhead", "out_of_memory"]],
  ])("keeps every memory event as OR alternatives: %s", (intent, events) => {
    const plan = planFor(intent, "logs.query");
    expect(plan.steps).toHaveLength(1);
    const query = plan.steps[0].args.filter_query as { groups: Array<{ all_of: string[]; any_of: string[] }> };
    expect(query.groups).toHaveLength(1);
    expect(query.groups[0].all_of).toEqual(["memory_resource"]);
    expect(query.groups[0].any_of).toEqual(expect.arrayContaining(events));
    expect(query.groups[0].any_of).toHaveLength(events.length);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind)).toEqual(["collection", "count", "judgement"]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["只做资料核验，判断Fabric API能否直接用于Paper 1.21.1，并给可信来源和可用制品校验；不兼容或没有制品就如实说明，禁止下载安装。", "fabric-api"],
    ["Metadata only: verify whether Cloth Config works on Paper 1.21.1 and report provenance plus artifact checksum; never download or install it.", "cloth-config"],
  ])("keeps a multi-word plugin identity on plugin.resolve: %s", (intent, project) => {
    const plan = planFor(intent, "plugin.resolve");
    expect(plan.steps).toEqual([{ id: "s1", tool: "plugin.resolve", args: { project, minecraft_version: "1.21.1", platform: "paper", loader: "paper", source: "modrinth" }, risk: "read" }]);
    expect(plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["只读查看doMobSpawning游戏规则，并说明生物是否会按规则自然生成，别修改。", "doMobSpawning"],
    ["查询doMobSpawning游戏规则当前值，并判断生物是否自然生成，不要修改。", "doMobSpawning"],
  ])("keeps a gamerule getter and judgement while forbidding writes: %s", (intent, rule) => {
    const plan = planFor(intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: `gamerule ${rule}` }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind).sort()).toEqual(["fact", "judgement"]);
    expect(plan.constraints).toEqual([expect.objectContaining({ action: "write", effect: "forbid" })]);
    expect(plan.coverage).toBe("full");
  });

  it("does not duplicate a plain gamerule observation as an unknown business goal", () => {
    const plan = planFor("只读查看当前世界的 doMobSpawning 规则值，别修改任何游戏规则。");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "gamerule doMobSpawning" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => [goal.domain, goal.target, goal.status])).toEqual([
      ["gamerule", "doMobSpawning", "pending"],
    ]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["只读查看当前被封禁的玩家名单和人数，没有就明确说零，不要新增或解除封禁。", "banlist players"],
    ["Report the current banned-user roster and total; add or pardon nobody.", "banlist players"],
    ["只查询计分板里现有队伍的名称和数量，不创建、不删除也不修改队伍。", "team list"],
    ["Read existing scoreboard team names and their total without creating, removing, or editing a team.", "team list"],
  ])("keeps roster collection/count coverage complete: %s", (intent, command) => {
    const plan = planFor(intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind).sort()).toEqual(["collection", "count"]);
    expect(plan.coverage).toBe("full");
  });

  it("keeps repeated local write prohibitions source-bound for Agent validation", () => {
    const plan = planFor("只读给出已有队伍名称和队伍总数，不创建、不删除任何队伍。");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "team list" }, risk: "read" }]);
    expect(plan.constraints).toEqual([
      expect.objectContaining({ action: "write", effect: "forbid", source: "不创建", clause_id: "clause-2" }),
      expect.objectContaining({ action: "write", effect: "forbid", source: "不删除任何队伍", clause_id: "clause-3" }),
    ]);
    expect(plan.clause_ledger.filter((clause) => clause.role === "safety_constraint").every((clause) => clause.source_atom_ids.length === 1 && clause.constraint_actions.includes("write"))).toBe(true);
  });

  it("keeps an English force-loaded region collection when its count is in a later clause", () => {
    const plan = planFor("Report the currently force-loaded regions and their total, without adding or removing any region.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "forceload query" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind).sort()).toEqual(["collection", "count"]);
    expect(plan.coverage).toBe("full");
  });

  it("does not promote an English write-boundary gerund into a configuration key", () => {
    const plan = planFor("Read the current server-ip and server-port values and explain the binding without editing server.properties.");
    expect(plan.steps).toEqual([{ id: "s1", tool: "config.inspect", args: { path: "server.properties", keys: ["server-ip", "server-port"] }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.target)).toEqual([
      "server.properties#server-ip",
      "server.properties#server-port",
    ]);
    expect(plan.coverage).toBe("full");
  });
});

describe("fourth-batch R2 protected adjacent boundaries", () => {
  it.each([
    ["List force-loaded regions and their total, without adding or removing any.", "console.command", "read"],
    ["Read process uptime, CPU, memory and capacity, then assess resource pressure.", "instance.metrics", "read"],
    ["Inspect the current server-ip and server-port values in server.properties; do not write the file.", "config.inspect", "read"],
  ])("keeps an existing bounded read plan for %s", (intent, tool, risk) => {
    const plan = planFor(intent);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]).toMatchObject({ tool, risk });
    expect(plan.coverage).toBe("full");
  });

  it.each([
    ["Play one bell sound for every connected player and do nothing else.", /^playsound /],
    ["Place five happy-villager particles once beside every connected member; never change configuration.", /^execute if entity @a run execute as @a at @s run particle /],
  ])("keeps transient writes behind one confirmation: %s", (intent, command) => {
    const plan = planFor(intent);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "console.command", risk: "medium", requires_confirmation: true });
    expect(String(plan.steps[0].args.command)).toMatch(command);
  });
});
