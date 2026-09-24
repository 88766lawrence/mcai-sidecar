import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunStore } from "../agents/agent-run.store";
import { CloudStore } from "../store/cloud.store";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import type { TasksService } from "../tasks/tasks.service";
import { ChatService } from "./chat.service";

describe("ChatService durable agent run recovery", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    delete process.env.MCAI_CONFIG_DIR;
  });

  it("continues the same run after ChatService is reconstructed", async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-chat-run-recovery-"));
    process.env.MCAI_CONFIG_DIR = directory;
    const cloud = new CloudStore();
    cloud.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const task = {
      id: "task-1", state: "SUCCEEDED", evidence: [{ kind: "console", summary: "Paper 1.21.1", at: new Date().toISOString() }],
    };
    const observation = {
      tool_call_id: "call-1", tool: "console.command", status: "succeeded" as const, retryable: false, side_effect: "none" as const,
      data: { version: "1.21.1" }, evidence: { ids: ["e1"], summaries: ["Paper 1.21.1"] },
    };
    const tasks = {
      create: vi.fn().mockResolvedValue(task), get: vi.fn().mockReturnValue(task),
      agentLoopObservation: vi.fn().mockReturnValue(observation),
    } as unknown as TasksService;
    const firstModel = {
      decideAgentLoop: vi.fn().mockResolvedValue({
        status: "answered", requestId: "request-1",
        decision: { action: "tool_call", tool: "console.command", arguments: { command: "version" }, reason: "read version" },
      }),
      route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const firstRunStore = new AgentRunStore(join(directory, "agent-runs.json"));
    const first = new ChatService(cloud, firstModel, tasks, firstRunStore);
    const session = await first.create("tenant-1", "instance-1");
    const submitted = await first.send(session.id, "tenant-1", "What server version is running?");
    expect(submitted.message.task_id).toBe("task-1");
    const activeRun = await firstRunStore.findByCurrentTask("task-1", "tenant-1");
    expect(activeRun).toBeDefined();

    const restartedModel = {
      decideAgentLoop: vi.fn().mockResolvedValue({
        status: "answered", requestId: "request-2",
        decision: { action: "final", answer: "Paper 1.21.1 is running.", citations: ["call-1"] },
      }),
      route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const restarted = new ChatService(cloud, restartedModel, tasks, new AgentRunStore(join(directory, "agent-runs.json")));
    await restarted.onModuleInit();
    await vi.waitFor(() => expect(restartedModel.decideAgentLoop).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const current = await restarted.messages(session.id, "tenant-1");
      expect(current.at(-1)).toMatchObject({ role: "assistant", task_phase: "completion" });
    }, { timeout: 10_000, interval: 50 });
    const messages = await restarted.messages(session.id, "tenant-1");
    expect(restartedModel.decideAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      round: 2,
      observations: [expect.objectContaining({ tool_call_id: "call-1", status: "succeeded" })],
    }));
    expect(messages.at(-1)).toMatchObject({ role: "assistant", task_phase: "completion", content: "Paper 1.21.1 is running." });
    const persisted = new AgentRunStore(join(directory, "agent-runs.json"));
    const completedRun = await persisted.get(activeRun!.run_id, "tenant-1");
    expect(completedRun).toMatchObject({ status: "SUCCEEDED" });
    expect(completedRun).not.toHaveProperty("current_task_id");
    expect((await persisted.events(activeRun!.run_id)).map((event) => event.type)).toEqual([
      "user_message", "model_decision", "tool_call", "tool_observation", "model_decision", "final_answer",
    ]);
    await restarted.onModuleDestroy();
  });
});
