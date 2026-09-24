import { describe, expect, it } from "vitest";
import { validatePlanCompatibility } from "./plan-compatibility";
import { validateConfirmedWriteProposal, validateConfirmedWriteWireShape } from "./confirmed-write-proposal";
import { CloudStore } from "../store/cloud.store";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { TasksService } from "./tasks.service";
import { vi } from "vitest";

const base = { intent: "把游戏天气调成晴天", instanceRef: "mcs:daemon:instance", inventoryRevision: "rev-1" };

describe("confirmed-write-proposal/v1", () => {
  it.each([
    ["把游戏天气调成晴天", "weather clear"], ["将时间设为午夜", "time set midnight"],
    ["把游戏规则 doMobSpawning 设为 false", "gamerule doMobSpawning false"], ["添加玩家 RiverFox 到白名单", "whitelist add RiverFox"],
    ["send a welcome message with the console", "say Welcome"],
    ["Ring a bell once for every connected player and do nothing else.", "playsound minecraft:block.note_block.bell master @a ~ ~ ~ 1 1"],
    ["Show exactly five happy villager particles once beside every connected player and change no settings.", "execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~ 0.25 0.25 0.25 0 5 force @s"],
  ])("builds one policy-derived confirmation plan for %s", (intent, command) => {
    const result = validateConfirmedWriteProposal({ schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: command, parameters: { command }, summary: `执行 ${command}` }, { ...base, intent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command }, risk: "medium", requires_confirmation: true }]);
    expect(result.plan.intent_ir).toBeUndefined();
    expect(result.plan.clause_ledger).toEqual([]);
    expect(result.plan.source_atoms).toEqual([]);
    expect(result.plan.operation).toMatchObject({ schema_version: "operation-objective/v2", risk: "medium", requires_confirmation: true });
    expect(validatePlanCompatibility(result.plan)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    ["坏 JSON", "text", "PROPOSAL_INVALID_JSON"],
    ["偷带安全字段", { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "weather clear", parameters: { command: "weather clear" }, summary: "x", risk: "read" }, "PROPOSAL_FORBIDDEN_FIELD"],
    ["空命令", { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "console.command", parameters: { command: "" }, summary: "x" }, "PROPOSAL_INVALID_PARAMETERS"],
    ["未知工具", { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "shell.exec", target: "host", parameters: { command: "true" }, summary: "x" }, "PROPOSAL_UNSUPPORTED_TOOL"],
  ])("fails closed for %s", (_name, proposal, code) => expect(validateConfirmedWriteProposal(proposal, base)).toMatchObject({ ok: false, code }));

  it.each(["把天气调成晴天，然后把时间设成白天", "读取当前时间并把天气改成下雨"])("refuses compound goal loss: %s", (intent) => {
    expect(validateConfirmedWriteProposal({ schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "weather clear", parameters: { command: "weather clear" }, summary: "改天气" }, { ...base, intent })).toMatchObject({ ok: false, code: "PROPOSAL_NOT_SINGLE_OPERATION" });
  });

  it("rejects provider-owned safety and terminal fields at the wire boundary", () => {
    expect(validateConfirmedWriteWireShape({ schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "weather clear", parameters: { command: "weather clear" }, summary: "done", approval: true })).toEqual({ ok: false, code: "PROPOSAL_FORBIDDEN_FIELD" });
  });

  it.each([undefined, "day", "a provider alias"])("derives one canonical target when provider target is %s", (target) => {
    const raw = { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", parameters: { command: "time set day" }, summary: "等待确认", ...(target === undefined ? {} : { target }) };
    const result = validateConfirmedWriteProposal(raw, { ...base, intent: "把时间设置为白天" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
      expect(result.proposal.target).toBe("time set day");
      expect(result.plan.operation.target).toBe("time set day");
    expect(result.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command: "time set day" }, risk: "medium", requires_confirmation: true }]);
  });

  it("preserves the explicit Console command body exactly", () => {
    expect(validateConfirmedWriteProposal({ schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "say changed", parameters: { command: "say changed" }, summary: "pending" }, { ...base, intent: "Console command: say Exact Message" })).toMatchObject({ ok: false, code: "PROPOSAL_EXPLICIT_COMMAND_MISMATCH" });
  });

  it("bypasses the full compiler, waits for one confirmation, then dispatches the exact proposal", async () => {
    const store = new CloudStore();
    store.instances.set(base.instanceRef, { instance_id: base.instanceRef, name: "Proposal", platform: "paper", minecraft_version: "1.21.1", state: "running", profile_revision: base.inventoryRevision, provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1" });
    const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
    const compileIntent = vi.fn();
    const proposeConfirmedWrite = vi.fn().mockResolvedValue({ status: "answered", requestId: "proposal-1", providerModel: "fixture", proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "weather clear", parameters: { command: "weather clear" }, summary: "将天气改为晴天，等待确认。" } });
    const service = new TasksService(store, connections, { proposeConfirmedWrite, compileIntent, answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService);
    const task = await service.create({ tenantId: "tenant-1", instanceRef: base.instanceRef, intent: base.intent });
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.plan.steps).toHaveLength(1);
    expect(task.plan.steps[0]).toMatchObject({ tool: "console.command", args: { command: "weather clear" }, risk: "medium", requires_confirmation: true });
    expect(task.plan.steps.some((step) => step.tool === "logs.query")).toBe(false);
    expect(compileIntent).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
    const confirmation = service.issueConfirmation(task.id, "tenant-1");
    service.confirm(task.id, "tenant-1", confirmation.token);
    expect(connections.send).toHaveBeenCalledTimes(1);
    expect((connections.send as ReturnType<typeof vi.fn>).mock.calls[0][1].payload.confirmed_operation).toMatchObject({ schema_version: "confirmed-operation/v1", instance_ref: base.instanceRef, risk: "medium" });
  });

  it("keeps a lying single proposal for a compound request in WAITING with zero dispatch", async () => {
    const store = new CloudStore();
    store.instances.set(base.instanceRef, { instance_id: base.instanceRef, name: "Proposal", platform: "paper", minecraft_version: "1.21.1", state: "running", profile_revision: base.inventoryRevision, provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1" });
    const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
    const model = { proposeConfirmedWrite: vi.fn().mockResolvedValue({ status: "answered", requestId: "proposal-2", providerModel: "fixture", proposal: { schema_version: "confirmed-write-proposal/v1", decision: "propose", tool: "console.command", target: "weather clear", parameters: { command: "weather clear" }, summary: "改天气" } }), compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
    const task = await new TasksService(store, connections, model).create({ tenantId: "tenant-1", instanceRef: base.instanceRef, intent: "把天气改成晴天，然后把时间改成白天" });
    expect(task.state).toBe("WAITING");
    expect(task.assistant_response).toContain("没有执行任何操作");
    expect(task.assistant_response).not.toMatch(/PROPOSAL_|INTENT_COMPILER|typed intent compiler|gateway|schema|digest/i);
    expect(connections.send).not.toHaveBeenCalled();
  });
});
