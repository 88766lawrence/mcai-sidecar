import { describe, expect, it } from "vitest";
import { draftPlan } from "./planner";

const create = (intent: string, preferredTool?: string) =>
  draftPlan("mcs:daemon:instance", "rev-1", intent, { preferredTool });

describe("planner safety regressions", () => {
  it.each(["Read logs, do not stop the server", "Read logs, don't shut down the server", "读取日志，不要重启服务器"])("does not execute a negated lifecycle request: %s", (intent) => {
    expect(create(intent).steps.every(step => step.risk === "read")).toBe(true);
  });
  it.each(["查看配置", "查看视距当前是多少", "读取 server.properties，不要修改配置"])("does not invent configuration writes: %s", (intent) => {
    expect(create(intent).steps[0].tool).toBe("config.inspect");
  });
  it("keeps explicit view-distance changes working", () => {
    expect(create("把视距改为 8").steps[0]).toMatchObject({ tool: "config.patch", args: { patch: [{ op: "replace", key: "view-distance", value: 8 }] } });
  });
  it("never substitutes a server installation for plugin installation with version context", () => {
    expect(create("在 Paper 1.21.1 上安装 ProtocolLib 插件，不要重启", "plugin.install").steps.map(step => step.tool)).toEqual(["plugin.resolve", "plugin.install"]);
  });
  it("keeps log requests read-only even with installation keywords", () => {
    expect(create("检查安装 Paper 1.21.1 失败的日志", "logs.query").steps[0].tool).toBe("logs.query");
  });
  it("recognizes an unhinted English plugin install with server context", () => {
    expect(create("Install ProtocolLib on Paper 1.21.1, do not restart").steps.map(step => step.tool))
      .toEqual(["plugin.resolve", "plugin.install"]);
  });
  it.each(["I do not accept Minecraft EULA; install Paper 1.21.1", "我不同意 Minecraft EULA，安装 Paper 1.21.1"])("does not fabricate EULA consent: %s", intent => {
    expect(create(intent).steps[0].args.accept_eula).toBe(false);
  });
  it("does not treat negative installation text as installation consent", () => {
    expect(create("不要安装 Paper 1.21.1，读取日志").steps[0].tool).toBe("logs.query");
  });
  it("honors a negated plugin installation even when a model prefers installing", () => {
    expect(create("不要安装 ProtocolLib 插件", "plugin.install").steps.map(step => step.tool)).toEqual(["plugin.resolve"]);
  });
});
