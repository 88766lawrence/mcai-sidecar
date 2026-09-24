import { describe, expect, it } from "vitest";
import { claimsExecutionSuccess, guardDirectWithoutEvidence, projectProductIdentity } from "./user-safe-response";

describe("direct-answer execution evidence guard", () => {
  it.each([
    "我已经理解你的偏好，我们可以继续讨论方向。",
    "目前已经有两个候选方案，但还没有进行外部操作。",
    "根据本会话已完成的只读结果：difficulty = easy，查询结果已经确认。",
    "只读检查已经完成，ERROR 和 WARN 的命中数量都是 0。",
    "The discussion finished with two possible directions.",
  ])("does not treat ordinary conversational completion as an external mutation: %s", (answer) => {
    expect(claimsExecutionSuccess(answer)).toBe(false);
    expect(guardDirectWithoutEvidence(answer)).toBe(answer);
  });

  it.each([
    "BlueMap 已安装完成。",
    "服务器已经重启。",
    "配置已成功修改。",
    "命令已执行。",
    "这项操作已经完成。",
    "The plugin was installed.",
  ])("blocks an unproven external execution claim: %s", (answer) => {
    expect(claimsExecutionSuccess(answer)).toBe(true);
    expect(guardDirectWithoutEvidence(answer)).toBe("我还没有执行，无法确认操作已经完成。");
  });

  it("keeps an honestly negated execution statement", () => {
    const answer = "服务器尚未重启，因此当前配置还没有生效。";
    expect(claimsExecutionSuccess(answer)).toBe(false);
    expect(guardDirectWithoutEvidence(answer)).toBe(answer);
  });

  it.each([
    ["我是 MiniMax 开发的 MiniMax-M3，Minecraft 运维助手。", "我是 MCAI，一名专注于 Minecraft 服务器管理与运维的 AI 助手。"],
    ["I'm an AI assistant developed by Anthropic and powered by Claude.", "I'm MCAI, an AI assistant for Minecraft server administration and operations."],
  ])("projects provider self-identification to the product identity: %s", (answer, expected) => {
    expect(projectProductIdentity(answer)).toBe(expected);
    expect(guardDirectWithoutEvidence(answer)).toBe(expected);
  });

  it.each([
    "MiniMax supports native tool calling.",
    "Gemini is a model family from Google.",
    "我们正在比较 Claude 和 ChatGPT 的特点。",
  ])("does not rewrite ordinary discussion of model providers: %s", (answer) => {
    expect(projectProductIdentity(answer)).toBe(answer);
  });
});
