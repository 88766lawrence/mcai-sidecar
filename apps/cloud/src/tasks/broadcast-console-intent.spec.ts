import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { extractBroadcastConsoleCommand } from "./operation-intent";
import { TasksService } from "./tasks.service";

const instanceRef = "mcs:daemon:instance";

function fixture() {
  const store = new CloudStore();
  store.instances.set(instanceRef, {
    instance_id: instanceRef, name: "Broadcast", platform: "paper", minecraft_version: "1.21.1",
    state: "running", profile_revision: "rev-broadcast", provider_type: "mcsmanager",
    collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
  });
  const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
  const model = {
    proposeConfirmedWrite: vi.fn(), compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
  } as unknown as ModelGatewayService;
  return { connections, model, service: new TasksService(store, connections, model) };
}

describe("deterministic single broadcast intent", () => {
  it.each([
    ["请在当前实例控制台广播一句“维护窗口将在十分钟后开始”", "say 维护窗口将在十分钟后开始"],
    ["仅向全服发送消息「今晚活动照常进行」，别做其他操作", "say 今晚活动照常进行"],
    ["用控制台公告：欢迎新玩家", "say 欢迎新玩家"],
    ["Announce \"Backup completed safely\" on this server console, nothing else", "say Backup completed safely"],
    ["Use say to tell every player 'Round two begins now' only", "say Round two begins now"],
    ["Broadcast this exact message: Keep CAPS And punctuation!", "say Keep CAPS And punctuation!"],
  ])("preserves the broadcast body for %s", (intent, command) => {
    expect(extractBroadcastConsoleCommand(intent)).toBe(command);
  });

  it.each([
    "广播一条消息",
    "broadcast something to players",
    "广播‘第一条’，然后把天气改成下雨",
    "say hello and restart the server",
    "不要广播任何消息",
  ])("fails closed for ambiguous, compound or negated input: %s", (intent) => {
    expect(extractBroadcastConsoleCommand(intent)).toBeUndefined();
  });

  it("creates one medium-risk confirmation plan without consulting either model path", async () => {
    const { service, model, connections } = fixture();
    const task = await service.create({
      tenantId: "tenant-1", instanceRef,
      intent: "只在控制台发出公告“副本将在五分钟后关闭”，不要执行其他事情",
    });
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.plan.steps).toEqual([{
      id: "s1", tool: "console.command", args: { command: "say 副本将在五分钟后关闭" },
      risk: "medium", requires_confirmation: true,
    }]);
    expect(task.plan.operation).toMatchObject({
      capability: "console.command", action: "write", target: "say 副本将在五分钟后关闭",
      parameters: { command: "say 副本将在五分钟后关闭" }, risk: "medium", requires_confirmation: true,
    });
    expect(task.plan.operation.verification_evidence).toEqual([]);
    expect(task.plan.steps.some((step) => ["logs.query", "instance.restart", "files.list"].includes(step.tool))).toBe(false);
    expect((model as any).proposeConfirmedWrite).not.toHaveBeenCalled();
    expect((model as any).compileIntent).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("dispatches the exact approved message once and rejects command drift", async () => {
    const first = fixture();
    const task = await first.service.create({ tenantId: "tenant-1", instanceRef, intent: "Console announce: 'Shops close at dusk' and nothing else" });
    const issued = first.service.issueConfirmation(task.id, "tenant-1");
    first.service.confirm(task.id, "tenant-1", issued.token);
    expect(first.connections.send).toHaveBeenCalledTimes(1);
    expect((first.connections.send as ReturnType<typeof vi.fn>).mock.calls[0][1].payload.steps).toEqual([
      expect.objectContaining({ tool: "console.command", args: { command: "say Shops close at dusk" } }),
    ]);

    const second = fixture();
    const tampered = await second.service.create({ tenantId: "tenant-1", instanceRef, intent: "Broadcast: 'Arena opens now' only" });
    const token = second.service.issueConfirmation(tampered.id, "tenant-1");
    tampered.plan.steps[0].args.command = "say changed";
    expect(() => second.service.confirm(tampered.id, "tenant-1", token.token)).toThrow("Task plan changed after confirmation was issued");
    expect(second.connections.send).not.toHaveBeenCalled();
  });
});
