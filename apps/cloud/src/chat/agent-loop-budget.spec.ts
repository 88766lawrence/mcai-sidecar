import { describe, expect, it } from "vitest";
import type { AgentRunCallRecord, AgentRunRecord } from "@mcai/contracts";
import type { AgentLoopObservation, AgentLoopToolCall } from "./agent-loop";
import { agentRunBudgetExhausted, canExecuteAgentCall, transientAgentDecisionError } from "./chat.service";

describe("agent loop budgets and repeat recovery", () => {
  const decision: AgentLoopToolCall = { action: "tool_call", tool: "files.list", arguments: { path: "/world/stats" }, reason: "read stats" };
  const prior: AgentRunCallRecord = { id: "call-1", key: 'files.list:{"path":"/world/stats"}', tool: "files.list", arguments: { path: "/world/stats" }, reason: "read stats" };

  it("allows exactly one same-call retry only for a retryable no-side-effect failure", () => {
    expect(canExecuteAgentCall({ calls: [prior] }, decision, [observation("failed", true, "none")])).toBe(true);
    expect(canExecuteAgentCall({ calls: [prior, { ...prior, id: "call-2" }] }, decision, [observation("failed", true, "none")])).toBe(false);
    expect(canExecuteAgentCall({ calls: [prior] }, decision, [observation("failed", false, "none")])).toBe(false);
    expect(canExecuteAgentCall({ calls: [prior] }, decision, [observation("failed", true, "possible")])).toBe(false);
    expect(canExecuteAgentCall({ calls: [prior] }, decision, [observation("succeeded", false, "none")])).toBe(false);
    expect(canExecuteAgentCall({ calls: [prior] }, { ...decision, arguments: { path: "/world/advancements" } }, [observation("failed", false, "none")])).toBe(true);
    expect(canExecuteAgentCall({ calls: [prior] }, { action: "tool_call", tool: "console.command", arguments: { command: "list" }, reason: "use another read" }, [observation("failed", false, "none")])).toBe(true);
  });

  it("stops at round or tool budget without dropping finalization after slow tools", () => {
    const now = Date.now();
    expect(agentRunBudgetExhausted(budget(8, 1, now), now)).toBe(false);
    expect(agentRunBudgetExhausted(budget(16, 1, now), now)).toBe(true);
    expect(agentRunBudgetExhausted(budget(2, 19, now), now)).toBe(true);
    expect(agentRunBudgetExhausted(budget(2, 2, now - 120_001), now)).toBe(false);
    expect(agentRunBudgetExhausted(budget(7, 18, now - 119_999), now)).toBe(false);
  });

  it("allows one schema correction but blocks a third same-tool same-error attempt even when arguments drift", () => {
    const calls: AgentRunCallRecord[] = [
      { ...prior, id: "call-1", key: 'logs.query:{"filters":["oom"]}', tool: "logs.query", arguments: { filters: ["oom"] } },
      { ...prior, id: "call-2", key: 'logs.query:{"filters":["heap"]}', tool: "logs.query", arguments: { filters: ["heap"] } },
    ];
    const observations: AgentLoopObservation[] = [
      { ...observation("failed", false, "none"), tool_call_id: "call-1", tool: "logs.query", error: { code: "INVALID_LOG_FILTER_QUERY", message: "missing groups" } },
      { ...observation("failed", false, "none"), tool_call_id: "call-2", tool: "logs.query", error: { code: "INVALID_LOG_FILTER_QUERY", message: "missing groups" } },
    ];
    const correction: AgentLoopToolCall = { action: "tool_call", tool: "logs.query", arguments: { filter_query: { groups: [] } }, reason: "correct schema" };
    expect(canExecuteAgentCall({ calls: calls.slice(0, 1) }, correction, observations.slice(0, 1))).toBe(true);
    expect(canExecuteAgentCall({ calls }, correction, observations)).toBe(false);
  });

  it("retries only transport/transient initial decision errors", () => {
    expect(transientAgentDecisionError("AGENT_LOOP_PROVIDER_TIMEOUT")).toBe(true);
    expect(transientAgentDecisionError("AGENT_LOOP_HTTP_503")).toBe(true);
    expect(transientAgentDecisionError("AGENT_LOOP_INVALID_RESPONSE")).toBe(false);
    expect(transientAgentDecisionError("AGENT_LOOP_INCOMPLETE_CITATION")).toBe(false);
  });

  function observation(status: AgentLoopObservation["status"], retryable: boolean, sideEffect: AgentLoopObservation["side_effect"]): AgentLoopObservation {
    return { tool_call_id: "call-1", tool: "files.list", status, retryable, side_effect: sideEffect, evidence: { ids: ["e1"], summaries: ["provider result"] } };
  }
  function budget(rounds: number, calls: number, created: number) {
    return { round_count: rounds, tool_call_count: calls, created_at: new Date(created).toISOString() } as Pick<AgentRunRecord, "round_count" | "tool_call_count" | "created_at">;
  }
});
