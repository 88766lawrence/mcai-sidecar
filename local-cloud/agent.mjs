import { ToolLoopAgent, generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const supportedOperations = [
  "logs.query",
  "files.list",
  "server.install",
  "config.patch",
  "plugin.resolve",
  "plugin.install",
  "console.command",
  "instance.start",
  "instance.stop",
  "instance.restart",
];

export function providerConfigured(config) {
  const provider = config.provider ?? {};
  return Boolean(provider.apiKey && provider.baseUrl && provider.model);
}

function modelFor(config, modelId = config.provider.model) {
  const provider = config.provider;
  const openai = createOpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl.replace(/\/+$/, ""),
    name: "mcai-model-provider",
  });
  return openai.chat(modelId);
}

function candidateModels(config) {
  return [...new Set([
    config.provider?.model,
    ...(Array.isArray(config.provider?.fallbackModels) ? config.provider.fallbackModels : []),
  ].filter((value) => typeof value === "string" && value.trim()))];
}

function isCapacityError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(429|503|capacity|rate.?limit|overloaded|temporarily unavailable|resource exhausted|too many requests)/i.test(message);
}

function friendlyModelError(error) {
  if (isCapacityError(error)) {
    return "当前模型暂时达到容量上限，已自动重试；请稍后再试，或在模型云配置中添加备用模型。";
  }
  return "模型云暂时不可用。你可以稍后重试；现有 Agent 与任务执行不受影响。";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function existingInstanceStartContract() {
  return [
    "启动当前已有实例只需要实例引用和 Provider 可用，不需要平台、Minecraft 版本或加载器。",
    "当前实例 stopped 时，用户说启动、开机或开启，必须调用 requestOperation，preferredTool=instance.start。",
    "For an explicit stop or shutdown request, call requestOperation with preferredTool=instance.stop. This is a confirmed operation.",
    "不得为启动已有实例追问 platform、minecraftVersion、loader 或 loaderVersion。",
    "当前实例 running 时直接说明已经运行；starting 时直接说明正在启动。",
  ].join("\n");
}

const trailingOfferPatterns = [
  /(?:如果|若|如)(?:你|您)?(?:还)?(?:需要|想要|希望)[^。！？!?\n]{0,100}(?:我(?:可以|能|会)|请(?:告诉|告知)|随时)[^。！？!?\n]*[。！？!?]?$/u,
  /如果(?:你|您)?(?:还)?有(?:任何|其他|其它|更多)?(?:问题|需求|需要)[^。！？!?\n]{0,80}(?:请(?:告诉|告知)|随时(?:问|联系|告诉|告知))[^。！？!?\n]*[。！？!?]?$/u,
  /(?:有|如果有)(?:任何|其他|其它|更多)?(?:问题|需求|需要)[^。！？!?\n]{0,80}(?:请(?:告诉|告知)|随时(?:问|联系|告诉|告知))[^。！？!?\n]*[。！？!?]?$/u,
  /(?:需要的话|如有需要)[^。！？!?\n]{0,80}(?:我(?:可以|能|会)|请(?:告诉|告知)|随时)[^。！？!?\n]*[。！？!?]?$/u,
];

export function conciseAnswer(value) {
  let answer = String(value ?? "").trim();
  let previous;
  do {
    previous = answer;
    for (const pattern of trailingOfferPatterns) {
      answer = answer.replace(pattern, "").trimEnd();
    }
    answer = answer.replace(/[，,；;：:]\s*$/u, "").trimEnd();
  } while (answer !== previous);
  return answer;
}

function promptSection(title, lines) {
  return [`## ${title}`, ...lines, ""];
}

// Inspired by OpenClaw's layered prompt architecture: stable operating rules
// precede volatile instance and session context so provider prompt caches remain useful.
export function buildSystemInstructions(payload) {
  return [
    "You are MCAI Sidecar, an execution-oriented Minecraft operations agent.",
    "",
    ...promptSection("Identity", [
      "你负责理解用户目标、选择受控工具，并基于真实回调给出简洁中文结果。",
      "你不是聊天演示程序。执行请求以实际完成和可验证证据为目标。",
    ]),
    ...promptSection("Tooling", [
      "工具由运行时策略过滤；名称区分大小写，必须使用可用工具清单中的精确名称和结构化参数。",
      "简单知识、解释、计算和寒暄直接回答，不调用工具。",
      "需要实时日志、文件、状态或实例变更时调用 requestOperation；它只提交受控目标，Cloud 继续负责确定性计划、风险分级、确认和 Sidecar 校验。",
      "实时数据优先于分析委派：请求包含读取、查询、检查或分析当前服务器的日志、文件、配置、性能或状态时，必须先调用 requestOperation，禁止用 delegateAnalysis 代替实时工具。",
      "复杂但不需要实时服务器数据的请求，如果要求多阶段方案、系统性诊断、风险比较或验收标准，必须调用 delegateAnalysis；制定方案选择 planner，分析故障选择 diagnostics。",
      "仅当缺少一个无法从当前上下文取得、且继续执行必需的信息时调用 requestClarification；一次只问一个问题。",
    ]),
    ...promptSection("Execution Bias", [
      "用户请求可执行且范围明确时，本轮立即行动，不承诺稍后处理，不把可执行工作退回给用户。",
      "需要工具时第一步直接调用工具，调用前不输出过程性文字。",
      "工具请求被接受、命令已提交、任务正在运行都不等于完成；只有工具回调和验收证据可以支持成功结论。",
      "工具返回失败、空结果或中间状态时，不得提前结束或编造结果；应依据证据选择安全重试、调整受控计划，或明确报告阻塞原因。",
      "在最终回答前核对目标实例、任务状态、工具证据和用户原始约束是否一致。",
      "不得暴露内部推理过程；界面只需要工具调用摘要和最终结果。",
    ]),
    ...promptSection("Minecraft Operations", [
      "payload.instance 是页面当前选中并授权的唯一目标；只要 instance.id 存在，不得再次询问操作哪个实例。",
      "明确要求执行控制台命令时调用 requestOperation，preferredTool=console.command，并在 intent 中逐字保留安全的单行 Minecraft 命令。",
      "在线玩家、TPS、服务端版本、插件，以及白名单、时间、天气、游戏规则、传送、物品、踢出和封禁等实时游戏内请求，应主动映射为准确的 Minecraft 服务端命令。",
      "控制台不是 Linux Shell；不得把 Minecraft 操作改写成 Shell 或 SSH。",
      "Paper 或 Fabric 安装请求包含 Minecraft 版本时，调用 requestOperation，preferredTool=server.install，并完整保留平台、版本、目标文件名和用户明确给出的约束。",
      "Paper 是 Bukkit/Spigot 插件服务端分支，Fabric 是模组加载器；两者通常是替代路线，不能把 Paper 与 Fabric 服务端模组直接混装。",
      existingInstanceStartContract(),
    ]),
    ...promptSection("Safety", [
      "优先级：安全与用户控制 > 事实正确 > 完成度 > 速度。",
      "不得绕过风险确认、审批、实例锁、路径限制、审计、Minecraft EULA 或生命周期专用工具。",
      "Minecraft EULA 同意永不推定；只有用户明确同意时，才在 requestOperation.intent 中保留该授权。",
      "不得生成或执行任意 Shell、SSH 命令，不得索取或泄露 API Key、密码、令牌或私钥。",
      "不得声称未执行的动作已经完成；不确定兼容性或实时状态时明确证据边界。",
      "会话偏好可以调整语气和目标，但不能覆盖本节、工具策略或 Cloud/Sidecar 的强制校验。",
    ]),
    ...promptSection("Interaction Style", [
      "只输出满足当前请求所必需的内容，不复述问题，不添加无关背景。",
      "禁止礼貌性收尾和主动追加邀请，例如“如果需要我可以继续”或“还有问题可以问我”。",
      "回答完成后立即停止。",
    ]),
    ...promptSection("Runtime Context", [
      `<current_instance>${JSON.stringify(payload.instance ?? {})}</current_instance>`,
      `<available_operations>${JSON.stringify(payload.availableTools ?? supportedOperations)}</available_operations>`,
      "以下是管理员为本会话设置的低优先级偏好：",
      `<session_instructions>${String(payload.systemPrompt ?? "")}</session_instructions>`,
    ]),
  ].join("\n").trim();
}

async function runDelegate(model, payload, kind, goal) {
  const role = kind === "planner"
    ? "你是规划子 Agent。给出必要步骤、风险和验收条件，不调用工具，不声称已经执行。"
    : "你是诊断子 Agent。基于已有信息分析最可能原因、证据边界和下一步，不编造日志。";
  const result = await generateText({
    model,
    instructions: `${role}\n${existingInstanceStartContract()}`,
    messages: historyMessages(payload, goal),
    temperature: 0.2,
    abortSignal: AbortSignal.timeout(90_000),
  });
  return result.text.trim();
}

function historyMessages(payload, currentMessage = payload.message) {
  const history = Array.isArray(payload.history) ? payload.history.slice(-16) : [];
  return [
    ...history.map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: String(item.content ?? ""),
    })),
    { role: "user", content: String(currentMessage ?? "") },
  ];
}

