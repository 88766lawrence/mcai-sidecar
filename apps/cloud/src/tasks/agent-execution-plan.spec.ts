import { describe, expect, it } from "vitest";
import { validateAgentToolCall } from "../chat/agent-loop";
import { buildAgentDirectExecutionPlan } from "./agent-execution-plan";
import { validatePlanCompatibility } from "./plan-compatibility";

function directPlan() {
  const checked = validateAgentToolCall({
    action: "tool_call",
    tool: "files.list",
    arguments: { path: "/world/playerdata", suffix: ".dat" },
    reason: "Inspect the selected directory.",
  }, "mcs:daemon:instance");
  if (!checked.ok) throw new Error(checked.message);
  return buildAgentDirectExecutionPlan(
    "mcs:daemon:instance",
    "revision-direct-1",
    "A novel sentence that the retired planner does not need to understand.",
    "call-direct-1",
    checked.value,
  );
}

describe("agent direct execution plan", () => {
  it("binds an AI-selected tool without creating a legacy semantic ledger", () => {
    const plan = directPlan();
    expect(plan).toMatchObject({
      execution_mode: "agent_direct",
      agent_execution: {
        schema_version: "agent-tool-execution/v1",
        tool_call_id: "call-direct-1",
        tool: "files.list",
        arguments: { path: "world/playerdata", suffix: ".dat" },
      },
      coverage: "full",
      clause_ledger: [], source_atoms: [], source_goals: [], goal_requirements: [], constraints: [],
    });
    expect(validatePlanCompatibility(plan)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    ["tool", (plan: ReturnType<typeof directPlan>) => { plan.agent_execution!.tool = "config.inspect"; }],
    ["arguments", (plan: ReturnType<typeof directPlan>) => { plan.agent_execution!.arguments = { path: "/plugins" }; }],
    ["instance", (plan: ReturnType<typeof directPlan>) => { plan.agent_execution!.instance_ref = "mcs:other"; }],
    ["revision", (plan: ReturnType<typeof directPlan>) => { plan.agent_execution!.inventory_revision = "revision-other"; }],
    ["policy", (plan: ReturnType<typeof directPlan>) => { plan.agent_execution!.policy_digest = "tampered"; }],
    ["operation digest", (plan: ReturnType<typeof directPlan>) => { plan.agent_execution!.operation_digest = "tampered"; }],
    ["legacy goal", (plan: ReturnType<typeof directPlan>) => { plan.source_goals.push({} as never); }],
  ])("rejects %s tampering", (_name, mutate) => {
    const plan = directPlan();
    mutate(plan);
    expect(validatePlanCompatibility(plan)).toEqual(expect.objectContaining({ ok: false, code: "INVALID_AGENT_EXECUTION" }));
  });
});
