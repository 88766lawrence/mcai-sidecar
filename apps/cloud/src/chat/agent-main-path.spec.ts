import { describe, expect, it, vi } from "vitest";
import { CloudStore } from "../store/cloud.store";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import type { TasksService } from "../tasks/tasks.service";
import { ChatService } from "./chat.service";
import { AgentRunStore } from "../agents/agent-run.store";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("ordinary user messages use the agent main path", () => {
  it("uses the conversational model fallback, not a deterministic operation route, when the agent model is unavailable", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "running",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      decideAgentLoop: vi.fn().mockResolvedValue({ status: "unavailable", error: "MODEL_TIMEOUT" }),
      route: vi.fn().mockResolvedValue({ route: "clarify", answer: "智能执行暂时不可用，请稍后再试。" }), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks, new AgentRunStore(join(tmpdir(), `agent-main-${randomUUID()}.json`)), join(tmpdir(), `chat-main-${randomUUID()}.json`));
    const session = await service.create("tenant-1", "instance-1");
    const result = await service.send(session.id, "tenant-1", "Could you inspect the exact current rule that controls creature block changes?");
    expect(result.task).toBeUndefined();
    expect(result.message).toMatchObject({ route: "clarify" });
    expect(tasks.create).not.toHaveBeenCalled();
    expect(model.route).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "text transformation containing operational vocabulary",
      message: "Condense this note into one sentence: archive the world, update its extensions, verify compatibility, and reopen later.",
      answer: "先存档，再更新扩展并验证兼容性，最后恢复开放。",
    },
    {
      label: "conversation preference next to a player-domain noun",
      message: "低延迟和成员体验是我最在意的两件事，请记下这个偏好。",
      answer: "我已经记住你的偏好：低延迟和成员体验。",
    },
  ])("keeps an authoritative Agent final on the direct path: $label", async ({ message, answer }) => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "running",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      decideAgentLoop: vi.fn().mockResolvedValue({
        status: "answered", requestId: "request-direct",
        decision: { action: "final", answer, citations: [], covered_result_ids: [] },
      }),
      route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks, new AgentRunStore(join(tmpdir(), `agent-main-${randomUUID()}.json`)), join(tmpdir(), `chat-main-${randomUUID()}.json`));
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", message);

    expect(result.task).toBeUndefined();
    expect(result.message).toMatchObject({ route: "direct", content: answer });
    expect(tasks.create).not.toHaveBeenCalled();
    expect(model.route).not.toHaveBeenCalled();
  });

  it("still blocks an Agent final that claims an external mutation without evidence", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "running",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      decideAgentLoop: vi.fn().mockResolvedValue({
        status: "answered", requestId: "request-unproven",
        decision: { action: "final", answer: "BlueMap 已安装完成。", citations: [], covered_result_ids: [] },
      }),
      route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks, new AgentRunStore(join(tmpdir(), `agent-main-${randomUUID()}.json`)), join(tmpdir(), `chat-main-${randomUUID()}.json`));
    const session = await service.create("tenant-1", "instance-1");

    const result = await service.send(session.id, "tenant-1", "直接告诉我这个扩展现在是否可用。");

    expect(result.task).toBeUndefined();
    expect(result.message).toMatchObject({ route: "direct", content: "我还没有执行，无法确认操作已经完成。" });
    expect(tasks.create).not.toHaveBeenCalled();
  });
});
