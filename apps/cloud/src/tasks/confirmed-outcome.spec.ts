import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { classifyConsoleCommandOutcome } from "@mcai/contracts";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { TasksService } from "./tasks.service";

function fixture(state: "running" | "stopped" = "stopped", nowRef = { value: Date.parse("2026-08-06T08:00:00.000Z") }) {
  const store = new CloudStore();
  store.instances.set("mcs:node:world", {
    instance_id: "mcs:node:world", name: "World", platform: "paper", minecraft_version: "1.21.1",
    state, profile_revision: "rev-a", provider_type: "mcsmanager", collected_at: new Date(nowRef.value).toISOString(),
    tenant_id: "tenant-a", agent_id: "agent-a",
  });
  const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
  const model = { answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
  return { store, connections, service: new TasksService(store, connections, model, {
    now: () => nowRef.value, watchdogIntervalMs: 0, stageTimeoutMs: { VERIFYING: 100 },
  }), nowRef };
}

function proof(task: Awaited<ReturnType<TasksService["create"]>>) {
  const confirmation = task.plan.confirmed_operation!;
  const step = confirmation.steps[0];
  return {
    task_id: task.id, step_id: step.id, tool: step.tool, target: step.target, parameters: step.parameters,
    operation_digest: confirmation.operation_digest, confirmation_digest: confirmation.summary_digest,
  };
}

function consoleProof(task: Awaited<ReturnType<TasksService["create"]>>, summary: string, drift: Record<string, unknown> = {}) {
  return {
    ...proof(task), kind: "console", summary,
    command_outcome: {
      ...classifyConsoleCommandOutcome(summary, true),
      output_sha256: createHash("sha256").update(summary).digest("hex"),
      ...drift,
    },
  };
}

async function confirmedLifecycle(service: TasksService, tool: "instance.start" | "instance.stop" | "instance.restart") {
  const words = { "instance.start": "Start the bound service", "instance.stop": "Stop the bound service", "instance.restart": "Restart the bound service" };
  const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: words[tool], preferredTool: tool, assistantResponse: "Awaiting confirmation", modelStatus: "answered" });
  const issued = service.issueConfirmation(task.id, "tenant-a");
  service.confirm(task.id, "tenant-a", issued.token);
  return task;
}

