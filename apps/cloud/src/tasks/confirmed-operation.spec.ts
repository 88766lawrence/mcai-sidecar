import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { draftPlan } from "./planner";
import { TasksService } from "./tasks.service";

function fixture() {
  const store = new CloudStore();
  store.instances.set("mcs:daemon:instance", { instance_id: "mcs:daemon:instance", name: "Confirmed Write", platform: "paper", minecraft_version: "1.21.1", state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1" });
  const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
  const model = { answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
  return { store, connections, service: new TasksService(store, connections, model) };
}

describe("confirmed write execution projection", () => {
  it("freezes a lifecycle target to the bound instance and rejects target drift after preview", async () => {
    const { store, service, connections } = fixture();
    store.instances.get("mcs:daemon:instance")!.state = "stopped";
    const task = await service.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Launch this current game server only",
      preferredTool: "instance.start", assistantResponse: "Awaiting confirmation", modelStatus: "answered",
    });
    const issued = service.issueConfirmation(task.id, "tenant-1");
    expect(task.plan.steps).toEqual([expect.objectContaining({ tool: "instance.start", args: { target: "mcs:daemon:instance", timeout_seconds: 120 } })]);
    expect(task.plan.confirmed_write_proposal).toMatchObject({ tool: "instance.start", target: "mcs:daemon:instance" });
    task.plan.steps[0].args.target = "mcs:daemon:other";
    expect(() => service.confirm(task.id, "tenant-1", issued.token)).toThrow("Task plan changed after confirmation was issued");
    expect(connections.send).not.toHaveBeenCalled();
  });

  it.each([
    ["console command: weather clear", "weather clear"],
    ["console command: time set midnight", "time set midnight"],
    ["console command: gamerule doTraderSpawning false", "gamerule doTraderSpawning false"],
    ["console command: whitelist add ElmRider", "whitelist add ElmRider"],
  ])("dispatches the exact approved operation for %s", async (intent, command) => {
    const { service, connections } = fixture();
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent, assistantResponse: "Awaiting confirmation", modelStatus: "answered" });
    const issued = service.issueConfirmation(task.id, "tenant-1");
    service.confirm(task.id, "tenant-1", issued.token);
    const payload = (connections.send as ReturnType<typeof vi.fn>).mock.calls[0][1].payload;
    expect(payload.steps.filter((step: { purpose?: string }) => step.purpose !== "verify")).toEqual([expect.objectContaining({ tool: "console.command", args: { command } })]);
    expect(payload.confirmed_operation).toMatchObject({ schema_version: "confirmed-operation/v1", instance_ref: "mcs:daemon:instance", operation_digest: payload.operation.digest, risk: "medium", requires_confirmation: true });
  });

  it("does not invent a logs.query verification for an unsupported weather readback", () => {
    const plan = draftPlan("mcs:daemon:instance", "rev-1", "console command: weather clear");
    expect(plan.steps).toEqual([expect.objectContaining({ tool: "console.command", args: { command: "weather clear" } })]);
    expect(plan.operation.verification_evidence).toEqual([]);
  });

  it.each([
      ["command", (task: any) => { task.plan.steps[0].args.command = "weather thunder"; }],
      ["canonical target", (task: any) => { task.plan.operation.target = "weather thunder"; }],
      ["instance", (task: any) => { task.instance_ref = "mcs:other:instance"; task.plan.instance_ref = "mcs:other:instance"; }],
    ["second write", (task: any) => { task.plan.steps.push({ id: "s9", tool: "console.command", args: { command: "say injected" }, risk: "medium", requires_confirmation: true }); }],
    ["risk", (task: any) => { task.plan.steps[0].risk = "read"; task.plan.operation.risk = "read"; }],
    ["operation digest", (task: any) => { task.plan.operation.digest = "00"; }],
  ])("rejects %s drift after the confirmation preview was issued", async (_name, mutate) => {
    const { service, connections } = fixture();
    const task = await service.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "console command: weather clear", assistantResponse: "Awaiting confirmation", modelStatus: "answered" });
    const issued = service.issueConfirmation(task.id, "tenant-1");
    mutate(task);
    expect(() => service.confirm(task.id, "tenant-1", issued.token)).toThrow("Task plan changed after confirmation was issued");
    expect(connections.send).not.toHaveBeenCalled();
  });
});
