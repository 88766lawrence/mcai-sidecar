import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import { AgentRunStore } from "../agents/agent-run.store";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { canonicalAgentToolCallKey } from "../chat/agent-loop";
import { TasksService } from "./tasks.service";

describe("durable agent approval", () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

  it("restores the exact paused call after restart and dispatches it only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-approval-"));
    directories.push(directory);
    const path = join(directory, "agent-runs.json");
    const firstRuns = new AgentRunStore(path);
    const firstStore = cloudStore();
    const firstConnections = connections();
    const first = service(firstStore, firstConnections, firstRuns);
    const call = {
      toolCallId: "call-weather-1", action: "tool_call" as const, tool: "console.command" as const,
      arguments: { command: "weather clear" }, reason: "Apply the requested weather change.",
    };
    const task = await first.create({
      tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Clear the weather.",
      assistantResponse: "Ready for confirmation.", modelStatus: "answered", agentToolCall: call,
    });
    const run = await firstRuns.create({
      tenant_id: "tenant-1", session_id: "session-1", instance_ref: task.instance_ref,
      original_user_message: task.intent, system_prompt: "Use tools safely.", prompt_version: "prompt/v1",
      tool_catalog_version: "catalog/v1", policy_version: task.plan.policy_version, current_task_id: task.id,
      initial_call: { id: call.toolCallId, key: canonicalAgentToolCallKey(call), tool: call.tool, arguments: call.arguments, reason: call.reason },
    });
    await first.bindAgentApproval(run.run_id, task.id, call.toolCallId);
    const issued = await first.issueConfirmationForRequest(task.id, "tenant-1");
    expect(firstConnections.send).toHaveBeenCalledTimes(0);

    const restartedRuns = new AgentRunStore(path);
    const restartedStore = cloudStore();
    const restartedConnections = connections();
    const restarted = service(restartedStore, restartedConnections, restartedRuns);
    await restarted.onModuleInit();
    const restored = restarted.get(task.id, "tenant-1");
    expect(restored).toMatchObject({ state: "WAITING_CONFIRMATION", plan: { execution_mode: "agent_direct" } });
    expect(restored.plan.steps).toEqual(task.plan.steps);

    await expect(restarted.confirmForRequest(task.id, "tenant-1", "wrong-token")).rejects.toThrow("AGENT_APPROVAL_INVALID_TOKEN");
    expect(restartedConnections.send).toHaveBeenCalledTimes(0);
    await restarted.confirmForRequest(task.id, "tenant-1", issued.token);
    expect(restartedConnections.send).toHaveBeenCalledTimes(1);
    expect(restartedConnections.send).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      type: "task.execute", payload: expect.objectContaining({
        task_id: task.id,
        agent_execution: expect.objectContaining({ tool_call_id: call.toolCallId, tool: call.tool, arguments: call.arguments }),
      }),
    }));
    await expect(restarted.confirmForRequest(task.id, "tenant-1", issued.token)).rejects.toThrow("AGENT_APPROVAL_ALREADY_RESOLVED");
    expect(restartedConnections.send).toHaveBeenCalledTimes(1);
  });

  it("rejects plan tampering before atomically consuming the approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-approval-"));
    directories.push(directory);
    const runs = new AgentRunStore(join(directory, "agent-runs.json"));
    const store = cloudStore();
    const send = connections();
    const tasks = service(store, send, runs);
    const call = {
      toolCallId: "call-weather-2", action: "tool_call" as const, tool: "console.command" as const,
      arguments: { command: "weather clear" }, reason: "Apply the requested weather change.",
    };
    const task = await tasks.create({ tenantId: "tenant-1", instanceRef: "mcs:daemon:instance", intent: "Clear weather", assistantResponse: "Ready for confirmation.", modelStatus: "answered", agentToolCall: call });
    const run = await runs.create({
      tenant_id: "tenant-1", session_id: "session-2", instance_ref: task.instance_ref, original_user_message: task.intent,
      system_prompt: "safe", prompt_version: "v1", tool_catalog_version: "v1", policy_version: task.plan.policy_version,
      current_task_id: task.id, initial_call: { id: call.toolCallId, key: canonicalAgentToolCallKey(call), tool: call.tool, arguments: call.arguments, reason: call.reason },
    });
    await tasks.bindAgentApproval(run.run_id, task.id, call.toolCallId);
    const issued = await tasks.issueConfirmationForRequest(task.id, "tenant-1");
    task.plan.agent_execution!.arguments = { command: "stop" };
    task.plan.steps[0]!.args = { command: "stop" };
    await expect(tasks.confirmForRequest(task.id, "tenant-1", issued.token)).rejects.toThrow("AGENT_APPROVAL_SCOPE_MISMATCH");
    expect(send.send).toHaveBeenCalledTimes(0);
  });
});

function cloudStore() {
  const store = new CloudStore();
  store.instances.set("mcs:daemon:instance", {
    instance_id: "mcs:daemon:instance", name: "Approval Test", platform: "paper", minecraft_version: "1.21.1",
    state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
    tenant_id: "tenant-1", agent_id: "agent-1",
  });
  return store;
}

function connections() { return { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry & { send: ReturnType<typeof vi.fn> }; }
function service(store: CloudStore, send: AgentConnectionRegistry, runs: AgentRunStore) {
  return new TasksService(store, send, {
    compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn(),
  } as unknown as ModelGatewayService, { watchdogIntervalMs: 0 }, runs);
}