describe("confirmed-operation execution outcome convergence", () => {
  it("keeps a successful lifecycle callback VERIFYING until delayed inventory reaches the expected state", async () => {
    const { service } = fixture("stopped");
    const task = await confirmedLifecycle(service, "instance.start");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "pending" })]);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), kind: "instance", summary: "start request accepted" });
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "Executed successfully; not independently verified" });
    expect(task.state).toBe("VERIFYING");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "pending" })]);

    service.recordInventoryProfiles([{ instance_id: task.instance_ref, state: "running", profile_revision: "rev-b" }]);
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "satisfied" })]);
    expect(task.goal_results).toEqual([expect.objectContaining({ status: "satisfied", observed: "running" })]);
    expect(task.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "instance", step_id: "s1", result: "match" }),
      expect.objectContaining({ kind: "verification.instance_state", expected: "running", observed: "running", result: "match" }),
    ]));
  });

  it("times out an accepted lifecycle request honestly instead of failing immediately", async () => {
    const { service, nowRef } = fixture("stopped");
    const task = await confirmedLifecycle(service, "instance.start");
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), kind: "instance", summary: "start request accepted" });
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "callback complete" });
    expect(task.state).toBe("VERIFYING");
    nowRef.value += 101;
    service.sweepExpiredTasks(nowRef.value);
    expect(task.state).toBe("FAILED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(task.evidence.at(-1)?.summary).toContain("请求已接受但未能确认最终状态");
  });

  it.each([
    ["instance.stop" as const, "running" as const, "stopped" as const],
    ["instance.restart" as const, "running" as const, "running" as const],
  ])("converges %s only after its own expected inventory state", async (tool, initial, expected) => {
    const { service } = fixture(initial);
    const task = await confirmedLifecycle(service, tool);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), kind: "instance", summary: "request accepted" });
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "callback complete" });
    expect(task.state).toBe("VERIFYING");
    service.recordInventoryProfiles([{ instance_id: task.instance_ref, state: expected, profile_revision: "rev-next" }]);
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_results[0]).toMatchObject({ status: "satisfied", observed: expected });
  });

  it("keeps a failed provider callback FAILED with its real reason", async () => {
    const { service } = fixture("stopped");
    const task = await confirmedLifecycle(service, "instance.start");
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), state: "FAILED", kind: "tool", summary: "panel returned HTTP 503" });
    expect(task.state).toBe("FAILED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(task.evidence.some((item) => item.summary.includes("HTTP 503"))).toBe(true);
  });

  it("ignores duplicate and contradictory late events after lifecycle success", async () => {
    const { service } = fixture("stopped");
    const task = await confirmedLifecycle(service, "instance.start");
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), kind: "instance", summary: "accepted" });
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "done" });
    service.recordInventoryProfiles([{ instance_id: task.instance_ref, state: "running", profile_revision: "rev-b" }]);
    const evidenceCount = task.evidence.length;
    await service.recordAgentEvent({ ...proof(task), state: "FAILED", kind: "tool", summary: "late contradiction" });
    service.recordInventoryProfiles([{ instance_id: task.instance_ref, state: "stopped", profile_revision: "rev-c" }]);
    expect(task.state).toBe("SUCCEEDED");
    expect(task.evidence).toHaveLength(evidenceCount);
  });

  it("completes an exact console callback while stating that the effect was not independently verified", async () => {
    const { store, connections } = fixture("running");
    const model = {
      proposeConfirmedWrite: vi.fn().mockResolvedValue({
        status: "answered", requestId: "proposal-generic", providerModel: "fixture",
        proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: "gamerule doDaylightCycle false" }, summary: "Awaiting confirmation" },
      }),
      compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model, { watchdogIntervalMs: 0 });
    const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: "Disable the daylight cycle" });
    const issued = service.issueConfirmation(task.id, "tenant-a");
    service.confirm(task.id, "tenant-a", issued.token);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent(consoleProof(task, "command accepted"));
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "executed" });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "satisfied" })]);
    await expect(service.complete(task.id, "tenant-a")).resolves.toMatchObject({
      status: "answered", answer: expect.stringContaining("未独立验证效果"),
    });
  });

  it.each([
    `title @a actionbar {"text":"Tournament begins soon"}`,
    `title @a title {"text":"Tournament begins now"}`,
  ])("fails a confirmed player display when the callback proves that no target received it: %s", async (command) => {
    const { store, connections } = fixture("running");
    const model = {
      proposeConfirmedWrite: vi.fn().mockResolvedValue({
        status: "answered", requestId: "proposal-zero-target", providerModel: "fixture",
        proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command }, summary: "Awaiting confirmation" },
      }),
      compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn().mockResolvedValue("No retry"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model, { watchdogIntervalMs: 0 });
    const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: `console command: ${command}` });
    const issued = service.issueConfirmation(task.id, "tenant-a");
    service.confirm(task.id, "tenant-a", issued.token);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent(consoleProof(task, "控制台返回：\nNo entities were found"));
    expect(task.state).toBe("FAILED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(task.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "console", result: "contradiction", command_outcome: expect.objectContaining({ code: "NO_TARGETS", status: "rejected" }) }),
    ]));
    await expect(service.complete(task.id, "tenant-a")).resolves.toMatchObject({
      answer: "没有找到在线玩家，因此没有人收到提示。",
    });
  });

  it("fails closed when a confirmed write callback is only a transport fragment", async () => {
    const { store, connections } = fixture("running");
    const model = {
      proposeConfirmedWrite: vi.fn().mockResolvedValue({
        status: "answered", requestId: "proposal-fragment", providerModel: "fixture",
        proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: `tellraw @a {"text":"Doors open soon"}` }, summary: "Awaiting confirmation" },
      }),
      compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn().mockResolvedValue("No retry"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model, { watchdogIntervalMs: 0 });
    const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: `console command: tellraw @a {"text":"Doors open soon"}` });
    const issued = service.issueConfirmation(task.id, "tenant-a");
    service.confirm(task.id, "tenant-a", issued.token);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent(consoleProof(task, "控制台返回：\nt"));
    expect(task.state).toBe("FAILED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(task.evidence.find((item) => item.kind === "console")).toMatchObject({
      result: "contradiction",
      command_outcome: expect.objectContaining({ status: "indeterminate", code: "INCOMPLETE_CALLBACK" }),
    });
    await expect(service.complete(task.id, "tenant-a")).resolves.toMatchObject({
      answer: expect.stringContaining("无法确认"),
    });
  });

  it("fails closed when the reported outcome conflicts with the raw callback", async () => {
    const { store, connections } = fixture("running");
    const model = {
      proposeConfirmedWrite: vi.fn().mockResolvedValue({
        status: "answered", requestId: "proposal-conflict", providerModel: "fixture",
        proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: "say Server check" }, summary: "Awaiting confirmation" },
      }),
      compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn().mockResolvedValue("No retry"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model, { watchdogIntervalMs: 0 });
    const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: "Broadcast a server check" });
    const issued = service.issueConfirmation(task.id, "tenant-a");
    service.confirm(task.id, "tenant-a", issued.token);
    await service.recordAgentEvent(consoleProof(task, "控制台返回：\n[Server] Server check", { status: "rejected", code: "NO_TARGETS" }));
    expect(task.state).toBe("FAILED");
    expect(task.evidence.find((item) => item.kind === "console")).toMatchObject({ result: "contradiction" });
  });

  it("independently reconstructs a console outcome when the Agent projection is omitted", async () => {
    const { store, connections } = fixture("running");
    const model = {
      proposeConfirmedWrite: vi.fn().mockResolvedValue({
        status: "answered", requestId: "proposal-missing-outcome", providerModel: "fixture",
        proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: "say Maintenance begins in five minutes" }, summary: "Awaiting confirmation" },
      }),
      compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn().mockResolvedValue("No retry"),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model, { watchdogIntervalMs: 0 });
    const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: "Broadcast a maintenance notice" });
    const issued = service.issueConfirmation(task.id, "tenant-a");
    service.confirm(task.id, "tenant-a", issued.token);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), kind: "console", summary: "[Server] Maintenance begins in five minutes" });
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "executed" });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.evidence.find((item) => item.kind === "console")).toMatchObject({
      result: "match", command_outcome: expect.objectContaining({ status: "applied", code: "EXPLICIT_SUCCESS" }),
    });
  });

  it("keeps an explicit successful say callback on the successful adjacent path", async () => {
    const { store, connections } = fixture("running");
    const model = {
      proposeConfirmedWrite: vi.fn().mockResolvedValue({
        status: "answered", requestId: "proposal-say-success", providerModel: "fixture",
        proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: "say Arena opens now" }, summary: "Awaiting confirmation" },
      }),
      compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model, { watchdogIntervalMs: 0 });
    const task = await service.create({ tenantId: "tenant-a", instanceRef: "mcs:node:world", intent: "Broadcast that the arena opens now" });
    const issued = service.issueConfirmation(task.id, "tenant-a");
    service.confirm(task.id, "tenant-a", issued.token);
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent(consoleProof(task, "Broadcasted message: Arena opens now"));
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "executed" });
    expect(task.state).toBe("SUCCEEDED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "satisfied" })]);
  });

  it.each([
    ["wrong target", { target: "mcs:node:other" }],
    ["wrong parameters", { parameters: { target: "mcs:node:world", timeout_seconds: 30 } }],
    ["wrong digest", { operation_digest: "tampered" }],
  ])("does not accept a successful callback with %s", async (_label, drift) => {
    const { service } = fixture("stopped");
    const task = await confirmedLifecycle(service, "instance.start");
    await service.recordAgentEvent({ ...proof(task), state: "EXECUTING", kind: "state", summary: "started" });
    await service.recordAgentEvent({ ...proof(task), ...drift, kind: "instance", summary: "accepted" });
    await service.recordAgentEvent({ ...proof(task), state: "SUCCEEDED", kind: "execution", summary: "done" });
    expect(task.state).toBe("FAILED");
    expect(task.goal_statuses).toEqual([expect.objectContaining({ status: "failed" })]);
  });
});
