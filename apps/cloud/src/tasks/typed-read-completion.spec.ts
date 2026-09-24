import { describe, expect, it } from "vitest";
import { renderTypedReadCompletion, type TypedCompletionContext } from "./typed-read-completion.js";

function context(overrides: Partial<TypedCompletionContext> = {}): TypedCompletionContext {
  return {
    intent: "请列出 config/presets 目录中的 .yml 文件并告诉我数量",
    state: "SUCCEEDED",
    action: "read",
    goals: [
      { id: "files", domain: "filesystem", target: "/config/presets", resultKind: "collection", filter: { field: "name", operator: "suffix", value: ".yml" }, required: true },
      { id: "count", domain: "filesystem", target: "/config/presets", resultKind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".yml" }, required: true },
    ],
    results: [
      { goalId: "files", status: "satisfied", observed: [] },
      { goalId: "count", status: "satisfied", observed: 0 },
    ],
    ...overrides,
  };
}

describe("typed read completion rendering", () => {
  it.each([
    ["检查近期记录并判断是否需要处理", [], 0, false, "未找到符合条件的日志条目，数量为 0。\n当前未发现需要处理的迹象。"],
    ["Review recent records and assess whether action is needed", ["Module Vega failed to initialize"], 1, true, "Found 1 matching log entry:\n- Module Vega failed to initialize\nThe matching evidence indicates that attention is needed."],
  ] as const)("merges log collection, count, and deterministic handling judgement", (intent, entries, count, judgement, expected) => {
    expect(renderTypedReadCompletion({
      intent, state: "SUCCEEDED", action: "diagnose",
      goals: [
        { id: "events", domain: "diagnosis", target: "recent-logs", resultKind: "collection", required: true },
        { id: "count", domain: "diagnosis", target: "recent-logs", resultKind: "count", required: true },
        { id: "handling", domain: "diagnosis", target: "recent-logs", resultKind: "judgement", required: true },
      ],
      results: [
        { goalId: "events", status: "satisfied", observed: entries },
        { goalId: "count", status: "satisfied", observed: count },
        { goalId: "handling", status: "satisfied", observed: judgement },
      ],
    })).toBe(expected);
  });

  it("renders an empty Chinese filtered file collection as one natural answer", () => {
    const answer = renderTypedReadCompletion(context());
    expect(answer).toContain("未找到");
    expect(answer).toContain("数量为 0");
    expect(answer).not.toContain("[]");
    expect(answer).not.toContain("Read filesystem entries");
  });

  it("renders an English non-empty collection and count without JSON", () => {
    const answer = renderTypedReadCompletion(context({
      intent: "List every TOML filename under settings/profiles and give me the matching count.",
      goals: [
        { id: "files", domain: "filesystem", target: "/settings/profiles", resultKind: "collection", filter: { field: "name", operator: "suffix", value: ".toml" }, required: true },
        { id: "count", domain: "filesystem", target: "/settings/profiles", resultKind: "filtered_count", filter: { field: "name", operator: "suffix", value: ".toml" }, required: true },
      ],
      results: [
        { goalId: "files", status: "satisfied", observed: ["alpha.toml", "beta.toml"] },
        { goalId: "count", status: "satisfied", observed: 2 },
      ],
    }));
    expect(answer).toContain("2 matching files");
    expect(answer).toContain("- alpha.toml");
    expect(answer).toContain("- beta.toml");
    expect(answer).not.toContain('["alpha.toml"');
  });

  it("uses domain language for an empty whitelist roster", () => {
    const answer = renderTypedReadCompletion(context({
      intent: "只读查看白名单成员和人数",
      goals: [
        { id: "members", domain: "access", target: "whitelist", resultKind: "collection", required: true },
        { id: "count", domain: "access", target: "whitelist", resultKind: "count", required: true },
      ],
      results: [
        { goalId: "members", status: "satisfied", observed: [] },
        { goalId: "count", status: "satisfied", observed: 0 },
      ],
    }));
    expect(answer).toBe("白名单中没有成员，人数为 0。");
  });

  it("renders log samples and count as one readable response", () => {
    const answer = renderTypedReadCompletion(context({
      intent: "Check recent connection errors and give the matching lines and count.",
      action: "diagnose",
      goals: [
        { id: "events", domain: "diagnosis", target: "recent-logs", resultKind: "collection", required: true },
        { id: "count", domain: "diagnosis", target: "recent-logs", resultKind: "count", required: true },
      ],
      results: [
        { goalId: "events", status: "satisfied", observed: ["connection timed out"] },
        { goalId: "count", status: "satisfied", observed: 1 },
      ],
    }));
    expect(answer).toContain("1 matching log entry");
    expect(answer).toContain("- connection timed out");
  });

  it("fails closed instead of rendering incomplete or conflicting typed results", () => {
    expect(renderTypedReadCompletion(context({ results: [{ goalId: "files", status: "satisfied", observed: ["one.yml"] }] }))).toBeUndefined();
    expect(renderTypedReadCompletion(context({ results: [
      { goalId: "files", status: "satisfied", observed: ["one.yml"] },
      { goalId: "count", status: "satisfied", observed: 2 },
    ] }))).toBeUndefined();
  });
});
