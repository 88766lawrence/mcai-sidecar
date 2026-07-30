import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";

describe("draftPlan", () => {
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
      risk: "low",
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
});