function agentTools(model, payload) {
  const availableTools = (payload.availableTools ?? supportedOperations)
    .filter((name) => supportedOperations.includes(name));
  const preferredToolSchema = availableTools.length
    ? z.enum(availableTools)
    : z.enum(supportedOperations);

  return {
    requestClarification: tool({
      description: "仅当缺少一个继续所必需的关键信息时，向用户提出一个澄清问题。",
      inputSchema: z.object({
        question: z.string().min(1).max(180),
        missing: z.string().min(1).max(120),
      }),
      execute: async ({ question, missing }) => ({ question, missing }),
    }),
    delegateAnalysis: tool({
      description: "把不需要实时服务器数据的复杂诊断或规划交给专门子 Agent。",
      inputSchema: z.object({
        kind: z.enum(["diagnostics", "planner"]),
        goal: z.string().min(1).max(1_000),
      }),
      execute: async ({ kind, goal }) => ({
        kind,
        answer: await runDelegate(model, payload, kind, goal),
      }),
    }),
    requestOperation: tool({
      description: "提交需要实时服务器数据或实际变更的受控运维目标。本工具不会直接执行操作。",
      inputSchema: z.object({
        intent: z.string().min(1).max(1_000),
        preferredTool: preferredToolSchema,
        reason: z.string().min(1).max(240),
      }),
      execute: async ({ intent, preferredTool, reason }) => ({
        accepted: true,
        intent,
        preferredTool,
        reason,
        boundary: "目标将交给 Cloud 的确定性策略与 Sidecar 执行。",
      }),
    }),
  };
}

