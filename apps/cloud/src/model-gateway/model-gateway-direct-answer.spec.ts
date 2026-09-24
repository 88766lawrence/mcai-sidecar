import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelGatewayService } from "./model-gateway.service";

describe("ModelGatewayService initial natural answers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCAI_MODEL_GATEWAY_TOKEN;
  });

  it("accepts an evidence-free final before any tool call", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-token";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      decision: { action: "final", answer: "不客气。", citations: [] },
      requestId: "request-direct",
      providerModel: "test-model",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new ModelGatewayService().decideAgentLoop({
      sessionId: "session-1",
      message: "谢谢",
      systemPrompt: "直接回答普通对话。",
      history: [],
      instance: {
        instance_id: "instance-1", name: "Survival", platform: "paper",
        minecraft_version: "1.21.1", state: "running", profile_revision: "revision-1",
        provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      },
      observations: [],
      round: 1,
    });

    expect(result).toMatchObject({
      status: "answered",
      decision: { action: "final", answer: "不客气。", citations: [] },
    });
  });

  it("still rejects an evidence-free final after a failed tool call", async () => {
    process.env.MCAI_MODEL_GATEWAY_TOKEN = "test-token";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      decision: { action: "final", answer: "操作已经完成。", citations: [] },
      requestId: "request-failed-tool",
      providerModel: "test-model",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new ModelGatewayService().decideAgentLoop({
      sessionId: "session-1",
      message: "继续",
      systemPrompt: "工具结果必须有证据。",
      history: [],
      instance: {
        instance_id: "instance-1", name: "Survival", platform: "paper",
        minecraft_version: "1.21.1", state: "running", profile_revision: "revision-1",
        provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      },
      observations: [{
        tool_call_id: "call-failed", tool: "console.command", status: "failed",
        error: { code: "COMMAND_FAILED", message: "command failed" },
        retryable: false, side_effect: "none", evidence: { ids: [], summaries: [] },
      }],
      round: 2,
    });

    expect(result).toEqual({ status: "unavailable", error: "AGENT_LOOP_EVIDENCE_REQUIRED" });
  });
});
