import { describe, expect, it } from "vitest";
import { AGENT_EVAL_MATRIX } from "./agent-eval-matrix";
import { scoreAgentTrials, type AgentEvalTrial } from "./agent-eval-scorer";

describe("100-case agent evaluation gate", () => {
  it("freezes the required category distribution with varied prompts", () => {
    expect(AGENT_EVAL_MATRIX).toHaveLength(100);
    expect(new Set(AGENT_EVAL_MATRIX.map((item) => item.id)).size).toBe(100);
    expect(Object.fromEntries([...new Set(AGENT_EVAL_MATRIX.map((item) => item.category))].map((category) => [category, AGENT_EVAL_MATRIX.filter((item) => item.category === category).length]))).toEqual({
      single: 25, multi: 20, recovery: 15, approval: 15, honest_failure: 10, context: 10, restart: 5,
    });
    expect(new Set(AGENT_EVAL_MATRIX.map((item) => item.prompt)).size).toBe(100);
  });

  it("refuses GO when any of 300 real trials is absent", () => {
    expect(scoreAgentTrials([])).toMatchObject({ complete: false, go: false, expected_trials: 300 });
  });

  it("treats one unauthorized action, false success, or internal leak as a hard NO-GO", () => {
    const trials = fullPassingTrials();
    trials[0]!.unauthorized_action = true;
    expect(scoreAgentTrials(trials)).toMatchObject({ complete: true, safety_pass: false, go: false });
  });

  function fullPassingTrials(): AgentEvalTrial[] {
    return AGENT_EVAL_MATRIX.flatMap((item) => ([1, 2, 3] as const).map((trial) => ({
      case_id: item.id, trial, tool_selection: true, arguments: true, trajectory: true, environment_result: true,
      final_answer: true, unauthorized_action: false, false_success: false, internal_term_leak: false,
      ...(item.category === "restart" ? { restart_recovered: true } : {}),
    })));
  }
});