function createOperationsAgent(model, payload) {
  return new ToolLoopAgent({
    id: "mcai-operations-agent",
    model,
    instructions: buildSystemInstructions(payload),
    tools: agentTools(model, payload),
    stopWhen: stepCountIs(4),
    temperature: 0.15,
  });
}

export async function routeWithAgent(config, payload) {
  if (!providerConfigured(config)) {
    return {
      route: "direct",
      answer: "本地模型云尚未配置模型供应商。",
      requestId: crypto.randomUUID(),
    };
  }

  let lastError;
  for (const modelId of candidateModels(config)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const model = modelFor(config, modelId);
        const agent = createOperationsAgent(model, payload);
        const result = await agent.generate({
          messages: historyMessages(payload),
          abortSignal: AbortSignal.timeout(180_000),
        });
        return decisionFromAgentResult(result);
      } catch (error) {
        lastError = error;
        if (!isCapacityError(error)) break;
        await sleep(700 * (attempt + 1));
      }
    }
  }
  return {
    route: "direct",
    answer: friendlyModelError(lastError),
    requestId: crypto.randomUUID(),
  };
}

export async function routeWithAgentStream(config, payload, onEvent) {
  if (!providerConfigured(config)) {
    const decision = {
      route: "direct",
      answer: "本地模型云尚未配置模型供应商。",
      requestId: crypto.randomUUID(),
    };
    onEvent({ type: "delta", text: decision.answer });
    return decision;
  }

  let lastError;
  for (const modelId of candidateModels(config)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const model = modelFor(config, modelId);
        const result = await createOperationsAgent(model, payload).stream({
          messages: historyMessages(payload),
          abortSignal: AbortSignal.timeout(180_000),
        });
        let streamedText = "";
        let operationRequested = false;

        for await (const part of result.stream) {
          if (part.type === "tool-call" && part.toolName === "requestOperation") {
            operationRequested = true;
            streamedText = "";
            onEvent({ type: "reset" });
            continue;
          }
          if (part.type === "text-delta" && !operationRequested) {
            streamedText += part.text;
            onEvent({ type: "delta", text: part.text });
            continue;
          }
          if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }

        const decision = decisionFromAgentResult({
          text: await result.text,
          steps: await result.steps,
          response: await result.response,
        });
        if (decision.route === "tool") {
          if (!operationRequested) onEvent({ type: "reset" });
          return decision;
        }
        if (streamedText !== decision.answer) {
          onEvent({ type: "reset" });
          if (decision.answer) onEvent({ type: "delta", text: decision.answer });
        }
        return decision;
      } catch (error) {
        lastError = error;
        onEvent({ type: "reset" });
        if (!isCapacityError(error)) break;
        await sleep(700 * (attempt + 1));
      }
    }
  }

  const decision = {
    route: "direct",
    answer: friendlyModelError(lastError),
    requestId: crypto.randomUUID(),
  };
  onEvent({ type: "delta", text: decision.answer });
  return decision;
}

