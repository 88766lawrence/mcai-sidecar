import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { draftPlan } from "./planner";
import { renderTypedReadCompletion } from "./typed-read-completion";

const ref = "mcs:daemon:task0099";

describe("online count plus maximum capacity", () => {
  it.each([
    "现在有几个人在线，最多能进多少人？仅查看，别调整配置。",
    "查下当前连接人数以及最大可容纳多少玩家；不要更改设置。",
    "请只读告诉我眼下连接着几位玩家，以及这个服最多可容纳多少人；不要改配置。",
    "How many players are connected now and what is the maximum slot capacity? Read only; change nothing.",
  ])("keeps both facts and the trailing write prohibition: %s", (intent) => {
    const plan = draftPlan(ref, "revision-0099", intent);
    expect(plan.steps).toEqual([
      { id: "s1", tool: "console.command", args: { command: "list" }, risk: "read" },
      { id: "s2", tool: "config.inspect", args: { path: "server.properties", keys: ["max-players"] }, risk: "read" },
    ]);
    expect(plan.goal_requirements.filter((goal) => goal.required).map((goal) => goal.target).sort())
      .toEqual(["online", "server.properties#max-players"]);
    expect(plan.coverage).toBe("full");
    expect(plan.operation).toMatchObject({ action: "read", risk: "read", requires_confirmation: false });
    expect(plan.constraints).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", effect: "forbid" })]));
    expect(plan.clause_ledger.filter((clause) => clause.role === "domain_goal")
      .every((clause) => clause.source_goal_ids.length > 0 && clause.source_atom_ids.length > 0)).toBe(true);
  });

  it("naturally combines the two authoritative facts without inventing occupancy", () => {
    expect(renderTypedReadCompletion({
      intent: "请给出在线人数和最大容量。",
      state: "SUCCEEDED",
      action: "read",
      goals: [
        { id: "online", domain: "players", target: "online", resultKind: "count", required: true, semanticKey: "players.online-count" },
        { id: "capacity", domain: "config", target: "server.properties#max-players", resultKind: "fact", required: true, semanticKey: "config.value:server.properties:max-players" },
      ],
      results: [
        { goalId: "online", status: "satisfied", observed: 3 },
        { goalId: "capacity", status: "satisfied", observed: 24 },
      ],
    })).toBe("当前在线 3 人，最大容量 24 人。");
  });

  it("fails closed when the online count exceeds capacity", () => {
    expect(renderTypedReadCompletion({
      intent: "How many are online and what is the maximum capacity?",
      state: "SUCCEEDED",
      action: "read",
      goals: [
        { id: "online", domain: "players", target: "online", resultKind: "count", required: true, semanticKey: "players.online-count" },
        { id: "capacity", domain: "config", target: "server.properties#max-players", resultKind: "fact", required: true, semanticKey: "config.value:server.properties:max-players" },
      ],
      results: [
        { goalId: "online", status: "satisfied", observed: 25 },
        { goalId: "capacity", status: "satisfied", observed: 24 },
      ],
    })).toBeUndefined();
  });

  it.runIf(Boolean(process.env.MCAI_TASK0099_PLAN_OUT))("writes a Cloud plan for the Go zero-trust overlay", () => {
    const plan = draftPlan(ref, "revision-0099", "请只读告诉我眼下连接着几位玩家，以及这个服最多可容纳多少人；不要改配置。");
    writeFileSync(process.env.MCAI_TASK0099_PLAN_OUT!, JSON.stringify(plan));
  });
});
