import { describe, expect, it } from "vitest";
import { extractSourceGoals } from "./goal-requirements";
import { computeOperationDigest, computeSourceGoalDigest, validatePlanCompatibility } from "./plan-compatibility";
import { draftPlan } from "./planner";

describe("positive atomic goal completeness before capability routing", () => {
  it("keeps server build, roster, one exact collection, aggregates, and every judgement around constraints", () => {
    const intent = [
      "先给出服务端精确构建号和当前在线成员名单；",
      "不要安装、写配置或重启；",
      "列出路径 '/srv/cluster/cache-v3' 的全部条目，统计总数以及以 .dat 结尾的条目数；",
      "判断所有条目是否都以 .dat 结尾，任意条目是否以 .idx 结尾，.dat 数量是否少于总数。",
    ].join("");

    const plan = draftPlan("instance", "revision", intent);
    const required = plan.source_goals.filter((goal) => goal.required);

    expect(required.some((goal) => goal.normalized === "server.version")).toBe(true);
    expect(required.some((goal) => goal.normalized === "players.online")).toBe(true);
    expect(required.filter((goal) => goal.domain === "filesystem" && goal.result_kind === "collection")).toHaveLength(1);
    expect(required.filter((goal) => goal.result_kind === "count")).toHaveLength(1);
    expect(required.filter((goal) => goal.result_kind === "filtered_count")).toHaveLength(1);
    expect(required.filter((goal) => goal.result_kind === "judgement")).toHaveLength(3);
    expect(plan.steps.map((step) => [step.tool, step.args.command ?? step.args.path])).toEqual([
      ["console.command", "version"],
      ["console.command", "list"],
      ["files.list", "/srv/cluster/cache-v3"],
    ]);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("non-greedily splits five mixed-language judgements with precise spans and typed dependencies", () => {
    const intent = "Show '/opt/archive/shards' entries and count total plus .idx entries; determine all names end in .idx、是否存在以 .bak2 结尾的条目、.idx 数量小于总数、.idx count is not equal to zero、以及 .idx 数量不超过总数。";
    const goals = extractSourceGoals(intent);
    const judgements = goals.filter((goal) => goal.result_kind === "judgement");

    expect(judgements).toHaveLength(5);
    expect(judgements.map((goal) => [goal.predicate?.quantifier, goal.predicate?.operator])).toEqual([
      ["all", "equals"], ["any", "gt"], [undefined, "lt"], [undefined, "not_equals"], [undefined, "lte"],
    ]);
    expect(judgements.every((goal) => goal.depends_on.length > 0)).toBe(true);
    expect(judgements.every((goal) => [...intent].slice(goal.source_start, goal.source_end).join("") === goal.source_text)).toBe(true);
    expect(new Set(judgements.map((goal) => `${goal.source_start}:${goal.source_end}`)).size).toBe(5);
  });

  it("reuses one canonical collection for explicit listing, counts, and judgements", () => {
    const plan = draftPlan(
      "instance",
      "revision",
      "读取 '/var/lib/mc/reports/daily' 的文件列表；统计全部文件数与 .bak2 文件数；确认任意文件以 .bak2 结尾并确认 .bak2 数量大于零。",
    );
    const collections = plan.source_goals.filter((goal) => goal.domain === "filesystem" && goal.result_kind === "collection");
    const derived = plan.source_goals.filter((goal) => ["count", "filtered_count", "judgement"].includes(goal.result_kind));

    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ entity: "/var/lib/mc/reports/daily", required: true });
    expect(derived.every((goal) => goal.depends_on.includes(collections[0].id) || goal.depends_on.some((id) => plan.source_goals.find((candidate) => candidate.id === id)?.depends_on.includes(collections[0].id)))).toBe(true);
    expect(plan.goal_requirements.filter((goal) => goal.result_kind === "collection")).toHaveLength(1);
    expect(plan.steps.filter((step) => step.tool === "files.list" && step.args.path === "/var/lib/mc/reports/daily")).toHaveLength(1);
  });

  it("rejects a step with no source-goal or supporting trace", () => {
    const plan = draftPlan("instance", "revision", "Report the exact server implementation build and online roster.");
    plan.steps.push({ id: "s-extra", tool: "logs.query", args: { window_minutes: 5 }, risk: "read" });
    plan.operation.digest = computeOperationDigest(plan.steps);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: false, code: "UNBOUND_STEP" });
  });

  it("accepts read observations without inventing verification steps", () => {
    const plan = draftPlan("instance", "revision", "读取精确服务端构建，随后显示当前在线成员，并列出 '/data/readonly/snapshots' 下的条目。" );
    expect(plan.steps.every((step) => step.purpose !== "verify")).toBe(true);
    expect(plan.steps.map((step) => step.tool)).toEqual(["console.command", "console.command", "files.list"]);
    expect(plan.constraints).toEqual([]);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("adds only compatible second observations when an independent recheck is explicit", () => {
    const plan = draftPlan("instance", "revision", "Report the server implementation build and online roster, then independently recheck both readings.");
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.map((step) => step.purpose ?? "execute")).toEqual(["execute", "verify", "execute", "verify"]);
    expect(plan.steps[0].args).toEqual(plan.steps[1].args);
    expect(plan.steps[2].args).toEqual(plan.steps[3].args);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("rejects duplicated canonical collections before accepting a recomputed digest", () => {
    const plan = draftPlan("instance", "revision", "List '/mnt/world/cache-index' entries and count .idx files.");
    const collection = plan.source_goals.find((goal) => goal.result_kind === "collection")!;
    plan.source_goals.push({ ...collection, id: `${collection.id}-copy` });
    plan.source_goal_digest = computeSourceGoalDigest(plan);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: false, code: "DUPLICATE_COLLECTION" });
  });

  it("rejects two judgements that reuse one source span", () => {
    const plan = draftPlan("instance", "revision", "List '/mnt/world/cache-index' entries; determine whether all names end in .idx; determine whether any name ends in .bak2.");
    const judgements = plan.source_goals.filter((goal) => goal.result_kind === "judgement");
    judgements[1].source_start = judgements[0].source_start;
    judgements[1].source_end = judgements[0].source_end;
    judgements[1].source_text = judgements[0].source_text;
    plan.source_goal_digest = computeSourceGoalDigest(plan);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: false, code: "MERGED_JUDGEMENT" });
  });
});
