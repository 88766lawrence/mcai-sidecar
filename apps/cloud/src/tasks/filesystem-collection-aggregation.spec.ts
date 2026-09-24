import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";
import { validatePlanCompatibility } from "./plan-compatibility";

describe("filesystem collection aggregation", () => {
  it.each([
    ["列出saves/alpha/player目录内所有dat存档文件的完整名称，并统计匹配数量", "/saves/alpha/player", ".dat"],
    ["Count every CFG configuration file below profiles/nightly/settings and return all matching names.", "/profiles/nightly/settings", ".cfg"],
    ["在assets/textures/custom文件夹中，把.png图片文件逐个列出并告诉我总数", "/assets/textures/custom", ".png"],
    ["In backups/world/daily, list every NBT snapshot file and report the matching count.", "/backups/world/daily", ".nbt"],
  ])("keeps a bare extension before a descriptive file-kind noun: %s", (intent, path, suffix) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-file-kind", intent, { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path }, risk: "read" })]);
    expect(plan.source_goals.filter((goal) => goal.required && goal.domain === "filesystem" && goal.entity === path)).toEqual(expect.arrayContaining([
      expect.objectContaining({ result_kind: "collection", filter: { field: "name", operator: "suffix", value: suffix } }),
      expect.objectContaining({ result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: suffix } }),
    ]));
    expect(plan.source_goals.filter((goal) => goal.required && goal.domain === "filesystem" && goal.entity === path)).toHaveLength(2);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("keeps the public B8 cross-layer fixture auditable without production special-casing", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-public-b8", "看看world/region目录目前有多少个mca区域文件，并列出对应文件名。", { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/world/region" }, risk: "read" })]);
    expect(plan.source_goals.filter((goal) => goal.required && goal.domain === "filesystem" && goal.entity === "/world/region")).toEqual(expect.arrayContaining([
      expect.objectContaining({ result_kind: "collection", filter: { field: "name", operator: "suffix", value: ".mca" } }),
      expect.objectContaining({ result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".mca" } }),
    ]));
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["统计world/advancements目录现有多少个json文件，并完整列出文件名", "/world/advancements", ".json"],
    ["List YML filenames under config/presets and report the matching count.", "/config/presets", ".yml"],
    ["把data/packs/archive文件夹中的.mcmeta文件名称全部给出，再说数量", "/data/packs/archive", ".mcmeta"],
    ["在regions/backups/daily directory中数一数NBT files，同时返回完整名单", "/regions/backups/daily", ".nbt"],
    ["统计/world/stats内扩展名为.json的条目并列出全部匹配名称。", "/world/stats", ".json"],
  ])("preserves a safe nested instance path and binds names plus filtered count: %s", (intent, path, suffix) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-nested", intent, { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path }, risk: "read" })]);
    const filesystemGoals = plan.source_goals.filter((goal) => goal.required && goal.domain === "filesystem" && goal.entity === path);
    expect(filesystemGoals).toEqual(expect.arrayContaining([
      expect.objectContaining({ result_kind: "collection", filter: { field: "name", operator: "suffix", value: suffix } }),
      expect.objectContaining({ result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: suffix } }),
    ]));
    expect(filesystemGoals).toHaveLength(2);
    expect(plan.goal_requirements.filter((goal) => goal.required)).toHaveLength(2);
    expect(plan.goal_requirements.filter((goal) => goal.required).every((goal) => goal.status === "pending" && goal.execute_step_ids.length === 1)).toBe(true);
    expect(plan.clause_ledger.filter((clause) => clause.source_goal_ids.length > 0).every((clause) => clause.role === "domain_goal" && clause.polarity === "positive" && clause.source_atom_ids.length > 0)).toBe(true);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
    expect(plan.steps.some((step) => ["plugin.resolve", "logs.query", "console.command", "config.inspect", "instance.start", "instance.stop", "instance.restart"].includes(step.tool))).toBe(false);
  });

  it("keeps the public cross-layer fixture auditable without production special-casing", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-public", "数一数world/datapacks目录里现有多少个zip包，并把文件名完整列出来。", { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/world/datapacks" }, risk: "read" })]);
    expect(plan.source_goals.filter((goal) => goal.required && goal.domain === "filesystem" && goal.entity === "/world/datapacks").map((goal) => goal.result_kind).sort()).toEqual(["collection", "filtered_count"]);
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    "列出 ../secrets 目录里的json文件名和数量",
    "Count yml files in world/../private directory and list their names",
    "统计world//broken目录的zip文件数量并列名",
    "List cfg filenames and count under C:/server/config directory",
    "列出\\\\host\\share目录的dat文件名和数量",
  ])("rejects traversal, empty segments, drive paths, and external paths: %s", (intent) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-danger", intent, { preferredTool: "files.list" });
    expect(plan.steps.some((step) => step.tool === "files.list")).toBe(false);
    expect(plan.coverage).not.toBe("full");
  });

  it.each([
    ["列出 /mods 目录中的 .toml 文件名，并告诉我一共有多少个", "/mods", ".toml"],
    ["How many .json files are under /config? Return their names.", "/config", ".json"],
    ["先给出 /exports 里所有 .zip 文件名，再统计数量", "/exports", ".zip"],
  ])("reuses one directory observation for names and a filtered count: %s", (intent, path, suffix) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", intent, { preferredTool: "files.list" });

    expect(plan.steps).toEqual([
      expect.objectContaining({ tool: "files.list", args: { path }, risk: "read" }),
    ]);
    expect(plan.source_goals.filter((goal) => goal.domain === "filesystem" && goal.entity === path && goal.result_kind === "collection")).toHaveLength(1);
    expect(plan.source_goals.find((goal) => goal.domain === "filesystem" && goal.entity === path && goal.result_kind === "collection")?.filter)
      .toEqual({ field: "name", operator: "suffix", value: suffix });
    expect(plan.source_goals.filter((goal) => goal.domain === "filesystem" && goal.entity === path && goal.result_kind === "filtered_count")).toEqual([
      expect.objectContaining({ filter: { field: "name", operator: "suffix", value: suffix } }),
    ]);
    expect(plan.goal_requirements.filter((goal) => goal.required).every((goal) => goal.status === "pending")).toBe(true);
    expect(new Set(plan.goal_requirements.filter((goal) => goal.required).flatMap((goal) => goal.execute_step_ids))).toEqual(new Set(["s1"]));
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("does not manufacture unrelated tools or a parent-directory read", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Count the .dat files in /world/playerdata and list their names.", { preferredTool: "files.list" });
    expect(plan.steps).toEqual([
      expect.objectContaining({ tool: "files.list", args: { path: "/world/playerdata" } }),
    ]);
    expect(plan.steps.some((step) => ["logs.query", "plugin.resolve", "console.command"].includes(step.tool))).toBe(false);
  });

  it("treats a named directory and an extension without a leading dot as ordinary filesystem semantics", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "统计addons目录中的cfg文件数量，并列出文件名", { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/addons" } })]);
    expect(plan.source_goals.map((goal) => [goal.domain, goal.entity, goal.result_kind])).toEqual(expect.arrayContaining([
      ["filesystem", "/addons", "collection"],
      ["filesystem", "/addons", "filtered_count"],
    ]));
    expect(plan.source_goals.find((goal) => goal.result_kind === "filtered_count")?.filter?.value).toBe(".cfg");
    expect(plan.coverage).toBe("full");
  });

  it("recognizes an English directory phrase with an article and reuses it for count plus names", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Inside the config directory, count every TOML file and list each matching filename.", { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/config" }, risk: "read" })]);
    expect(plan.source_goals).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "filesystem", entity: "/config", result_kind: "collection", filter: { field: "name", operator: "suffix", value: ".toml" } }),
      expect.objectContaining({ domain: "filesystem", entity: "/config", result_kind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".toml" } }),
    ]));
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("keeps plugin storage on the generic filesystem route", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "数数plugins目录里有多少个jar文件，并把文件名列给我", { preferredTool: "files.list" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "files.list", args: { path: "/plugins" } })]);
    expect(plan.source_goals.find((goal) => goal.result_kind === "filtered_count")).toMatchObject({
      domain: "filesystem", entity: "/plugins", filter: { field: "name", operator: "suffix", value: ".jar" },
    });
    expect(plan.goal_requirements.filter((goal) => goal.required).every((goal) => goal.status === "pending")).toBe(true);
    expect(plan.coverage).toBe("full");
  });
});
