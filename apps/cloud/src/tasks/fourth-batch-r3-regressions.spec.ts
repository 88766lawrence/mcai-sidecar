import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { renderTypedReadCompletion } from "./typed-read-completion";

const instance = "mcs:daemon:fourth-r3";

function planFor(intent: string) {
  return draftPlan(instance, "rev-fourth-r3", intent);
}

describe("fourth-batch R3 product regressions", () => {
  it.each([
    ["请只读汇总现在连接了几人、可容纳的玩家上限以及当前使用百分比。", "当前在线 4 人，玩家上限 25 人，占用率 16%。"],
    ["Read the connected player count, slot capacity, and current occupancy percentage.", "4 players are online out of a capacity of 25; occupancy is 16%."],
  ])("renders a coherent occupancy aggregate: %s", (intent, expected) => {
    const answer = renderTypedReadCompletion({
      intent, state: "SUCCEEDED", action: "read",
      goals: [
        { id: "online", domain: "players", target: "online", resultKind: "count", required: true, semanticKey: "players.online-count" },
        { id: "capacity", domain: "config", target: "server.properties#max-players", resultKind: "fact", required: true, semanticKey: "config.value:server.properties:max-players" },
        { id: "ratio", domain: "players", target: "occupancy", resultKind: "fact", required: true, semanticKey: "players.occupancy-ratio" },
      ],
      results: [
        { goalId: "online", status: "satisfied", observed: 4 },
        { goalId: "capacity", status: "satisfied", observed: 25 },
        { goalId: "ratio", status: "satisfied", observed: 0.16 },
      ],
    });
    expect(answer).toBe(expected);
  });

  it.each([
    [0, 0, 0],
    [3, 2, 1.5],
    [4, 25, 0.2],
  ])("fails closed for contradictory occupancy operands: %s/%s/%s", (online, capacity, ratio) => {
    expect(renderTypedReadCompletion({
      intent: "汇总在线人数、上限和占用率", state: "SUCCEEDED", action: "read",
      goals: [
        { id: "online", domain: "players", target: "online", resultKind: "count", required: true, semanticKey: "players.online-count" },
        { id: "capacity", domain: "config", target: "server.properties#max-players", resultKind: "fact", required: true, semanticKey: "config.value:server.properties:max-players" },
        { id: "ratio", domain: "players", target: "occupancy", resultKind: "fact", required: true, semanticKey: "players.occupancy-ratio" },
      ],
      results: [
        { goalId: "online", status: "satisfied", observed: online },
        { goalId: "capacity", status: "satisfied", observed: capacity },
        { goalId: "ratio", status: "satisfied", observed: ratio },
      ],
    })).toBeUndefined();
  });

  it("aggregates the runtime roster collection shape with capacity and occupancy facts", () => {
    expect(renderTypedReadCompletion({
      intent: "只读给出连接人数、容量上限与占用百分比。", state: "SUCCEEDED", action: "read",
      goals: [
        { id: "online", domain: "players", target: "online", resultKind: "collection", required: true },
        { id: "capacity", domain: "config", target: "server.properties#max-players", resultKind: "fact", required: true },
        { id: "ratio", domain: "players", target: "occupancy", resultKind: "fact", required: true },
      ],
      results: [
        { goalId: "online", status: "satisfied", observed: [] },
        { goalId: "capacity", status: "satisfied", observed: 20 },
        { goalId: "ratio", status: "satisfied", observed: 0 },
      ],
    })).toBe("当前在线 0 人，玩家上限 20 人，占用率 0%。");
  });

  it.each([
    "只读给出常加载区域清单及总数，不要添加或移除任何区域。",
    "Show the force-loaded chunk roster and total without changing the set.",
  ])("keeps force-loaded collection and count on one read: %s", (intent) => {
    const plan = planFor(intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "forceload query" }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.result_kind).sort()).toEqual(["collection", "count"]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    "读取进程持续运行时间、处理器和内存用量以及可用容量，然后判断资源压力。",
    "Report service uptime, processor use, RAM consumption and capacity, then assess overall resource pressure.",
  ])("keeps all resource facts and the derived judgement: %s", (intent) => {
    const plan = planFor(intent);
    expect(plan.steps).toEqual([{ id: "s1", tool: "instance.metrics", args: {
      schema_version: "instance-metrics/v2", metrics: ["uptime", "cpu", "memory"], include_capacity: true,
    }, risk: "read" }]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.target).sort()).toEqual([
      "cpu", "memory", "resource-pressure", "uptime",
    ]);
    expect(plan.coverage).toBe("full");
  });

  it.each([
    "给全体在线成员各生成五个 happy villager 粒子，只做这件事。",
    "Display five happy-villager particles once beside each connected player and do nothing else.",
  ])("guards a bounded nested audience write so zero targets are observable: %s", (intent) => {
    const plan = planFor(intent);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "console.command", risk: "medium", requires_confirmation: true });
    expect(String(plan.steps[0].args.command)).toMatch(/^execute if entity @a run execute as @a at @s run particle /);
  });
});
