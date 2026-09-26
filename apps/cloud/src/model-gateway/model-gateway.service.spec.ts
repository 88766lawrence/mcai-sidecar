import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelGatewayService } from "./model-gateway.service";

describe("ModelGatewayService typed intent adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCAI_MODEL_GATEWAY_TOKEN;
    delete process.env.MCAI_MODEL_GATEWAY_URL;
  });

  it("posts the registered tool schemas to the plain-content agent loop endpoint and verifies its strict decision", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-service-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      decision: { action: "tool_call", tool: "files.list", arguments: { path: "/plugins", suffix: ".jar" }, reason: "读取真实目录" },
      requestId: "loop-request", providerModel: "fixture-model", repairUsed: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ModelGatewayService().decideAgentLoop({
      sessionId: "session-1", message: "看看插件目录中的 jar", systemPrompt: "safe", history: [], round: 1,
      instance: { instance_id: "i", name: "Realm", platform: "paper", minecraft_version: "1.21.1", state: "running", profile_revision: "r", provider_type: "mcsmanager", collected_at: new Date().toISOString() },
    });
    expect(result).toMatchObject({ status: "answered", decision: { action: "tool_call", tool: "files.list" } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/agent-loop/decide");
    const body = JSON.parse(String(init.body));
    expect(body.toolCatalog.find((item: { name: string }) => item.name === "files.list").input_schema.required).toContain("path");
    expect(body.limits).toEqual({ maxRounds: 16, maxToolCalls: 19 });
  });

  it("accepts a final answer only when every cited URL came from the typed search observation", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-service-token";
    const source = "https://docs.papermc.io/paper/getting-started/";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      decision: { action: "final", answer: `Paper documents its runtime requirements at ${source}`, citations: ["call-web"] },
      requestId: "grounded-final",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const result = await new ModelGatewayService().decideAgentLoop({
      sessionId: "session-web", message: "Find Paper Java requirements", systemPrompt: "safe", history: [], round: 2,
      instance: { instance_id: "i", name: "Realm", platform: "paper", minecraft_version: "1.21.1", state: "running", profile_revision: "r", provider_type: "mcsmanager", collected_at: new Date().toISOString() },
      observations: [{
        tool_call_id: "call-web", tool: "web.search", status: "succeeded", retryable: false, side_effect: "none",
        data: { qa0144_read_result: { schema_version: "qa0144-read-result/v1", output_schema_id: "web-search-result/v1", value: {
          provider: "fixture", query: "Paper Java requirements", results: [{ title: "Paper docs", url: source, snippet: "Java requirements", date: "2026-08-01" }], schema_version: "web-search-result/v1",
        } } }, evidence: { ids: ["e-web"], summaries: ["typed"] },
      }],
    });
    expect(result).toMatchObject({ status: "answered", decision: { action: "final", answer: expect.stringContaining(source) } });
  });

  it("sends only the immutable source catalog, capability schema and bounded repair context to the real gateway endpoint", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-service-token";
    process.env.MCAI_MODEL_GATEWAY_URL = "http://127.0.0.1:4200";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      semanticFrames: [{ schema_version: "intent-semantic-frame/v1", assigned_source_refs: [], frames: [] }],
      requestId: "intent-request", providerModel: "fixture-model",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new ModelGatewayService();
    const instance = { instance_id: "mcs:d:i", name: "Realm", platform: "paper", minecraft_version: "1.22", state: "running" as const, profile_revision: "rev", provider_type: "mcsmanager" as const, collected_at: new Date().toISOString() };
    const result = await gateway.compileIntent({
      sourceCatalog: { schema_version: "intent-source-catalog/v1", source_digest: "a".repeat(64), digest: "b".repeat(64), refs: [] }, instance, attempt: 2,
      previousCandidate: { schema_version: "intent-candidate/v2", clauses: [], goals: [], scopes: [], constraints: [], evidence_requirements: [], response_requirements: [], predicates: [], unknown_goals: [] },
      validationErrors: [{ code: "SPAN_MISMATCH", path: "goals.i1", message: "bad span" }],
    });
    expect(result.status).toBe("answered");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/intent/compile");
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("intent");
    expect(body.sourceCatalog.schema_version).toBe("intent-source-catalog/v1");
    expect(body.framePlan.schema_version).toBe("intent-semantic-frame-plan/v1");
    expect(body.attempt).toBe(2);
    expect(body.capabilities.some((item: { id: string }) => item.id === "server.version")).toBe(true);
    expect(body.validationErrors[0].code).toBe("SPAN_MISMATCH");
    expect(body.previousCandidate.schema_version).toBe("intent-candidate/v2");
    expect(body).not.toHaveProperty("previousProposal");
  });

  it("preserves the stable compiler timeout code from an HTTP 504 without retrying", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-service-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: {
      code: "INTENT_COMPILER_PROVIDER_TIMEOUT", requestId: "request-timeout", provider: "fixture-model", httpStatus: 504,
      compilerMetrics: { mode: "json_only", provider_ms: 23_980, total_ms: 24_001, shard_count: 3, provider_call_count: 3, cancelled_shard_count: 2, terminal_code: "INTENT_COMPILER_PROVIDER_TIMEOUT", prompt: "must-not-log" }, repairUsed: false,
    } }), { status: 504, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ModelGatewayService().compileIntent({
      sourceCatalog: { schema_version: "intent-source-catalog/v1", source_digest: "a".repeat(64), digest: "b".repeat(64), refs: [] }, attempt: 1,
      instance: { instance_id: "mcs:d:i", name: "Realm", platform: "paper", minecraft_version: "1.22", state: "running", profile_revision: "rev", provider_type: "mcsmanager", collected_at: new Date().toISOString() },
    });
    expect(result).toMatchObject({
      status: "unavailable", error: "INTENT_COMPILER_PROVIDER_TIMEOUT", requestId: "request-timeout", providerModel: "fixture-model", httpStatus: 504, repairUsed: false,
      compilerMetrics: { mode: "json_only", provider_ms: 23_980, shard_count: 3, provider_call_count: 3, cancelled_shard_count: 2, terminal_code: "INTENT_COMPILER_PROVIDER_TIMEOUT" },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-log");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["network rejection", () => Promise.reject(new TypeError("fetch failed")), "MODEL_GATEWAY_NETWORK_ERROR"],
    ["client timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError")), "MODEL_GATEWAY_CLIENT_TIMEOUT"],
    ["invalid json", () => Promise.resolve(new Response("not-json", { status: 502 })), "MODEL_GATEWAY_INVALID_JSON"],
  ] as const)("distinguishes %s without leaking response bodies", async (_label, factory, expected) => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-service-token";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(factory));
    const result = await new ModelGatewayService().compileIntent({
      sourceCatalog: { schema_version: "intent-source-catalog/v1", source_digest: "a".repeat(64), digest: "b".repeat(64), refs: [] }, attempt: 1,
      instance: { instance_id: "mcs:d:i", name: "Realm", platform: "paper", minecraft_version: "1.22", state: "running", profile_revision: "rev", provider_type: "mcsmanager", collected_at: new Date().toISOString() },
    });
    expect(result).toMatchObject({ status: "unavailable", error: expected });
  });

  it("records validator terminal metrics without source, catalog text, prompts, or credentials", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    new ModelGatewayService().recordIntentCompilerTerminal({
      requestId: "request-safe", providerModel: "fixture", code: "UNKNOWN_SOURCE_REF", repairUsed: false, candidateCount: 3,
      compilerMetrics: { mode: "json_only", provider_ms: 18, catalog_ref_count: 4, prompt: "secret source text", authorization: "Bearer secret" },
    });
    const logged = info.mock.calls.flat().join(" ");
    expect(logged).toContain("UNKNOWN_SOURCE_REF");
    expect(logged).toContain("catalog_ref_count");
    expect(logged).not.toContain("secret source text");
    expect(logged).not.toContain("Bearer secret");
    info.mockRestore();
  });

  it("uses the compact write proposal endpoint without instance id or full intent IR payload", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-service-token";
    process.env.MCAI_MODEL_GATEWAY_URL = "http://127.0.0.1:4200";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: "weather clear" }, summary: "等待确认" },
      requestId: "write-proposal-1", providerModel: "fixture", proposalMetrics: { mode: "json_only", schema_chars: 800, prompt_chars: 500, terminal_code: "WRITE_PROPOSAL_OK", authorization: "secret" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ModelGatewayService().proposeConfirmedWrite({
      intent: "把天气改成晴天",
      instance: { instance_id: "secret-instance-id", name: "Realm", platform: "paper", minecraft_version: "1.21.1", state: "running", profile_revision: "rev", provider_type: "mcsmanager", collected_at: new Date().toISOString() },
    });
    expect(result).toMatchObject({ status: "answered", proposal: { tool: "console.command", parameters: { command: "weather clear" } }, proposalMetrics: { mode: "json_only", schema_chars: 800, prompt_chars: 500, terminal_code: "WRITE_PROPOSAL_OK" } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/confirmed-write/propose");
    const payload = JSON.parse(String(init.body));
    expect(payload).not.toHaveProperty("sourceCatalog");
    expect(payload).not.toHaveProperty("intentIR");
    expect(payload.instanceContext).not.toHaveProperty("id");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });
});
