import { describe, expect, it } from "vitest";
import type { GoalRequirement, TaskRecord } from "@mcai/contracts";
import { draftPlan, extractPluginResolveIntent } from "./planner";
import { extractReadGoals } from "./goal-requirements";
import { adaptGoalResult } from "./result-adapters";
import { validatePlanCompatibility } from "./plan-compatibility";
import { renderTypedReadCompletion } from "./typed-read-completion";

describe("plugin metadata read resolution", () => {
  it.each([
    ["Without fetching or deploying anything, verify whether BlueMap supports Fabric 1.20.6 and report its authoritative source plus checksum details.", "bluemap", "fabric", "1.20.6"],
    ["禁止下载和安装；只查询 ViaBackwards 对 Purpur 1.20.4 的兼容性、可信发布来源与哈希。", "viabackwards", "purpur", "1.20.4"],
    ["核对 Geyser 是否支持 Paper 1.21.2，给出版本、签名或校验信息；不要部署。", "geyser", "paper", "1.21.2"],
    ["Do not install HarborBridge. Resolve its compatibility with Spigot 1.19.4 and provide provenance and integrity metadata only.", "harborbridge", "spigot", "1.19.4"],
  ])("extracts a bounded read request without promoting negative writes: %s", (intent, project, platform, version) => {
    expect(extractPluginResolveIntent(intent)).toEqual({ project, platform, minecraftVersion: version, loader: platform });
    const plan = draftPlan("mcs:daemon:instance", "revision-plugin", intent, {
      preferredTool: "plugin.resolve", platform, minecraftVersion: version, loader: platform,
    });
    expect(plan.steps).toEqual([expect.objectContaining({
      tool: "plugin.resolve", risk: "read",
      args: expect.objectContaining({ project, platform, minecraft_version: version, loader: platform }),
    })]);
    expect(plan.steps[0].requires_confirmation).not.toBe(true);
    expect(plan.steps.some((step) => ["plugin.install", "server.install", "console.command", "files.list", "logs.query", "instance.start", "instance.stop", "instance.restart"].includes(step.tool))).toBe(false);
    const forbidden = plan.constraints.map((item) => item.action);
    expect(forbidden).toContain("install");
    if (/fetch|download|下载/i.test(intent)) expect(forbidden).toContain("download");
    expect(plan.operation).toMatchObject({ capability: "plugin.resolve", action: "read", risk: "read", requires_confirmation: false });
    expect(plan.coverage).toBe("full");
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it.each([
    ["只核验资料：判断 Sodium Extra 能否用于 Fabric 1.21，并给出可信来源；不要下载。", "sodium-extra"],
    ["Metadata only: verify Better Nether compatibility with Fabric 1.20.4 and report provenance without installing it.", "better-nether"],
  ])("preserves a bounded multi-word plugin identity: %s", (intent, project) => {
    expect(extractPluginResolveIntent(intent)).toMatchObject({ project, platform: "fabric" });
    const plan = draftPlan("mcs:daemon:instance", "revision-plugin-multiword", intent, { preferredTool: "plugin.resolve" });
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "plugin.resolve", args: expect.objectContaining({ project }) })]);
  });

  it("requires compatibility, provenance, version, and integrity fields from the same callback", () => {
    const goal: GoalRequirement = {
      id: "g-plugin", description: "Resolve plugin metadata", domain: "plugin", action: "read", target: "harborbridge",
      required: true, source_goal_ids: ["sg-plugin"], result_kind: "fact", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    };
    const evidence = (summary: string) => [{
      kind: "plugin", step_id: "s1", tool: "plugin.resolve", summary, at: new Date(0).toISOString(), result: "match" as const,
    }] as TaskRecord["evidence"];
    const complete = "Plugin resolve result: project=harborbridge; version=3.4.1; source=modrinth; artifact=HarborBridge-3.4.1.jar; compatibility=paper 1.21.2; sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; source_sha512=abcdef";
    expect(adaptGoalResult(goal, evidence(complete))).toMatchObject({
      available: true,
      observed: expect.objectContaining({ project: "harborbridge", version: "3.4.1", source: "modrinth", compatibility: "paper 1.21.2" }),
    });
    expect(adaptGoalResult(goal, evidence(complete.replace(/; sha256=[^;]+/, "")))).toMatchObject({ available: false, reason: "missing_fact" });
    expect(adaptGoalResult(goal, evidence("Plugin harborbridge resolved successfully"))).toMatchObject({ available: false, reason: "missing_fact" });
    const metadataOnly = `Plugin resolve result: project=harborbridge; version=3.4.1; source=modrinth; artifact=HarborBridge-3.4.1.jar; compatibility=paper 1.21.2; sha256=; source_sha512=${"ab".repeat(64)}`;
    expect(adaptGoalResult(goal, evidence(metadataOnly))).toMatchObject({
      available: true,
      observed: expect.objectContaining({ source_sha512: "ab".repeat(64) }),
    });
  });

  it("accepts an auditable no-compatible-artifact fact without inventing a version or checksum", () => {
    const goal: GoalRequirement = {
      id: "g-plugin-absence", description: "Resolve plugin metadata", domain: "plugin", action: "read", target: "sodium-extra",
      required: true, source_goal_ids: ["sg-plugin"], result_kind: "fact", execute_step_ids: ["s1"], verify_step_ids: [], evidence: [], status: "pending",
    };
    const summary = "Plugin resolve result: project=sodium-extra; resolution=no-compatible-artifact; compatibility=incompatible; checked_source=modrinth; requested_loader=paper; requested_minecraft_version=1.21.1";
    const result = adaptGoalResult(goal, [{ kind: "plugin", step_id: "s1", tool: "plugin.resolve", summary, at: new Date(0).toISOString(), result: "match" }] as TaskRecord["evidence"]);
    expect(result).toMatchObject({ available: true, observed: { project: "sodium-extra", resolution: "no-compatible-artifact", compatibility: "incompatible" } });
    const answer = renderTypedReadCompletion({
      intent: "只核验 Sodium Extra 对 Paper 1.21.1 的兼容资料，不下载或安装。", state: "SUCCEEDED", action: "read",
      goals: [{ id: "g-plugin-absence", domain: "plugin", target: "sodium-extra", resultKind: "fact", required: true }],
      results: [{ goalId: "g-plugin-absence", status: "satisfied", observed: result.observed }],
    });
    expect(answer).toContain("未找到适用于 paper 1.21.1 的兼容制品");
    expect(answer).toContain("没有可提供的制品版本或校验值");
  });

  it("routes the published read-only reproduction to one metadata lookup", () => {
    const intent = "QA0060-A7验收：只查资料别下载也别安装，核对Chunky是否兼容Paper 1.21.1，并给出可信来源和校验信息。";
    const extracted = extractPluginResolveIntent(intent);
    expect(extracted).toEqual({ project: "chunky", platform: "paper", minecraftVersion: "1.21.1", loader: "paper" });
    const plan = draftPlan("mcs:daemon:instance", "revision-plugin", intent, {
      preferredTool: "plugin.resolve", platform: "paper", minecraftVersion: "1.21.1", loader: "paper",
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "plugin.resolve", risk: "read" });
    expect(plan.steps[0].requires_confirmation).not.toBe(true);
    expect(plan.steps[0].args).toMatchObject({ project: "chunky" });
    expect(plan.operation).toMatchObject({ capability: "plugin.resolve", action: "read", risk: "read", requires_confirmation: false });
    expect(plan.constraints.map((item) => item.action)).toEqual(expect.arrayContaining(["download", "install"]));
    expect(plan.goal_requirements.filter((goal) => goal.required && goal.domain === "plugin")).toHaveLength(1);
  });

  it.each([
    ["只核验资料：检查 Dynmap 对 Paper 1.20.6 的支持情况、发布来源和哈希；不要下载或部署。", "dynmap"],
    ["禁止安装或拉取。请复核 LuckPerms 是否支持 Purpur 1.21，并报告制品与完整性信息。", "luckperms"],
    ["Metadata only: review BlueMap compatibility for Fabric 1.20.4, its trusted source, artifact, and checksum; never fetch or install it.", "bluemap"],
    ["Do not deploy HarborLink; verify its Spigot 1.19.3 release provenance and integrity metadata only.", "harborlink"],
  ])("keeps one semantic plugin fact when read boundaries are before or after the business goal: %s", (intent, project) => {
    const plan = draftPlan("mcs:daemon:instance", "revision-plugin-dedup", intent, { preferredTool: "plugin.resolve" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ tool: "plugin.resolve", risk: "read" });
    expect(plan.steps[0].requires_confirmation).not.toBe(true);
    expect(plan.steps[0].args).toMatchObject({ project });
    expect(extractReadGoals(intent, { pluginProject: project }).filter((goal) => goal.tool === "plugin.resolve").map((goal) => goal.args.project)).toEqual([project]);
    const goals = plan.goal_requirements.filter((goal) => goal.required && goal.domain === "plugin");
    expect(goals.map((goal) => ({ target: goal.target, kind: goal.result_kind, steps: goal.execute_step_ids, sources: goal.source_goal_ids }))).toEqual([
      expect.objectContaining({ target: project, kind: "fact" }),
    ]);
    expect(goals[0].target).toBe(project);
    expect(new Set(goals[0].source_goal_ids).size).toBe(goals[0].source_goal_ids.length);
    expect(plan.clause_ledger.filter((clause) => clause.role === "safety_constraint").every((clause) => clause.source_goal_ids.length === 0)).toBe(true);
    expect(validatePlanCompatibility(plan)).toMatchObject({ ok: true });
  });

  it("merges duplicate plugin facts into one natural Chinese answer and explains compatibility enums", () => {
    const observed = {
      project: "worldguard", version: "7.1.0", source: "modrinth", artifact: "WorldGuard-7.1.0.jar",
      compatibility: "exact-game-version", source_sha512: "ab".repeat(64),
    };
    const answer = renderTypedReadCompletion({
      intent: "只核验资料，确认 WorldGuard 对 Paper 1.21.2 的兼容性、可信来源和制品校验值，禁止下载或安装。",
      state: "SUCCEEDED",
      action: "read",
      goals: [
        { id: "g-one", domain: "plugin", target: "worldguard", resultKind: "fact", required: true },
        { id: "g-two", domain: "plugin", target: "worldguard", resultKind: "fact", required: true },
      ],
      results: [
        { goalId: "g-one", status: "satisfied", observed },
        { goalId: "g-two", status: "satisfied", observed: { ...observed } },
      ],
    });
    expect(answer).toContain("WorldGuard");
    expect(answer).toContain("与请求的游戏版本精确匹配");
    expect(answer).toContain("来源 SHA-512");
    expect(answer?.match(/可信来源/g)).toHaveLength(1);
    expect(answer).not.toContain("exact-game-version");
    expect(answer).not.toMatch(/goal|schema|provider|digest|adapter|verification/i);
  });

  it("renders English plugin metadata once and fails closed on conflicting duplicate facts", () => {
    const base = {
      project: "harborlink", version: "2.8.0", source: "hangar", artifact: "HarborLink-2.8.0.jar",
      compatibility: "platform-compatible", sha256: "01".repeat(32),
    };
    const context = {
      intent: "Review HarborLink metadata for Paper 1.21.1 without downloading or installing it.",
      state: "SUCCEEDED",
      action: "read",
      goals: [
        { id: "g-a", domain: "plugin", target: "harborlink", resultKind: "fact", required: true },
        { id: "g-b", domain: "plugin", target: "harborlink", resultKind: "fact", required: true },
      ],
    } as const;
    const answer = renderTypedReadCompletion({ ...context, results: [
      { goalId: "g-a", status: "satisfied", observed: base },
      { goalId: "g-b", status: "satisfied", observed: { ...base } },
    ] });
    expect(answer).toContain("Compatible with the requested platform");
    expect(answer?.match(/trusted source/gi)).toHaveLength(1);
    expect(answer).not.toContain("platform-compatible");
    expect(renderTypedReadCompletion({ ...context, results: [
      { goalId: "g-a", status: "satisfied", observed: base },
      { goalId: "g-b", status: "satisfied", observed: { ...base, version: "2.8.1" } },
    ] })).toBeUndefined();
  });

  it.each([
    "Read the server version, loaded plugins, and recent crash evidence",
    "复核 paper-global.yml 中的 settings.velocity-support 当前值",
    "Review recent logs for release errors and checksum warnings",
  ])("does not promote an adjacent non-plugin read into plugin resolution: %s", (intent) => {
    expect(extractPluginResolveIntent(intent)).toBeUndefined();
  });
});
