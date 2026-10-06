import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentLoopObservation } from "../chat/agent-loop";
import { publicSourceSearchCompletion, renderWebSourceFinal, validatedWebSourcePage, projectQa0144ReadResult, renderQa0144ReadFinal } from "./qa0144-read-observation";

const seal = (value: Record<string, unknown>) => ({
  ...value,
  result_digest: createHash("sha256").update("read-tool-result/v1\0").update(JSON.stringify(value)).digest("hex"),
});

function observed(tool: AgentLoopObservation["tool"], outputSchemaId: string, value: Record<string, unknown>, id: string): AgentLoopObservation {
  return {
    tool_call_id: id, tool, status: "succeeded", retryable: false, side_effect: "none",
    data: { qa0144_read_result: { schema_version: "qa0144-read-result/v1", output_schema_id: outputSchemaId, value } },
    evidence: { ids: [id], summaries: ["typed"] },
  };
}

describe("QA0144 typed read observations", () => {
  it("accepts an exact sealed file listing and preserves total versus filtered count", () => {
    const value = seal({
      entries: [{ name: "A.jar" }, { name: "B.JAR" }, { name: "C.jar" }, { name: "D.jar" }],
      filtered_count: 4, path: "plugins", schema_version: "files-list-result/v1", suffix: ".jar", total: 10, truncated: false,
    });
    const projected = projectQa0144ReadResult({ tool: "files.list", arguments: { path: "/plugins", suffix: ".jar" }, observedValues: [value] });
    expect(projected?.value).toMatchObject({ total: 10, filtered_count: 4 });
    expect(renderQa0144ReadFinal("只读列出插件目录中的 jar", [observed("files.list", "files-list-result/v1", value, "files")])).toContain("按 .jar 筛选后有 4 项");
  });

  it("renders exact log totals, shown samples and omitted count without a model rewrite", () => {
    const value = {
      matches: 68, query_digest: "d".repeat(64), samples: ["timeout alpha", "timeout beta"],
      scanned_lines: 120, schema_version: "logs-query-result/v1", window_minutes: 45,
    };
    const projected = projectQa0144ReadResult({
      tool: "logs.query",
      arguments: { window_minutes: 45, filter_query: { digest: "d".repeat(64) } },
      observedValues: [value],
    });
    expect(projected).toBeDefined();
    const answer = renderQa0144ReadFinal("统计日志并展示样本", [observed("logs.query", "logs-query-result/v1", value, "logs")]);
    expect(answer).toContain("日志匹配 68 条；展示 2 条样本；剩余 66 条未展示");
  });

  it("combines config, files and logs from three distinct completed calls", () => {
    const config = seal({ entries: [{ key: "max-players", present: true, value: "20" }], path: "server.properties", schema_version: "config-inspect-result/v1" });
    const files = seal({ entries: [{ name: "Core.jar" }], filtered_count: 1, path: "plugins", schema_version: "files-list-result/v1", suffix: ".jar", total: 3, truncated: false });
    const logs = { matches: 0, query_digest: "e".repeat(64), samples: [], scanned_lines: 50, schema_version: "logs-query-result/v1", window_minutes: 30 };
    const answer = renderQa0144ReadFinal("同时检查配置、文件和日志", [
      observed("config.inspect", "config-inspect-result/v1", config, "config"),
      observed("files.list", "files-list-result/v1", files, "files"),
      observed("logs.query", "logs-query-result/v1", logs, "logs"),
    ]);
    expect(answer).toContain("max-players = 20");
    expect(answer).toContain("Core.jar");
    expect(answer).toContain("日志匹配 0 条");
  });

  it("renders fetched passages instead of treating a cited URL as proof of a claim", () => {
    const url = "https://docs.example.org/plugins";
    const page = { status: "read", url, fetched_at: "2026-10-06T12:00:00Z", sha256: "a".repeat(64), passages: ["Check the release notes for the exact supported server version."] };
    const web = observed("web.search", "web-search-result/v1", {
      provider: "fixture", query: "plugin compatibility", results: [{ title: "Plugin docs", url, snippet: "A different search snippet", date: "", page }], schema_version: "web-search-result/v1",
    }, "web");
    const answer = renderWebSourceFinal("搜索插件兼容建议", [web]);
    expect(answer).toContain(page.passages[0]);
    expect(answer).toContain(url);
    expect(answer).not.toContain("A different search snippet");
    expect(answer).toContain("未据此确认");
    expect(renderWebSourceFinal("混合读取", [web, { ...web, tool: "config.inspect" }])).toBeUndefined();
  });

  it("reports discovery-only evidence when reading fails", () => {
    const web = observed("web.search", "web-search-result/v1", {
      provider: "fixture", query: "plugin compatibility", results: [{ title: "Plugin docs", url: "https://docs.example.org/plugins", snippet: "Claimed compatible", date: "", page: { status: "unavailable" } }], schema_version: "web-search-result/v1",
    }, "web");
    expect(renderWebSourceFinal("搜索兼容建议", [web])).toContain("未取得可核验");
    expect(renderWebSourceFinal("搜索兼容建议", [web])).not.toContain("Claimed compatible");
  });

  it("rejects forged page provenance, digests and empty passages", () => {
    const url = "https://docs.example.org/plugins";
    const page = { status: "read", url, fetched_at: "2026-10-06T12:00:00Z", sha256: "a".repeat(64), passages: ["Check the release notes for the exact supported server version."] };
    expect(validatedWebSourcePage(page, url)).toBeDefined();
    for (const invalid of [{ ...page, url: "https://other.example.org/plugins" }, { ...page, sha256: "bad" }, { ...page, passages: [] }, { ...page, fetched_at: "invalid" }]) {
      expect(validatedWebSourcePage(invalid, url)).toBeUndefined();
    }
  });

  it("prefers a follow-up query without erasing an earlier successful read", () => {
    const make = (url: string, status: string, passage: string) => ({ title: "Source", url, snippet: "Discovery", date: "", page: status === "read"
      ? { status, url, fetched_at: "2026-10-06T12:00:00Z", sha256: "a".repeat(64), passages: [passage] } : { status } });
    const oldUrl = "https://docs.example.org/install", newUrl = "https://docs.example.org/updating";
    const first = observed("web.search", "web-search-result/v1", { schema_version: "web-search-result/v1", results: [make(oldUrl, "read", "Check installation release notes for the exact supported version.")] }, "first");
    const second = observed("web.search", "web-search-result/v1", { schema_version: "web-search-result/v1", results: [make(newUrl, "read", "Before updating, back up configuration and plugin files together."), make(oldUrl, "not-read", "")] }, "second");
    const answer = renderWebSourceFinal("搜索更新建议", [first, second])!;
    expect(answer.indexOf(newUrl)).toBeLessThan(answer.indexOf(oldUrl));
    expect(answer).toContain("Check installation release notes");
    expect(answer).toContain("Before updating, back up");
  });
  it("limits early completion to public searches and retains explicit combined operations", () => {
    const url = "https://docs.example.org/plugins";
    const web = observed("web.search", "web-search-result/v1", { schema_version: "web-search-result/v1", results: [{ title: "Docs", url, snippet: "Snippet", date: "", page: { status: "read", url, fetched_at: "2026-10-06T12:00:00Z", sha256: "a".repeat(64), passages: ["Check the release notes for the exact supported server version."] } }] }, "web");
    expect(publicSourceSearchCompletion("搜索官方安装文档，先别安装", [web])?.decision.action).toBe("final");
    expect(publicSourceSearchCompletion("搜索官方插件然后安装", [web])).toBeUndefined();
    expect(publicSourceSearchCompletion("Search docs and install the plugin", [web])).toBeUndefined();
    expect(publicSourceSearchCompletion("找到并安装插件", [web])).toBeUndefined();
  });

  it("uses successful page evidence when an auxiliary search fails", () => {
    const url = "https://docs.example.org/plugins";
    const web = observed("web.search", "web-search-result/v1", { schema_version: "web-search-result/v1", results: [{ title: "Docs", url, snippet: "Snippet", date: "", page: { status: "read", url, fetched_at: "2026-10-06T12:00:00Z", sha256: "a".repeat(64), passages: ["Check the release notes for the exact supported server version."] } }] }, "web");
    const failed = { ...web, tool_call_id: "failed", status: "failed" as const, data: undefined };
    expect(publicSourceSearchCompletion("搜索文档", [web, failed])?.verified).toBe(true);
    expect(renderWebSourceFinal("搜索文档", [web, failed])).toContain("Check the release notes");
    expect(publicSourceSearchCompletion("搜索文档", [failed])?.decision.action).toBe("cannot_proceed");
  });

});
