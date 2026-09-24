import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import {
  extractActionbarConsoleCommand,
  isOnlinePlayerReadIntent,
  resolveConsoleOperations,
} from "./operation-intent";
import { TasksService } from "./tasks.service";

const instanceRef = "mcs:daemon:actionbar";

function fixture() {
  const store = new CloudStore();
  store.instances.set(instanceRef, {
    instance_id: instanceRef,
    name: "Actionbar fixture",
    platform: "paper",
    minecraft_version: "1.21.1",
    state: "running",
    profile_revision: "rev-actionbar",
    provider_type: "mcsmanager",
    collected_at: new Date().toISOString(),
    tenant_id: "tenant-1",
    agent_id: "agent-1",
  });
  const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
  const model = {
    proposeConfirmedWrite: vi.fn(),
    compileIntent: vi.fn(),
    answer: vi.fn(),
    decideRecovery: vi.fn(),
  } as unknown as ModelGatewayService;
  return { connections, model, service: new TasksService(store, connections, model) };
}

describe("deterministic actionbar confirmed write", () => {
  it.each([
    ["让当前在线成员的快捷栏显示“活动入口已开放”，不要更改游戏规则", "活动入口已开放"],
    ["只在所有玩家的 actionbar 提示‘矿区将在五分钟后关闭’，别做其他操作", "矿区将在五分钟后关闭"],
    ["Show every online player the actionbar message \"Meet at spawn!\" and do not change gamerules", "Meet at spawn!"],
    ["Display 'Use \\\"/warp shop\\\" \\\\ safely' in the hotbar for all connected players only", "Use \\\"/warp shop\\\" \\\\ safely"],
  ])("preserves and JSON-escapes the message for %s", (intent, body) => {
    expect(extractActionbarConsoleCommand(intent)).toBe(`title @a actionbar ${JSON.stringify({ text: body })}`);
    expect(isOnlinePlayerReadIntent(intent)).toBe(false);
    expect(resolveConsoleOperations(intent)).toEqual([`title @a actionbar ${JSON.stringify({ text: body })}`]);
  });

  it.each([
    "现在有多少在线玩家",
    "List all connected players",
    "who is online on this server?",
  ])("keeps roster observations read-only: %s", (intent) => {
    expect(extractActionbarConsoleCommand(intent)).toBeUndefined();
    expect(isOnlinePlayerReadIntent(intent)).toBe(true);
    expect(resolveConsoleOperations(intent)).toEqual(["list"]);
  });

  it.each([
    "不要给玩家显示任何 actionbar 提示",
    "在快捷栏显示一条消息",
    "在所有玩家快捷栏显示‘集合’，然后把天气改成晴天",
    "show 'one' and 'two' in every player's actionbar",
    "show \"line one\nline two\" in the actionbar for everyone",
    `show '${"x".repeat(240)}' in every player's actionbar`,
  ])("fails closed for negated, missing, compound or unsafe input: %s", (intent) => {
    expect(extractActionbarConsoleCommand(intent)).toBeUndefined();
  });

  it("creates one canonical medium-risk confirmation step with zero pre-confirm dispatch", async () => {
    const { service, model, connections } = fixture();
    const body = "传送门将在两分钟后开启";
    const command = `title @a actionbar ${JSON.stringify({ text: body })}`;
    const task = await service.create({
      tenantId: "tenant-1",
      instanceRef,
      intent: `给当前所有在线成员的快捷栏显示“${body}”，不要调整任何游戏规则`,
    });

    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.plan.steps).toEqual([{
      id: "s1",
      tool: "console.command",
      args: { command },
      risk: "medium",
      requires_confirmation: true,
    }]);
    expect(task.plan.operation).toMatchObject({
      capability: "console.command",
      action: "write",
      risk: "medium",
      requires_confirmation: true,
      target: command,
      parameters: { command },
    });
    expect((model as any).proposeConfirmedWrite).not.toHaveBeenCalled();
    expect((model as any).compileIntent).not.toHaveBeenCalled();
    expect(connections.send).not.toHaveBeenCalled();
  });

  it("dispatches the exact approved command once and rejects post-preview drift", async () => {
    const first = fixture();
    expect(extractActionbarConsoleCommand("Show all connected users 'Welcome to the arena' in their actionbar only"))
      .toBe(`title @a actionbar ${JSON.stringify({ text: "Welcome to the arena" })}`);
    const task = await first.service.create({
      tenantId: "tenant-1",
      instanceRef,
      intent: "Show all connected users 'Welcome to the arena' in their actionbar only",
    });
    const issued = first.service.issueConfirmation(task.id, "tenant-1");
    first.service.confirm(task.id, "tenant-1", issued.token);
    expect(first.connections.send).toHaveBeenCalledTimes(1);
    expect((first.connections.send as ReturnType<typeof vi.fn>).mock.calls[0][1].payload.steps).toEqual([
      expect.objectContaining({
        tool: "console.command",
        args: { command: `title @a actionbar ${JSON.stringify({ text: "Welcome to the arena" })}` },
      }),
    ]);

    const second = fixture();
    const tampered = await second.service.create({
      tenantId: "tenant-1",
      instanceRef,
      intent: "在每位在线玩家的快捷栏提示‘请返回主城’，仅此一项",
    });
    const token = second.service.issueConfirmation(tampered.id, "tenant-1");
    tampered.plan.steps[0].args.command = `title @a actionbar ${JSON.stringify({ text: "已被篡改" })}`;
    expect(() => second.service.confirm(tampered.id, "tenant-1", token.token)).toThrow("Task plan changed after confirmation was issued");
    expect(second.connections.send).not.toHaveBeenCalled();
  });
});
