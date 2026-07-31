import { describe, expect, it } from "vitest";
import { draftPlan, extractRealtimeLogIntent } from "./planner";

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

  it("requires confirmation before stopping an instance", () => {
    const plan = draftPlan("mcs:daemon:instance", "revision-1", "Stop the server");

    expect(plan.steps).toEqual([{
      id: "s1",
      tool: "instance.stop",
      args: { timeout_seconds: 120 },
      risk: "high",
      requires_confirmation: true,
    }]);
    expect(plan.acceptance).toEqual([{ type: "instance_state", expected: "stopped" }]);
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
});
