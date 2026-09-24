import type { ConversationMessage, TaskRecord, TaskState } from "@mcai/contracts";

const terminalStates = new Set<TaskState>([
  "SUCCEEDED", "PARTIAL", "WAITING", "FAILED", "ROLLED_BACK", "REJECTED",
  "CANCELLED", "EXPIRED", "MANUAL_INTERVENTION",
]);

export function isTerminalTask(state: TaskState | string) {
  return terminalStates.has(state as TaskState);
}

export function taskPresentation(state: TaskState | string) {
  if (state === "SUCCEEDED") return { eyebrow: "DONE", title: "任务已完成", tone: "success" as const };
  if (state === "PARTIAL") return { eyebrow: "PARTIAL", title: "任务部分完成", tone: "warning" as const };
  if (state === "WAITING" || state === "WAITING_CONFIRMATION") return { eyebrow: "WAITING", title: state === "WAITING_CONFIRMATION" ? "等待审批" : "等待补全计划", tone: "warning" as const };
  if (isTerminalTask(state)) return { eyebrow: "FAILED", title: "任务未完成", tone: "failed" as const };
  return { eyebrow: "OUTPUT", title: "任务执行中", tone: "live" as const };
}

export function redactTaskId(id: string) {
  if (id.length <= 20) return id;
  return `${id.slice(0, 12)}…${id.slice(-6)}`;
}

export function recoveredMessageForRequest(messages: ConversationMessage[], requestId: string) {
  return [...messages].reverse().find((message) => message.role === "assistant" && message.request_id === requestId);
}

export function streamRecoveryState(messages: ConversationMessage[], tasks: TaskRecord[], requestId: string) {
  const message = recoveredMessageForRequest(messages, requestId);
  const task = message?.task_id ? tasks.find((candidate) => candidate.id === message.task_id) : undefined;
  if (message) return { recovered: true, message, task, retryAllowed: false } as const;
  const persistedUser = messages.some((candidate) => candidate.role === "user" && candidate.request_id === requestId);
  return { recovered: false, persistedUser, retryAllowed: !persistedUser } as const;
}

export function taskApprovalLabel(task: TaskRecord) {
  if (task.state === "WAITING_CONFIRMATION") return "等待用户审批";
  if (task.plan.operation.requires_confirmation) return "已通过计划级审批门禁";
  return "只读任务，无需审批";
}

export function deterministicAcceptanceLabel(task: TaskRecord) {
  if (task.state === "SUCCEEDED" && task.plan.coverage === "full") return "全部原始目标与回答覆盖检查通过";
  if (task.state === "PARTIAL") return "原始目标仅部分满足";
  if (task.state === "WAITING") return "原始目标尚未形成完整计划";
  return "原始目标验收失败";
}
