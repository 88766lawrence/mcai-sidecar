import type { TaskRecord } from "@mcai/contracts";

const internalTerms = /(?:INTENT_COMPILER_[A-Z_]+|typed intent compiler|model gateway|\bgateway\b|\bprovider\b|JSON schema|\bschema\b|\bdigest\b|SourceGoal|SourceAtom|Clause(?:Role)?|stack trace|internal exception)/i;
const chineseSuccessClaims = /(?:(?:已|已经)(?:成功)?(?:安装|下载|重启|写入|落盘|修改|配置|部署|更新)|成功(?:完成|执行)?(?:安装|下载|重启|写入|落盘|修改|配置|部署|更新)|(?:安装|下载|重启|写入|落盘|修改|配置|部署|更新)(?:已经|已)?(?:成功)?(?:完成|执行|了)|(?:命令|操作|任务)(?:已经|已)?(?:成功)?(?:执行|完成)|(?:已|已经)(?:成功)?(?:执行|完成)(?:了)?(?:安装|下载|重启|写入|落盘|修改|配置|部署|更新|命令|操作|任务))/i;
const englishSuccessClaims = /(?:\b(?:server|instance|plugin|mod|configuration|config|file|backup|deployment|world|whitelist|rule|task|operation)\b[^.!?]{0,48}\b(?:installed|downloaded|restarted|written|saved|modified|configured|deployed|updated|executed|completed|finished)\b|\b(?:installed|downloaded|restarted|written|saved|modified|configured|deployed|updated|executed)\b[^.!?]{0,48}\b(?:server|instance|plugin|mod|configuration|config|file|backup|deployment|world|whitelist|rule)\b)/i;
const evidenceFollowUp = /^(?:你?确定(?:吗|么)?|真的(?:吗|么)?|确认(?:吗|么)?|成功了(?:吗|么)?|装好(?:了吗|了么)?|安装好(?:了吗|了么)?|完成了(?:吗|么)?|做好(?:了吗|了么)?|did\s+(?:it|that)\s+(?:work|finish|succeed)|is\s+it\s+(?:done|installed))\s*[?？。.!！]*$/i;
const providerIdentity = /(?:MiniMax(?:-[A-Za-z0-9.]+)?|OpenAI|ChatGPT|Anthropic|Claude|Google\s+Gemini|Gemini|DeepSeek|Qwen|通义千问|Moonshot|Kimi)/i;
const chineseSelfIdentity = /(?:^|[。！？!?]\s*)(?:我是|我叫|作为)(?:由|来自)?[^。！？!?]{0,64}(?:开发|训练|打造|提供|驱动|模型|助手)/i;
const englishSelfIdentity = /(?:^|[.!?]\s*)(?:I\s+am|I'm|As)\b[^.!?]{0,96}(?:developed|trained|built|created|provided|powered|model|assistant)/i;

export function containsInternalTerm(value: string) {
  return internalTerms.test(value);
}

export function claimsExecutionSuccess(value: string) {
  const withoutHonestNegation = value.replace(/(?:没有|未|尚未|无法|不能|并未|not|didn't|hasn't|cannot|can't)[^。.!！]{0,48}/gi, "");
  return chineseSuccessClaims.test(withoutHonestNegation) || englishSuccessClaims.test(withoutHonestNegation);
}

export function safeUserText(value: string | undefined, fallback: string) {
  const text = value?.trim() ?? "";
  return !text || containsInternalTerm(text) ? fallback : text;
}

export function projectProductIdentity(value: string) {
  if (!providerIdentity.test(value) || (!chineseSelfIdentity.test(value) && !englishSelfIdentity.test(value))) return value;
  return /[\u3400-\u9fff]/u.test(value)
    ? "我是 MCAI，一名专注于 Minecraft 服务器管理与运维的 AI 助手。"
    : "I'm MCAI, an AI assistant for Minecraft server administration and operations.";
}

export function guardDirectWithoutEvidence(value: string) {
  const safe = projectProductIdentity(safeUserText(value, "我暂时没能理解这条请求，因此没有执行任何操作。请把要做的事说完整一些。"));
  return claimsExecutionSuccess(safe)
    ? "我还没有执行，无法确认操作已经完成。"
    : safe;
}

export function isEvidenceQuestion(value: string) {
  return evidenceFollowUp.test(value.trim());
}

export function answerEvidenceQuestion(task: TaskRecord | undefined, priorContext: string) {
  const pluginContext = /(?:插件|模组|plugin|mod|安装|下载|落盘)/i.test(priorContext);
  const unproven = pluginContext
    ? "不能确定。上一条没有实际工具执行记录，因此无法证明插件已安装或文件已落盘。"
    : "不能确定。上一条没有实际工具执行记录，因此无法证明操作已经完成。";
  if (!task || task.state !== "SUCCEEDED") return unproven;
  const usable = task.evidence.filter((item) => item.kind !== "state"
    && item.tool_calls !== 0
    && item.result !== "contradiction"
    && item.result !== "insufficient");
  const matches = (kind: string) => usable.some((item) => item.kind === kind);
  const execution = task.plan.operation.execution_evidence ?? [];
  const verification = task.plan.operation.verification_evidence ?? [];
  if (!execution.length || !execution.every((item) => matches(item.kind)) || !verification.every((item) => matches(item.kind))) return unproven;
  const summaries = usable.map((item) => safeUserText(item.summary, "")).filter(Boolean).slice(-3);
  return summaries.length
    ? `可以确认。最近任务有真实执行${verification.length ? "和复验" : ""}记录：${summaries.join("；")}`
    : "可以确认。最近任务已成功，并且具备对应的真实执行证据。";
}

export function safeTaskAnswer(value: string | undefined, state: TaskRecord["state"], hasEvidence: boolean) {
  const fallback = state === "WAITING_CONFIRMATION"
    ? "计划已准备，等待你确认后才会执行。"
    : state === "WAITING" || state === "REJECTED" || state === "FAILED"
      ? "我暂时没能理解或安全执行这条请求，因此没有执行任何操作。请把要做的事说完整一些。"
      : "任务正在处理，完成情况将以真实工具结果为准。";
  const safe = safeUserText(value, fallback);
  return !hasEvidence && claimsExecutionSuccess(safe) ? fallback : safe;
}
