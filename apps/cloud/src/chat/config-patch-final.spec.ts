import { describe, expect, it } from "vitest";
import type { AgentLoopObservation } from "./agent-loop";
import { renderConcreteAgentFailure, renderOfficialPaperPluginGuidance, renderPerformanceFinal, renderReadThenPatchFinal } from "./chat.service";

const read: AgentLoopObservation = {
  tool_call_id: "read", tool: "config.inspect", status: "succeeded", retryable: false,
  side_effect: "none", evidence: { ids: [], summaries: ["motd=A Minecraft Server"] },
  data: { qa0144_read_result: { output_schema_id: "config-inspect-result/v1",
    value: { path: "server.properties", entries: [{ key: "motd", present: true, value: "A Minecraft Server" }] } } },
};
const patch: AgentLoopObservation = {
  tool_call_id: "patch", tool: "config.patch", status: "succeeded", retryable: false,
  side_effect: "applied", evidence: { ids: [], summaries: ["Patched /server.properties and verified sha256:71103284c7ab4e7f"] },
  data: { call_arguments: { path: "server.properties", patch: [{ op: "replace", key: "motd", value: "周末生存服" }] } },
};

describe("verified read then patch final", () => {
  it("reports the original and new value from successful tool evidence", () => {
    expect(renderReadThenPatchFinal("先看看 motd 现在写的什么，再改成 周末生存服。", [read, patch]))
      .toBe("已读取 server.properties：motd 原值为「A Minecraft Server」。已将文件中的 motd 改为「周末生存服」，写入后校验成功。");
  });

  it("does not claim success when the write failed or lacked verification", () => {
    expect(renderReadThenPatchFinal("先看看 motd，再改成 周末生存服", [read, { ...patch, status: "failed" }]))
      .toBeUndefined();
    expect(renderReadThenPatchFinal("先看看 motd，再改成 周末生存服", [read, { ...patch, evidence: { ids: [], summaries: [] } }]))
      .toBeUndefined();
  });

  it("does not mix original values from different configuration paths", () => {
    const other = { ...patch, data: { call_arguments: { path: "other.properties", patch: [{ op: "replace", key: "motd", value: "x" }] } } };
    expect(renderReadThenPatchFinal("先看看 motd，再改成 x", [read, other])).toBe(
      "已将文件中的 motd 改为「x」，写入后校验成功。",
    );
  });

  it("reports the new config value and completed restart", () => {
    const maxRead = { ...read, data: { qa0144_read_result: { output_schema_id: "config-inspect-result/v1",
      value: { path: "server.properties", entries: [{ key: "max-players", present: true, value: "20" }] } } } };
    const maxPatch = { ...patch, data: { call_arguments: { path: "server.properties",
      patch: [{ op: "replace", key: "max-players", value: "30" }] } } };
    const restart = { ...patch, tool: "instance.restart" as const, side_effect: "applied" as const };
    expect(renderReadThenPatchFinal("把 max-players 改成 30", [maxRead, maxPatch, restart])).toBe(
      "已读取 server.properties：max-players 原值为「20」。已将文件中的 max-players 改为「30」，写入后校验成功。实例重启已完成。",
    );
  });
});

describe("partial tool failure final", () => {
  it("keeps a completed installation visible when later plugin resolution fails", () => {
    const installed: AgentLoopObservation = { ...patch, tool: "plugin.install",
      data: { call_arguments: { project: "luckperms" } } };
    const failed: AgentLoopObservation = { ...read, tool: "plugin.resolve", status: "failed",
      data: { call_arguments: { project: "essentialsx" } },
      evidence: { ids: [], summaries: ["official GitHub API returned HTTP 403"] } };
    const answer = renderConcreteAgentFailure("安装 LuckPerms 和 EssentialsX", [installed, failed]);
    expect(answer).toContain("部分完成：已安装 luckperms。essentialsx 未完成。");
    expect(answer).toContain("HTTP 403");
    expect(answer).not.toContain("本次失败未产生修改");
  });
});

describe("performance evidence final", () => {
  it("uses binary units and computes memory usage from observed bytes", () => {
    const tps: AgentLoopObservation = { ...read, tool: "console.command",
      data: { call_arguments: { command: "tps" } },
      evidence: { ids: [], summaries: ["TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"] } };
    const metrics: AgentLoopObservation = { ...read, tool: "instance.metrics",
      evidence: { ids: [], summaries: ["Instance metrics v2: uptime_seconds=707; cpu_percent=0.00; memory_bytes=1415213056; memory_limit_bytes=2147483648"] } };
    expect(renderPerformanceFinal("看 TPS、CPU 和内存", [tps, metrics])).toBe(
      "TPS（1/5/15 分钟）：20.0 / 20.0 / 20.0；CPU：0.00%；内存：1.32 / 2.00 GiB（65.9%）。",
    );
  });
});

describe("Paper plugin source guidance", () => {
  it("limits advice to vetted official guides present in search results", () => {
    const search: AgentLoopObservation = { ...read, tool: "web.search", data: {
      qa0144_read_result: { output_schema_id: "web-search-result/v1", value: { results: [
        { url: "https://docs.papermc.io/paper/adding-plugins/" },
        { url: "https://docs.papermc.io/paper/updating/" },
      ] } },
    } };
    const answer = renderOfficialPaperPluginGuidance("查一下网上 Paper 1.21.1 的插件兼容建议", [search]);
    expect(answer).toContain("Paper 1.21.1");
    expect(answer).toContain("Hangar");
    expect(answer).toContain("更新前备份");
    expect(answer).not.toContain("必须重新编译");
    expect(renderOfficialPaperPluginGuidance("查一下网上 Paper 1.21.1 的插件兼容建议", [
      { ...search, data: { qa0144_read_result: { output_schema_id: "web-search-result/v1", value: { results: [
        { url: "https://docs.papermc.io/paper/updating/" },
      ] } } } },
    ])).toBeUndefined();
  });
});
