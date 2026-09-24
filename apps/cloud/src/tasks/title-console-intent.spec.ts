import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { extractTitleConsoleCommand, isOnlinePlayerReadIntent, resolveConsoleOperations } from "./operation-intent";
import { TasksService } from "./tasks.service";

const instanceRef = "mcs:daemon:title";
function fixture() {
  const store = new CloudStore();
  store.instances.set(instanceRef, {
    instance_id: instanceRef, name: "Title fixture", platform: "paper", minecraft_version: "1.21.1",
    state: "running", profile_revision: "rev-title", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
    tenant_id: "tenant-1", agent_id: "agent-1",
  });
  const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
  const model = { proposeConfirmedWrite: vi.fn(), compileIntent: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
  return { connections, model, service: new TasksService(store, connections, model) };
}

describe("deterministic player title confirmed write", () => {
  it.each([
    ["给全体玩家显示标题“传送门现已开放”，仅做这一项", "传送门现已开放"],
    ["向当前在线成员展示一条主标题‘公会战即将开始’，不要做其他操作", "公会战即将开始"],
    ["Show every connected player the title \"Maintenance complete\" and nothing else.", "Maintenance complete"],
    ["Display a title reading 'Online /stop and restart are words here' to all players only", "Online /stop and restart are words here"],
    ["Put the main title 'Use \\\"/home\\\" \\\\ safely' on screen for each online user", "Use \\\"/home\\\" \\\\ safely"],
  ])("extracts one safe JSON title command: %s", (intent, body) => {
    const command = `title @a title ${JSON.stringify({ text: body })}`;
    expect(extractTitleConsoleCommand(intent)).toBe(command);
    expect(isOnlinePlayerReadIntent(intent)).toBe(false);
    expect(resolveConsoleOperations(intent)).toEqual([command]);
  });

  it.each([
    "现在有多少在线玩家",
    "List every connected player",
    "who is online right now?",
  ])("keeps actual roster questions on the read path: %s", (intent) => {
    expect(extractTitleConsoleCommand(intent)).toBeUndefined();
    expect(isOnlinePlayerReadIntent(intent)).toBe(true);
    expect(resolveConsoleOperations(intent)).toEqual(["list"]);
  });

  it.each([
    "不要给任何玩家显示标题‘维护中’",
    "给所有在线玩家显示一个标题",
    "给所有玩家显示标题‘第一条’和‘第二条’",
    "显示标题‘欢迎’，然后把天气改晴",
    "show \"line one\nline two\" as a title to everyone",
    `show '${"x".repeat(240)}' as the title for all players`,
  ])("fails closed for negated, missing, multiple, compound, or unsafe bodies: %s", (intent) => {
    expect(extractTitleConsoleCommand(intent)).toBeUndefined();
  });

  it("creates one medium-risk confirmation and performs zero pre-confirm dispatch", async () => {
    const { service, model, connections } = fixture();
    const body = "竞技场入口已开启";
    const command = `title @a title ${JSON.stringify({ text: body })}`;
    const task = await service.create({ tenantId: "tenant-1", instanceRef, intent: `只给所有在线玩家显示标题“${body}”，除此之外什么都别做` });
    expect(task.state).toBe("WAITING_CONFIRMATION");
    expect(task.plan.steps).toEqual([{ id: "s1", tool: "console.command", args: { command }, risk: "medium", requires_confirmation: true }]);
    expect(task.plan.operation).toMatchObject({ capability: "console.command", action: "write", risk: "medium", requires_confirmation: true, target: command, parameters: { command } });
    expect(task.plan.goal_requirements).toEqual([]);
    expect(connections.send).not.toHaveBeenCalled();
    expect((model as any).proposeConfirmedWrite).not.toHaveBeenCalled();
    expect((model as any).compileIntent).not.toHaveBeenCalled();
  });

  it("dispatches the exact approved command once and rejects command drift", async () => {
    const first = fixture();
    const task = await first.service.create({ tenantId: "tenant-1", instanceRef, intent: "Show all players the title 'Round begins now' only" });
    const issued = first.service.issueConfirmation(task.id, "tenant-1");
    first.service.confirm(task.id, "tenant-1", issued.token);
    expect(first.connections.send).toHaveBeenCalledTimes(1);
    expect((first.connections.send as ReturnType<typeof vi.fn>).mock.calls[0][1].payload.steps).toEqual([
      expect.objectContaining({ tool: "console.command", args: { command: `title @a title ${JSON.stringify({ text: "Round begins now" })}` } }),
    ]);

    const second = fixture();
    const tampered = await second.service.create({ tenantId: "tenant-1", instanceRef, intent: "给全部玩家显示标题‘回合结束’，仅此一项" });
    const token = second.service.issueConfirmation(tampered.id, "tenant-1");
    tampered.plan.steps[0].args.command = `title @a title ${JSON.stringify({ text: "被篡改" })}`;
    expect(() => second.service.confirm(tampered.id, "tenant-1", token.token)).toThrow("Task plan changed after confirmation was issued");
    expect(second.connections.send).not.toHaveBeenCalled();
  });
});
