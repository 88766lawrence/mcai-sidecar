import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";

const instance = "mcs:daemon:third-batch";

describe("public third-batch cross-layer fixtures", () => {
  it.each([
    ["只读告诉我当前主世界的种子值，不要改任何世界设置。", "seed", ["world.seed"]],
    ["查一下当前游戏难度，再按这个难度判断是否处于和平模式，不要更改。", "difficulty", ["world.difficulty", "world.difficulty-peaceful"]],
    ["读取主世界现在的时间刻数，并说明当前是白天还是夜晚，别调时间。", "time query daytime", ["world.daytime", "world.day-period"]],
    ["只查询当前世界边界的直径是多少格，不要改动边界。", "worldborder get", ["world.border-diameter"]],
    ["看看当前启用了哪些数据包，把名称和数量一起告诉我，不要启用或停用任何包。", "datapack list enabled", ["world.datapacks-enabled", "world.datapacks-enabled-count"]],
  ])("covers the published runtime observation: %s", (intent, command, goals) => {
    const plan = draftPlan(instance, "rev-runtime-public", intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command }, risk: "read" }]);
    expect(plan.source_goals.filter((goal) => goal.required).map((goal) => goal.normalized)).toEqual(goals);
    expect(plan.coverage).toBe("full");
  });

  it("keeps both server-lag event branches and the derived judgement", () => {
    const plan = draftPlan(instance, "rev-c8", "检查最近日志里有没有服务器跟不上或单个tick超时，给出匹配数并判断是否存在卡顿迹象。", { preferredTool: "logs.query" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].tool).toBe("logs.query");
    expect(plan.steps[0].args.filter_query).toMatchObject({
      schema_version: "log-filter-query/v1",
      groups: [{ all_of: ["server_lag"], any_of: ["cannot_keep_up", "tick_timeout"] }],
    });
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind)).toEqual(["collection", "count", "judgement"]);
    expect(plan.coverage).toBe("full");
  });

  it("keeps watchdog tick-duration wording on the same lag event graph", () => {
    const plan = draftPlan(instance, "rev-lag-duration", "检查最近记录中服务器落后跟不上或watchdog单次tick耗时过长，给出命中数并判断有无卡顿迹象。", { preferredTool: "logs.query" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].tool).toBe("logs.query");
    expect(plan.steps[0].args.filter_query).toMatchObject({
      schema_version: "log-filter-query/v1",
      groups: [{ all_of: ["server_lag"], any_of: ["cannot_keep_up", "tick_timeout"] }],
    });
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind)).toEqual(["collection", "count", "judgement"]);
    expect(plan.coverage).toBe("full");
  });

  it("creates a complete metadata-only plugin resolution", () => {
    const plan = draftPlan(instance, "rev-c9", "只做资料查证，核对LuckPerms是否适配Paper 1.21.1，同时给出可信来源、制品名和校验值，禁止下载安装。", { preferredTool: "plugin.resolve" });
    expect(plan.steps).toEqual([{ id: "s1", tool: "plugin.resolve", args: expect.objectContaining({ project: "luckperms", platform: "paper", minecraft_version: "1.21.1" }), risk: "read" }]);
    expect(plan.constraints.map((item) => item.action)).toEqual(expect.arrayContaining(["download", "install"]));
    expect(plan.coverage).toBe("full");
  });

  it("retains clear weather as the sole confirmed write", () => {
    const plan = draftPlan(instance, "rev-c10", "把当前主世界天气设为晴天，除了天气什么都别改，也不要重启服务器。");
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "weather clear" }, risk: "medium", requires_confirmation: true }]);
    expect(plan.constraints.map((item) => item.action)).toContain("restart");
  });
});
