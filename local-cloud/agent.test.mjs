import assert from "node:assert/strict";
import test from "node:test";
import { decisionFromAgentResult, providerConfigured } from "./agent.mjs";

test("provider configuration requires all provider fields", () => {
  assert.equal(providerConfigured({ provider: {} }), false);
  assert.equal(providerConfigured({
    provider: { apiKey: "key", baseUrl: "https://example.test/v1", model: "model" },
  }), true);
});

test("a plain response stays direct", () => {
  const decision = decisionFromAgentResult({
    text: "Paper 适合插件生态。",
    steps: [{ toolCalls: [], toolResults: [] }],
    response: { id: "response-1" },
  });
  assert.deepEqual(decision, {
    route: "direct",
    answer: "Paper 适合插件生态。",
    requestId: "response-1",
  });
});

test("an operation tool call becomes a controlled Cloud task", () => {
  const decision = decisionFromAgentResult({
    text: "已提交启动目标。",
    steps: [{
      toolCalls: [{
        toolName: "requestOperation",
        input: { intent: "启动当前实例", preferredTool: "instance.start", reason: "实例已停止" },
      }],
      toolResults: [],
    }],
    response: { id: "response-2" },
  });
  assert.equal(decision.route, "tool");
  assert.equal(decision.toolIntent, "启动当前实例");
  assert.deepEqual(decision.trace, [{
    stage: "tool",
    label: "调用工具",
    result: "instance.start",
  }]);
});

test("delegation and clarification use actual AI SDK tool results", () => {
  const delegated = decisionFromAgentResult({
    text: "",
    steps: [{
      toolCalls: [],
      toolResults: [{
        toolName: "delegateAnalysis",
        output: { kind: "diagnostics", answer: "先检查最近一次崩溃证据。" },
      }],
    }],
    response: { id: "response-3" },
  });
  assert.equal(delegated.route, "delegate");
  assert.equal(delegated.answer, "先检查最近一次崩溃证据。");

  const clarified = decisionFromAgentResult({
    text: "",
    steps: [{
      toolCalls: [],
      toolResults: [{
        toolName: "requestClarification",
        output: { question: "要操作哪个实例？", missing: "实例" },
      }],
    }],
    response: { id: "response-4" },
  });
  assert.equal(clarified.route, "clarify");
  assert.equal(clarified.answer, "要操作哪个实例？");
});