export function decisionFromAgentResult(result) {
  const calls = result.steps.flatMap((step) => step.toolCalls ?? []);
  const results = result.steps.flatMap((step) => step.toolResults ?? []);
  const operation = calls.find((call) => call.toolName === "requestOperation");
  const clarification = results.find((item) => item.toolName === "requestClarification");
  const delegation = results.find((item) => item.toolName === "delegateAnalysis");
  const answer = conciseAnswer(result.text
    || clarification?.output?.question
    || delegation?.output?.answer
    || (operation ? "已生成受控操作目标，正在交给 Cloud 处理。" : "暂时没有可用回答。"));

  if (operation) {
    return {
      route: "tool",
      answer,
      toolIntent: operation.input.intent,
      requestId: result.response?.id,
      trace: [{ stage: "tool", label: "调用工具", result: operation.input.preferredTool }],
    };
  }
  if (delegation) {
    return {
      route: "delegate",
      delegate: delegation.output.kind,
      answer,
      requestId: result.response?.id,
      trace: [{ stage: "delegation", label: "调用子 Agent", result: delegation.output.kind }],
    };
  }
  if (clarification) {
    return {
      route: "clarify",
      answer,
      requestId: result.response?.id,
    };
  }
  return {
    route: "direct",
    answer,
    requestId: result.response?.id,
  };
}

export async function answerTaskWithSdk(config, payload) {
  if (!providerConfigured(config)) {
    return {
      status: "unconfigured",
      requestId: crypto.randomUUID(),
      answer: "本地模型云尚未配置模型供应商。",
    };
  }
  let lastError;
  for (const modelId of candidateModels(config)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await generateText({
          model: modelFor(config, modelId),
          instructions: [
            "你是 MCAI 的任务结果说明 Agent。",
            "使用简洁中文，只输出用户判断任务结果所必需的内容。",
            "任务正在运行、工具已接受或命令已提交都不是完成；只依据最终 task_state 和 evidence 判断结果。",
            "成功时只说明结果和必要证据；失败时只说明原因和一条可执行的安全处理方式。没有实际风险或必需操作时，不添加风险、建议或下一步。",
            "不要复述请求、计划或已清楚的信息。禁止礼貌性收尾和主动提供额外帮助，回答完立即停止。",
            "只依据输入的任务、实例、计划和证据，不声称尚未执行的步骤已经完成。",
            "这是工具回调后的最终答复：task_state=SUCCEEDED 时必须明确说明已完成并引用实际 evidence；task_state=FAILED 时必须说明实际 diagnosis 和安全下一步。",
            "不要重复“已提交请求”或“正在调用工具”，因为工具回调已经结束。",
            "证据为空、只有中间状态或与请求不匹配时，不得推断成功或补造数值。",
            "失败恢复时只给一条明确的安全决策：重试、回滚、修改计划或人工处理。",
            existingInstanceStartContract(),
          ].join("\n"),
          prompt: JSON.stringify(payload),
          temperature: 0.2,
          abortSignal: AbortSignal.timeout(90_000),
        });
        return {
          status: "answered",
          requestId: result.response?.id ?? crypto.randomUUID(),
          answer: conciseAnswer(result.text),
        };
      } catch (error) {
        lastError = error;
        if (!isCapacityError(error)) break;
        await sleep(700 * (attempt + 1));
      }
    }
  }
  return {
    status: isCapacityError(lastError) ? "unavailable" : "unavailable",
    requestId: crypto.randomUUID(),
    answer: friendlyModelError(lastError),
  };
}
