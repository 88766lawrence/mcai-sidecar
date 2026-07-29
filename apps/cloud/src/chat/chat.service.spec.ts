import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudStore } from "../store/cloud.store";
import { ChatService } from "./chat.service";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import type { TasksService } from "../tasks/tasks.service";

describe("ChatService", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-chat-"));
    process.env.MCAI_CONFIG_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.MCAI_CONFIG_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("creates independent sessions, saves prompts, and keeps direct answers out of the tool queue", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1",
      name: "Survival",
      platform: "paper",
      minecraft_version: "1.21.4",
      state: "running",
      profile_revision: "rev-1",
      provider_type: "mcsmanager",
      collected_at: new Date().toISOString(),
      tenant_id: "tenant-1",
      agent_id: "agent-1",
    });
    const model = {
      route: vi.fn().mockResolvedValue({ route: "direct", answer: "Paper 更适合插件生态。" }),
    } as unknown as ModelGatewayService;
    const tasks = { create: vi.fn(), get: vi.fn() } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);

    const first = await service.create("tenant-1", "instance-1");
    const second = await service.create("tenant-1", "instance-1", "性能规划");
    await service.update(first.id, "tenant-1", { system_prompt: "回答要简洁，并优先说明风险。" });
    const result = await service.send(first.id, "tenant-1", "Paper 和 Fabric 有什么区别？");

    expect(service.list("tenant-1")).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
    expect(result.message).toMatchObject({ role: "assistant", route: "direct" });
    expect(tasks.create).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "conversations.json"), "utf8")).toContain("回答要简洁");
  });

  it("appends one final answer after a terminal tool callback", async () => {
    const store = new CloudStore();
    store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.4",
      state: "running", profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const model = {
      route: vi.fn().mockResolvedValue({ route: "tool", answer: "正在查询实例目录。", toolIntent: "列出根目录文件" }),
    } as unknown as ModelGatewayService;
    const task = { id: "task-1", state: "SUCCEEDED" };
    const tasks = {
      create: vi.fn().mockResolvedValue(task),
      get: vi.fn().mockReturnValue(task),
      complete: vi.fn().mockResolvedValue({ answer: "根目录包含 paper.jar。", status: "answered" }),
    } as unknown as TasksService;
    const service = new ChatService(store, model, tasks);
    const session = await service.create("tenant-1", "instance-1");

    await service.send(session.id, "tenant-1", "根目录有什么文件？");
    const once = await service.messages(session.id, "tenant-1");
    const twice = await service.messages(session.id, "tenant-1");

    expect(once.at(-1)).toMatchObject({ task_id: "task-1", task_phase: "completion", content: "根目录包含 paper.jar。" });
    expect(twice.filter((message) => message.task_phase === "completion")).toHaveLength(1);
    expect(tasks.complete).toHaveBeenCalledTimes(1);
  });
});
