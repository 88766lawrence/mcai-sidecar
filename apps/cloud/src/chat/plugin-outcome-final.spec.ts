import { describe, expect, it } from "vitest";
import type { AgentLoopObservation } from "./agent-loop";
import { renderPluginOutcomeFinal } from "./plugin-outcome-final";

function observation(tool: AgentLoopObservation["tool"], project: string, fact: Record<string, unknown>, status: AgentLoopObservation["status"] = "succeeded"): AgentLoopObservation {
  return { tool_call_id: `${tool}-${project}`, tool, status, side_effect: tool === "plugin.install" ? "applied" : "none", retryable: false,
    data: { call_arguments: { project }, observations: [{ observed: fact }] }, evidence: { ids: [], summaries: [] } };
}
const existing = (project: string) => observation("plugin.install", project, { schema_version: "plugin-install-result/v1",
  already_present: true, sha256: "a".repeat(64), installed_path: `plugins/${project}.jar` });
const blocked = (project: string, resolution = "no-compatible-artifact") => observation("plugin.resolve", project,
  { schema_version: "resolved-plugin/v1", resolution, checked_sources: ["Modrinth", "Hangar"], requested_minecraft_version: "1.21.1" });

describe("typed plugin outcome fallback", () => {
  it("explains a partial multi-plugin result even when model synthesis is unavailable", () => {
    const result = renderPluginOutcomeFinal("安装 Alpha 和 Beta", [existing("alpha"), blocked("beta")]);
    expect(result?.blocked).toBe(true);
    expect(result?.answer).toContain("无需重复安装或重启");
    expect(result?.answer).toContain("beta：未安装");
    expect(result?.answer).toContain("Modrinth, Hangar");
    expect(result?.answer).toContain("1.21.1");
  });
  it("distinguishes incomplete history from absent compatible releases", () => {
    const result = renderPluginOutcomeFinal("安装 Beta", [blocked("beta", "search-incomplete")]);
    expect(result?.answer).toContain("查询不完整");
    expect(result?.answer).not.toContain("未找到适用于");
  });
  it("retains failed lookup facts rather than announcing incompatibility", () => {
    const failure = blocked("beta", "query-failed"); failure.status = "failed";
    expect(renderPluginOutcomeFinal("安装 Beta", [failure])?.answer).toContain("来源查询或制品校验失败");
  });
  it("does not render an installation summary for a read-only request", () => {
    expect(renderPluginOutcomeFinal("只查看 Beta，不要安装", [blocked("beta")])).toBeUndefined();
  });
  it("renders both same-artifact results without claiming new installation", () => {
    const result = renderPluginOutcomeFinal("Install Alpha and Beta", [existing("alpha"), existing("beta")]);
    expect(result?.blocked).toBe(false);
    expect(result?.answer.match(/no repeat installation/g)).toHaveLength(2);
  });
  it("requires both fresh file and loaded inventory before reporting verification", () => {
    const installed = observation("plugin.install", "alpha", { schema_version: "plugin-install-result/v1", artifact: "alpha.jar", plugin_name: "Alpha", already_present: false });
    const lifecycle = observation("instance.restart", "alpha", {});
    const files = observation("files.list", "alpha", { schema_version: "files-list-result/v1", path: "plugins", truncated: false, entries: [{ name: "alpha.jar" }] });
    const inventory = observation("console.command", "alpha", { schema_version: "loaded-plugins-result/v1", total: 1, names: ["Alpha"] });
    const facts = [installed, lifecycle, files, inventory, blocked("beta")];
    expect(renderPluginOutcomeFinal("安装 Alpha 和 Beta", facts)?.answer).toContain("实际加载列表核验通过");
    inventory.data = { observations: [{ observed: { schema_version: "loaded-plugins-result/v1", total: 1, names: ["Other"] } }] };
    expect(renderPluginOutcomeFinal("安装 Alpha 和 Beta", facts)?.answer).toContain("尚未确认");
    expect(renderPluginOutcomeFinal("安装 Alpha 和 Beta", [files, inventory, installed, lifecycle, blocked("beta")])?.answer).toContain("尚未确认");
  });
});

it("renders version and download source from metadata without dependency approval", async () => {
 const { renderPluginLookupFinal } = await import("./plugin-outcome-final");
 const result=renderPluginLookupFinal("查适配版本和来源，不要安装", [{tool:"plugin.resolve",status:"succeeded",data:{observations:[{observed:{schema_version:"resolved-plugin/v1",resolution:"resolved",project:"example",version:"7.0",requested_loader:"paper",requested_minecraft_version:"1.21.1",source_url:"https://cdn.modrinth.com/example.jar",required_dependencies:["dependency"]}}]}}] as any);
 expect(result).toContain("example 7.0"); expect(result).toContain("https://cdn.modrinth.com/example.jar"); expect(result).toContain("未安装");
});
