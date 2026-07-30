import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSystemInstructions,
  conciseAnswer,
  decisionFromAgentResult,
  providerConfigured,
} from "./agent.mjs";

test("provider configuration requires all provider fields", () => {
  assert.equal(providerConfigured({ provider: {} }), false);
  assert.equal(providerConfigured({
    provider: { apiKey: "key", baseUrl: "https://example.test/v1", model: "model" },
  }), true);
});

test("system prompt uses layered execution and safety contracts", () => {
  const prompt = buildSystemInstructions({
    instance: { id: "mcs:daemon:instance", state: "running" },
    availableTools: ["console.command", "instance.stop"],
    systemPrompt: "回答使用简体中文。",
  });
  for (const section of ["## Tooling", "## Execution Bias", "## Minecraft Operations", "## Safety", "## Runtime Context"]) {
    assert.match(prompt, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(prompt, /命令已提交、任务正在运行都不等于完成/);
  assert.match(prompt, /多阶段方案、系统性诊断、风险比较或验收标准，必须调用 delegateAnalysis/);
  assert.match(prompt, /实时数据优先于分析委派/);
  assert.match(prompt, /不得再次询问操作哪个实例/);
  assert.match(prompt, /<current_instance>.*mcs:daemon:instance.*<\/current_instance>/);
  assert.match(prompt, /<session_instructions>回答使用简体中文。<\/session_instructions>/);
  assert.doesNotMatch(prompt, /preferredTool=file\.download/);
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

test("removes unsolicited closing offers but keeps required next actions", () => {
  assert.equal(
    conciseAnswer("Paper 适合插件生态。如果你需要，我可以继续介绍安装方法。"),
    "Paper 适合插件生态。",
  );
  assert.equal(
    conciseAnswer("Paper 适合插件生态。\n\n如果您还有其他问题，请随时告诉我。"),
    "Paper 适合插件生态。",
  );
  assert.equal(
    conciseAnswer("实例启动失败：Agent 离线。下一步：恢复 Agent 连接后重试。"),
    "实例启动失败：Agent 离线。下一步：恢复 Agent 连接后重试。",
  );
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

test("a console operation remains a controlled Cloud task", () => {
  const decision = decisionFromAgentResult({
    text: "已提交控制台命令。",
    steps: [{
      toolCalls: [{
        toolName: "requestOperation",
        input: { intent: "在当前实例控制台执行 list", preferredTool: "console.command", reason: "用户明确要求读取在线玩家" },
      }],
      toolResults: [],
    }],
    response: { id: "response-console" },
  });
  assert.equal(decision.route, "tool");
  assert.equal(decision.toolIntent, "在当前实例控制台执行 list");
  assert.equal(decision.trace[0].result, "console.command");
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

  const delegatedWithOffer = decisionFromAgentResult({
    text: "",
    steps: [{
      toolCalls: [],
      toolResults: [{
        toolName: "delegateAnalysis",
        output: { kind: "diagnostics", answer: "检查最新崩溃日志。如有需要，我可以继续分析。" },
      }],
    }],
    response: { id: "response-3b" },
  });
  assert.equal(delegatedWithOffer.answer, "检查最新崩溃日志。");

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
