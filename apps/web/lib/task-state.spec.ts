import { describe, expect, it } from "vitest";
import type { ConversationMessage, TaskRecord, TaskState } from "@mcai/contracts";
import { deterministicAcceptanceLabel, isTerminalTask, redactTaskId, streamRecoveryState, taskApprovalLabel, taskPresentation } from "./task-state";

describe("authoritative task presentation", () => {
  it.each([
    ["SUCCEEDED", "DONE", "任务已完成"],
    ["PARTIAL", "PARTIAL", "任务部分完成"],
    ["WAITING", "WAITING", "等待补全计划"],
    ["WAITING_CONFIRMATION", "WAITING", "等待审批"],
    ["FAILED", "FAILED", "任务未完成"],
    ["REJECTED", "FAILED", "任务未完成"],
    ["EXECUTING", "OUTPUT", "任务执行中"],
  ] satisfies Array<[TaskState, string, string]>) ("maps %s without false DONE", (state, eyebrow, title) => {
    expect(taskPresentation(state)).toMatchObject({ eyebrow, title });
  });

  it.each(["SUCCEEDED", "PARTIAL", "WAITING", "FAILED", "ROLLED_BACK"] satisfies TaskState[])("treats %s as authoritative terminal", (state) => {
    expect(isTerminalTask(state)).toBe(true);
  });

  it("redacts a long task id but leaves a short public id readable", () => {
    expect(redactTaskId("task_123456789012345678901234567890")).toBe("task_1234567…567890");
    expect(redactTaskId("task_public_01")).toBe("task_public_01");
  });
});

describe("SSE persisted-result recovery", () => {
  const requestId = "request_12345678";
  const assistant = { id: "a1", session_id: "s1", request_id: requestId, role: "assistant", content: "result", task_id: "t1", created_at: "now" } as ConversationMessage;
  const user = { id: "u1", session_id: "s1", request_id: requestId, role: "user", content: "goal", created_at: "now" } as ConversationMessage;

  it("recovers an answer after a successful task stream abort and forbids duplicate send", () => {
    const state = streamRecoveryState([user, assistant], [{ id: "t1" } as TaskRecord], requestId);
    expect(state).toMatchObject({ recovered: true, retryAllowed: false, task: { id: "t1" } });
  });

  it("forbids duplicate send while only the persisted user request is visible", () => {
    expect(streamRecoveryState([user], [], requestId)).toMatchObject({ recovered: false, persistedUser: true, retryAllowed: false });
  });

  it("allows a fresh attempt only when the server persisted nothing", () => {
    expect(streamRecoveryState([], [], requestId)).toMatchObject({ recovered: false, persistedUser: false, retryAllowed: true });
  });

  it.each([
    ["WAITING_CONFIRMATION", "等待用户审批"],
    ["SUCCEEDED", "已通过计划级审批门禁"],
  ] satisfies Array<[TaskState, string]>) ("shows approval truth for %s", (state, label) => {
    const task = { state, plan: { operation: { requires_confirmation: true } } } as TaskRecord;
    expect(taskApprovalLabel(task)).toBe(label);
  });

  it("labels a read task as not requiring approval", () => {
    const task = { state: "SUCCEEDED", plan: { operation: { requires_confirmation: false } } } as TaskRecord;
    expect(taskApprovalLabel(task)).toBe("只读任务，无需审批");
  });

  it.each([
    ["SUCCEEDED", "全部原始目标与回答覆盖检查通过"],
    ["PARTIAL", "原始目标仅部分满足"],
    ["WAITING", "原始目标尚未形成完整计划"],
    ["FAILED", "原始目标验收失败"],
  ] satisfies Array<[TaskState, string]>) ("uses authoritative source-goal wording for %s", (state, expected) => {
    const task = { state, plan: { coverage: state === "SUCCEEDED" ? "full" : "partial" } } as TaskRecord;
    expect(deterministicAcceptanceLabel(task)).toBe(expected);
  });
});
