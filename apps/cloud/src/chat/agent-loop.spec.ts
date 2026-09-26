import { describe, expect, it } from "vitest";
import { AGENT_LOOP_TOOL_CATALOG, bindAgentToolCallToObservations, canonicalAgentToolCallKey, extractAgentLoopDecision, validateAgentLoopDecision, validateAgentToolCall } from "./agent-loop";

describe("agent loop wire boundary", () => {
  it("canonicalizes a root-hinted instance path before policy and approval binding", () => {
    const checked = validateAgentToolCall({
      action: "tool_call", tool: "config.patch",
      arguments: { path: "/server.properties", patch: [{ op: "replace", key: "view-distance", value: 9 }] },
      reason: "Update one setting",
    }, "mcs:test", "revision-1");
    expect(checked).toMatchObject({ ok: true, value: { arguments: { path: "server.properties", expected_revision: "revision-1" } } });
  });

  it("keeps the current revision Cloud-owned and validates every proposed change before approval", () => {
    const patch = AGENT_LOOP_TOOL_CATALOG.find((entry) => entry.name === "config.patch");
    expect(patch?.input_schema.required).toEqual(["path", "patch"]);
    expect(JSON.stringify(patch?.input_schema)).not.toContain("expected_revision");
    const base = { action: "tool_call" as const, tool: "config.patch" as const, reason: "Update configuration" };
    expect(validateAgentToolCall({ ...base, arguments: { path: "plugins/Lobby/config.yml", patch: [
      { op: "replace", key: "welcome.message", value: "欢迎回来" },
      { op: "add", key: "welcome.enabled", value: true },
    ] } }, "mcs:test", "current-revision")).toMatchObject({
      ok: true, value: { arguments: { expected_revision: "current-revision" } },
    });
    for (const argumentsValue of [
      { path: "plugins/Lobby/config.yml", patch: [{ key: "welcome.message", value: "hello" }] },
      { path: "plugins/Lobby/config.yml", patch: [{ op: "replace", key: "welcome..message", value: "hello" }] },
      { path: "plugins/Lobby/config.yml", patch: [{ op: "replace", key: "welcome.message", value: "hello" }], expected_revision: "model-guessed" },
    ]) {
      expect(validateAgentToolCall({ ...base, arguments: argumentsValue }, "mcs:test", "current-revision"))
        .toMatchObject({ ok: false, code: "AGENT_LOOP_INVALID_ARGUMENTS" });
    }
  });

  it("binds plugin installation to one successful resolve observation from the same run", () => {
    const call = bindAgentToolCallToObservations({
      action: "tool_call", tool: "plugin.install",
      arguments: { project: "essentialsx", artifact_ref: "EssentialsX-2.22.0.jar", expected_integrity: { algorithm: "sha256", value: "ab".repeat(32) } },
      reason: "Install the resolved artifact",
    }, [{
      tool_call_id: "call-resolve", tool: "plugin.resolve", status: "succeeded", retryable: false, side_effect: "none",
      data: { task_id: "task-resolve", goal_results: [{ observed: { project: "essentialsx", artifact: "EssentialsX-2.22.0.jar", sha256: "ab".repeat(32) } }] },
      evidence: { ids: ["e1"], summaries: ["resolved"] },
    }]);
    expect(call).toMatchObject({ arguments: { source_task_id: "task-resolve", source_call_id: "call-resolve" } });
    expect(bindAgentToolCallToObservations({
      action: "tool_call", tool: "plugin.install",
      arguments: { project: "other", artifact_ref: "EssentialsX-2.22.0.jar", expected_integrity: { algorithm: "sha256", value: "ab".repeat(32) } }, reason: "Install",
    }, [])).toBeUndefined();
  });

  it("binds plugin installation from typed direct-execution evidence", () => {
    const call = bindAgentToolCallToObservations({
      action: "tool_call", tool: "plugin.install", reason: "Install the resolved artifact",
      arguments: { project: "luckperms", artifact_ref: "LuckPerms.jar", expected_integrity: { algorithm: "sha512", value: "ab".repeat(64) } },
    }, [{
      tool_call_id: "call-resolve", tool: "plugin.resolve", status: "succeeded", retryable: false, side_effect: "none",
      data: { task_id: "task-resolve", goal_results: [], observations: [{ kind: "plugin", observed: {
        schema_version: "resolved-plugin/v1", project: "luckperms", artifact: "LuckPerms.jar", sha256: "", source_sha512: "ab".repeat(64),
      } }] }, evidence: { ids: ["e1"], summaries: ["resolved"] },
    }]);
    expect(call).toMatchObject({ arguments: { source_task_id: "task-resolve", source_call_id: "call-resolve" } });
  });

  it("replaces a model-guessed artifact identity with the unique resolved artifact capability", () => {
    const hash = "ab".repeat(64);
    const call = bindAgentToolCallToObservations({
      action: "tool_call", tool: "plugin.install", reason: "Install the resolved artifact",
      arguments: {
        project: "coreprotect", artifact_ref: "modrinth:coreprotect:24.0",
        expected_integrity: { algorithm: "sha512", value: hash },
      },
    }, [{
      tool_call_id: "call-resolve", tool: "plugin.resolve", status: "succeeded", retryable: false, side_effect: "none",
      data: { task_id: "task-resolve", goal_results: [], observations: [{ kind: "plugin", observed: {
        schema_version: "resolved-plugin/v1", project: "coreprotect", artifact: "CoreProtect-CE-24.0.jar",
        sha256: "", source_sha512: hash,
      } }] }, evidence: { ids: ["e1"], summaries: ["resolved"] },
    }]);
    expect(call).toMatchObject({ arguments: {
      project: "coreprotect", artifact_ref: "CoreProtect-CE-24.0.jar",
      expected_integrity: { algorithm: "sha512", value: hash },
      source_task_id: "task-resolve", source_call_id: "call-resolve",
    } });
  });

  it("fails closed when the same project has more than one distinct resolved artifact", () => {
    const observation = (callId: string, taskId: string, artifact: string, hash: string) => ({
      tool_call_id: callId, tool: "plugin.resolve" as const, status: "succeeded" as const, retryable: false, side_effect: "none" as const,
      data: { task_id: taskId, goal_results: [{ observed: { project: "coreprotect", artifact, source_sha512: hash } }] },
      evidence: { ids: [callId], summaries: ["resolved"] },
    });
    expect(bindAgentToolCallToObservations({
      action: "tool_call", tool: "plugin.install", reason: "Install",
      arguments: { project: "coreprotect", artifact_ref: "guessed", expected_integrity: { algorithm: "sha512", value: "ab".repeat(64) } },
    }, [
      observation("call-a", "task-a", "CoreProtect-A.jar", "ab".repeat(64)),
      observation("call-b", "task-b", "CoreProtect-B.jar", "cd".repeat(64)),
    ])).toBeUndefined();
  });

  it.each(["../server.properties", "a/../../server.properties", "C:\\server.properties", "//host/server.properties", "https://host/file.properties"])(
    "rejects unsafe instance paths before dispatch: %s",
    (path) => {
      const checked = validateAgentToolCall({
        action: "tool_call", tool: "config.patch",
        arguments: { path, patch: [{ op: "replace", key: "view-distance", value: 9 }] },
        reason: "Update one setting",
      }, "mcs:test", "revision-1");
      expect(checked).toMatchObject({ ok: false, code: "AGENT_LOOP_INVALID_ARGUMENTS" });
    },
  );

  it("describes tick-rate observations as separate console reads rather than process metrics", () => {
    const consoleTool = AGENT_LOOP_TOOL_CATALOG.find((entry) => entry.name === "console.command");
    const metricsTool = AGENT_LOOP_TOOL_CATALOG.find((entry) => entry.name === "instance.metrics");
    expect(consoleTool?.description).toContain("tps");
    expect(consoleTool?.description).toContain("mspt");
    expect(metricsTool?.description).toContain("does not provide Minecraft TPS or MSPT");
  });
  it("publishes registered tools with closed argument schemas", () => {
    expect(AGENT_LOOP_TOOL_CATALOG.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "console.command", "config.inspect", "files.list", "logs.query", "instance.metrics", "players.inspect", "plugin.resolve", "web.search", "file.download", "instance.start",
    ]));
    expect(AGENT_LOOP_TOOL_CATALOG.every((entry) => entry.input_schema.additionalProperties === false)).toBe(true);
  });

  it("lets the AI create one inert staged download from any public HTTP(S) source", () => {
    const download = AGENT_LOOP_TOOL_CATALOG.find((entry) => entry.name === "file.download");
    expect(download?.description).toContain("no repository or domain allowlist");
    expect(download?.input_schema).toMatchObject({ additionalProperties: false, required: ["url", "target"] });
    expect(validateAgentToolCall({
      action: "tool_call", tool: "file.download",
      arguments: { url: "https://unlisted.example/releases/grim.jar?build=42", target: "downloads/grim.jar" },
      reason: "download the task-relevant public artifact",
    }, "mcs:test")).toMatchObject({
      ok: true,
      value: { policy: { action: "write", risk: "low", requires_confirmation: false, producer_verified: true } },
    });
  });

  it.each([
    ["http://127.0.0.1/a.jar", "downloads/a.jar"],
    ["https://user:secret@example.org/a.jar", "downloads/a.jar"],
    ["https://example.org/a.jar#fragment", "downloads/a.jar"],
    ["https://example.org/a.jar", "plugins/a.jar"],
    ["https://example.org/a.jar", "downloads/nested/a.jar"],
  ])("rejects a non-public URL or active destination before dispatch: %s -> %s", (url, target) => {
    expect(validateAgentToolCall({
      action: "tool_call", tool: "file.download", arguments: { url, target }, reason: "download",
    }, "mcs:test")).toMatchObject({ ok: false, code: "AGENT_LOOP_INVALID_ARGUMENTS" });
  });

  it("publishes the complete model-writable logs query shape without requiring an internal digest", () => {
    const logs = AGENT_LOOP_TOOL_CATALOG.find((entry) => entry.name === "logs.query");
    expect(logs?.input_schema.required).toEqual(expect.arrayContaining(["window_minutes", "max_lines", "filter_query"]));
    expect((logs?.input_schema.properties as Record<string, any>).filter_query).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["groups"],
    });
    expect(JSON.stringify(logs?.input_schema)).not.toContain("digest");
    expect(logs?.description).toContain("at most 4 groups and at most 8 distinct condition tokens per group");
  });

  it("extracts exactly one ordinary-content JSON decision and rejects prose-only or two objects", () => {
    expect(extractAgentLoopDecision('Decision: {"action":"tool_call","tool":"console.command","arguments":{"command":"weather query"},"reason":"read weather"}').ok).toBe(true);
    expect(extractAgentLoopDecision("I would call a tool")).toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_JSON_OBJECT_COUNT" }));
    expect(extractAgentLoopDecision('{} {}')).toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_JSON_OBJECT_COUNT" }));
  });

  it("strictly validates terminal evidence citations", () => {
    expect(validateAgentLoopDecision({ action: "final", answer: "当前为晴天。", citations: [] }, ["call-1"])).toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_EVIDENCE_REQUIRED" }));
    expect(validateAgentLoopDecision({ action: "final", answer: "当前为晴天。", citations: ["call-2"] }, ["call-1"])).toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INVALID_CITATION" }));
    expect(validateAgentLoopDecision({ action: "final", answer: "当前为晴天。", citations: ["call-1"] }, ["call-1"]).ok).toBe(true);
  });

  it("requires a final answer to account for every successful observation in the run", () => {
    expect(validateAgentLoopDecision({ action: "final", answer: "两项资料已比较。", citations: ["call-1"] }, ["call-1", "call-2"]))
      .toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INCOMPLETE_CITATION" }));
    expect(validateAgentLoopDecision({ action: "final", answer: "两项资料已比较。", citations: ["call-1", "call-2"] }, ["call-1", "call-2"]).ok)
      .toBe(true);
  });

  it("does not let a model claim success before any successful observation exists", () => {
    expect(validateAgentLoopDecision({ action: "final", answer: "The requested change is complete.", citations: [] }, [])).toEqual(
      expect.objectContaining({ ok: false, code: "AGENT_LOOP_EVIDENCE_REQUIRED" }),
    );
  });

  it("rejects a final that promises another tool action or leaks internal tool names", () => {
    expect(validateAgentLoopDecision({ action: "final", answer: "下面改用只读命令获取插件。", citations: ["call-1"] }, ["call-1"]))
      .toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_NON_TERMINAL_FINAL" }));
    expect(validateAgentLoopDecision({ action: "final", answer: "目录不存在（已用 files.list 查询）。", citations: ["call-1"] }, ["call-1"]))
      .toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INTERNAL_TOOL_LEAK" }));
    expect(validateAgentLoopDecision({ action: "final", answer: "该目录不存在，因此无法从中列出文件。", citations: ["call-1"] }, ["call-1"]).ok).toBe(true);
  });

  it.each([
    "结果来自实例 mcs:daemon:8a54968e5a944f40b50b6cbefdec3e4f。",
    "这台服务器（实例 8a54968e…）运行 Paper。",
    "版本检查出现 FileNotFoundException: https://api.example.test/v2/version。",
    "以上来自控制台命令输出。",
  ])("rejects user-visible infrastructure identifiers or diagnostics: %s", (answer) => {
    expect(validateAgentLoopDecision({ action: "final", answer, citations: ["call-1"] }, ["call-1"]))
      .toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INTERNAL_DETAIL_LEAK" }));
  });

  it("rejects a recovery answer that exposes a missing console return", () => {
    expect(validateAgentLoopDecision({ action: "final", answer: "读取失败（控制台未返回可判断结果），随后已安全完成查询。", citations: ["call-1"] }, ["call-1"]))
      .toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INTERNAL_DETAIL_LEAK" }));
  });

  it("rejects user-visible internal snake-case condition labels", () => {
    expect(validateAgentLoopDecision({ action: "final", answer: "未命中 heap_exhaustion 或 cannot_keep_up。", citations: ["call-1"] }, ["call-1"]))
      .toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INTERNAL_DETAIL_LEAK" }));
  });

  it("derives canonical policy, gates high-risk calls, and rejects cross-instance calls", () => {
    const read = validateAgentToolCall({ action: "tool_call", tool: "console.command", arguments: { command: "/gamerule mobGriefing" }, reason: "read value" }, "instance-1");
    expect(read).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ arguments: { command: "gamerule mobGriefing" }, policy: expect.objectContaining({ risk: "read", requires_confirmation: false }) }) }));
    expect(validateAgentToolCall({ action: "tool_call", tool: "console.command", arguments: { command: "op someone" }, reason: "requires approval" }, "instance-1")).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ policy: expect.objectContaining({ risk: "high", requires_confirmation: true }) }) }));
    expect(validateAgentToolCall({ action: "tool_call", tool: "instance.start", arguments: { target: "instance-2" }, reason: "start" }, "instance-1")).toEqual(expect.objectContaining({ ok: false, code: "AGENT_LOOP_INSTANCE_SCOPE_MISMATCH" }));
  });

  it("keeps an AI-selected high-risk lifecycle call behind confirmation instead of discarding it", () => {
    expect(validateAgentToolCall({
      action: "tool_call", tool: "instance.restart",
      arguments: { target: "instance-1", timeout_seconds: 120 }, reason: "restart after diagnosis",
    }, "instance-1")).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ policy: expect.objectContaining({ risk: "high", requires_confirmation: true }) }),
    }));
  });

  it("canonicalizes model-writable log groups into the provider envelope", () => {
    const checked = validateAgentToolCall({
      action: "tool_call", tool: "logs.query", reason: "read two fault classes",
      arguments: {
        window_minutes: 60,
        max_lines: 500,
        filter_query: { groups: [
          { all_of: ["memory_resource"], any_of: ["out_of_memory"] },
          { all_of: ["server_lag"], any_of: ["cannot_keep_up"] },
        ] },
      },
    }, "instance-1");
    expect(checked).toMatchObject({
      ok: true,
      value: { arguments: { filter_query: { schema_version: "log-filter-query/v1", groups: expect.any(Array), digest: expect.stringMatching(/^[a-f0-9]{64}$/) } } },
    });
  });

  it("normalizes a redundant condition repeated across all_of and any_of", () => {
    const checked = validateAgentToolCall({
      action: "tool_call", tool: "logs.query", reason: "read memory faults",
      arguments: {
        window_minutes: 45,
        max_lines: 480,
        filter_query: { groups: [{ all_of: ["memory_resource"], any_of: ["memory_resource", "out_of_memory"] }] },
      },
    }, "instance-1");
    expect(checked).toMatchObject({
      ok: true,
      value: { arguments: { filter_query: { groups: [{ all_of: ["memory_resource"], any_of: ["out_of_memory"] }] } } },
    });
  });

  it("reduces neutral all terms without discarding concrete conditions", () => {
    const checked = validateAgentToolCall({
      action: "tool_call", tool: "logs.query", reason: "read lag logs",
      arguments: {
        window_minutes: 45,
        max_lines: 480,
        filter_query: { groups: [{ all_of: ["all", "server_lag"], any_of: ["all", "cannot_keep_up"] }] },
      },
    }, "instance-1");
    expect(checked).toMatchObject({
      ok: true,
      value: { arguments: { filter_query: { groups: [{ all_of: ["server_lag"], any_of: [] }] } } },
    });
  });

  it("uses stable canonical keys for duplicate-call detection", () => {
    expect(canonicalAgentToolCallKey({ tool: "config.inspect", arguments: { keys: ["b", "a"], path: "server.properties" } }))
      .toBe(canonicalAgentToolCallKey({ tool: "config.inspect", arguments: { path: "server.properties", keys: ["b", "a"] } }));
  });
});
