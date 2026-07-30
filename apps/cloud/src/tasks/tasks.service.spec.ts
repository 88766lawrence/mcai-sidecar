import { describe, expect, it, vi } from "vitest";
import { CloudStore } from "../store/cloud.store";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { TasksService } from "./tasks.service";

describe("TasksService recovery events", () => {
  it("keeps a task active while the Agent retries and only completes after verification succeeds", async () => {
    const store = new CloudStore();
    store.instances.set("mcs:daemon:instance", {
      instance_id: "mcs:daemon:instance",
      name: "Recovery Test",
      platform: "paper",
      minecraft_version: "1.21.1",
      state: "running",
      profile_revision: "rev-1",
      provider_type: "mcsmanager",
      collected_at: new Date().toISOString(),
      tenant_id: "tenant-1",
      agent_id: "agent-1",
    });
    const connections = {
      send: vi.fn().mockReturnValue(true),
    } as unknown as AgentConnectionRegistry;
    const model = {
      answer: vi.fn().mockResolvedValue({ status: "answered", answer: "工具重试后已通过验收。" }),
      decideRecovery: vi.fn(),
    } as unknown as ModelGatewayService;
    const service = new TasksService(store, connections, model);
    const task = await service.create({
      tenantId: "tenant-1",
      instanceRef: "mcs:daemon:instance",
      intent: "list files",
      assistantResponse: "正在调用文件工具。",
      modelStatus: "answered",
    });

    await service.recordAgentEvent({ task_id: task.id, state: "EXECUTING", kind: "state", summary: "Execution started" });
    await service.recordAgentEvent({ task_id: task.id, kind: "diagnosis", summary: "temporary service unavailable" });
    await service.recordAgentEvent({ task_id: task.id, kind: "recovery", summary: "files.list 自动重试（第 2/4 次）" });

    expect(task.state).toBe("EXECUTING");
    expect(await service.complete(task.id, "tenant-1")).toBeUndefined();
    expect(model.decideRecovery).not.toHaveBeenCalled();

    await service.recordAgentEvent({ task_id: task.id, state: "VERIFYING", kind: "state", summary: "Checking acceptance" });
    await service.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "verification", summary: "Acceptance passed" });

    expect(task.state).toBe("SUCCEEDED");
    await expect(service.complete(task.id, "tenant-1")).resolves.toEqual({
      answer: "工具重试后已通过验收。",
      status: "answered",
    });
    expect(task.evidence.some((item) => item.kind === "recovery")).toBe(true);
  });
});
