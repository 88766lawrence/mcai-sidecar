import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentLoopObservation } from "../chat/agent-loop";
import { groundedQa0144WebFinal, projectQa0144ReadResult, renderQa0144ReadFinal } from "./qa0144-read-observation";

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

  it("allows only URLs that came from the completed search observation", () => {
    const web = observed("web.search", "web-search-result/v1", {
      provider: "fixture", query: "Paper Java requirements", results: [
        { title: "Paper docs", url: "https://docs.papermc.io/paper/getting-started/", snippet: "Java requirements", date: "2026-08-01" },
      ], schema_version: "web-search-result/v1",
    }, "web");
    expect(groundedQa0144WebFinal("See https://docs.papermc.io/paper/getting-started/", [web])).toBe(true);
    expect(groundedQa0144WebFinal("See https://example.invalid/claim", [web])).toBe(false);
  });
});
