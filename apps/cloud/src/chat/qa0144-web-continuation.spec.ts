import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunStore } from "../agents/agent-run.store";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import type { TasksService } from "../tasks/tasks.service";
import { ChatService } from "./chat.service";

describe("QA0144 autonomous web search continuation", () => {
  let directory = "";
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("executes the model's distinct follow-up search instead of replacing it with the first result list", async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-qa0144-web-"));
    const chatPath = join(directory, "conversations.json");
    const runPath = join(directory, "agent-runs.json");
    const populate = (store: CloudStore) => store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "running",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const firstTask = { id: "task-web-1", state: "SUCCEEDED", evidence: [] };
    const secondTask = { id: "task-web-2", state: "SNAPSHOTTING", evidence: [] };
    const tasks = {
      create: vi.fn().mockResolvedValueOnce(firstTask).mockResolvedValueOnce(secondTask),
      get: vi.fn((id: string) => id === firstTask.id ? firstTask : secondTask),
      agentLoopObservation: vi.fn((id: string) => id === firstTask.id ? {
        tool_call_id: "call-initial", tool: "web.search", status: "succeeded", retryable: false, side_effect: "none",
        data: { qa0144_read_result: { schema_version: "qa0144-read-result/v1", output_schema_id: "web-search-result/v1", value: {
          schema_version: "web-search-result/v1", query: "runtime requirements", provider: "fixture",
          results: [{ title: "Documentation", url: "https://docs.example.test/start", snippet: "Getting started", date: "" }],
        } } }, evidence: { ids: ["e1"], summaries: ["one result"] },
      } : undefined),
    } as unknown as TasksService;
    const initialModel = {
      decideAgentLoop: vi.fn().mockResolvedValue({ status: "answered", requestId: "initial", decision: {
        action: "tool_call", tool: "web.search", arguments: { query: "runtime requirements" }, reason: "search once",
      } }), route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const firstStore = new CloudStore(); populate(firstStore);
    const first = new ChatService(firstStore, initialModel, tasks, new AgentRunStore(runPath), chatPath);
    const session = await first.create("tenant-1", "instance-1");
    await first.send(session.id, "tenant-1", "Find the documented runtime requirement and cite it.");

    const continuedModel = {
      decideAgentLoop: vi.fn().mockResolvedValue({ status: "answered", requestId: "continued", decision: {
        action: "tool_call", tool: "web.search", arguments: { query: "runtime requirement major version" }, reason: "refine the query",
      } }), route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService;
    const restartedStore = new CloudStore(); populate(restartedStore);
    const restarted = new ChatService(restartedStore, continuedModel, tasks, new AgentRunStore(runPath), chatPath);
    await restarted.onModuleInit();
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 25 });
    const messages = await restarted.messages(session.id, "tenant-1");
    expect(messages.at(-1)).toMatchObject({ task_id: secondTask.id, task_phase: "request", route: "tool" });
    expect(messages.some((item) => item.task_phase === "completion")).toBe(false);
    expect(tasks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      preferredTool: "web.search",
      agentToolCall: expect.objectContaining({ arguments: { query: "runtime requirement major version" } }),
    }));
    await restarted.onModuleDestroy();
  });

  it("ends with an evidence-gap answer and observed links when the model repeats a completed search", async () => {
    directory = await mkdtemp(join(tmpdir(), "mcai-qa0144-web-gap-"));
    const chatPath = join(directory, "conversations.json");
    const runPath = join(directory, "agent-runs.json");
    const populate = (store: CloudStore) => store.instances.set("instance-1", {
      instance_id: "instance-1", name: "Survival", platform: "paper", minecraft_version: "1.21.1", state: "running",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(), tenant_id: "tenant-1", agent_id: "agent-1",
    });
    const records = [
      { id: "task-web-a", state: "SUCCEEDED", evidence: [] },
      { id: "task-web-b", state: "SUCCEEDED", evidence: [] },
    ];
    const observations = [
      webObservation("runtime documentation", "https://docs.example.test/runtime"),
      webObservation("runtime documentation major version", "https://docs.example.test/versions"),
    ];
    let createIndex = 0;
    const tasks = {
      create: vi.fn(async (input: { agentToolCall: { toolCallId: string } }) => {
        const index = createIndex++;
        observations[index]!.tool_call_id = input.agentToolCall.toolCallId;
        return records[index];
      }),
      get: vi.fn((id: string) => records.find((item) => item.id === id)),
      complete: vi.fn((id: string) => records.find((item) => item.id === id)),
      agentLoopObservation: vi.fn((id: string) => observations[records.findIndex((item) => item.id === id)]),
    } as unknown as TasksService;
    const model = (decision: object) => ({
      decideAgentLoop: vi.fn().mockResolvedValue({ status: "answered", requestId: randomRequestId(), decision }),
      route: vi.fn(), routeStream: vi.fn(),
    } as unknown as ModelGatewayService);
    const firstStore = new CloudStore(); populate(firstStore);
    const first = new ChatService(firstStore, model({
      action: "tool_call", tool: "web.search", arguments: { query: "runtime documentation" }, reason: "search the docs",
    }), tasks, new AgentRunStore(runPath), chatPath);
    const session = await first.create("tenant-1", "instance-1");
    await first.send(session.id, "tenant-1", "查找运行版本要求并引用真实来源。");

    const secondStore = new CloudStore(); populate(secondStore);
    const second = new ChatService(secondStore, model({
      action: "tool_call", tool: "web.search", arguments: { query: "runtime documentation major version" }, reason: "refine the search",
    }), tasks, new AgentRunStore(runPath), chatPath);
    await second.onModuleInit();
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 25 });
    await second.onModuleDestroy();

    const thirdStore = new CloudStore(); populate(thirdStore);
    const third = new ChatService(thirdStore, model({
      action: "tool_call", tool: "web.search", arguments: { query: "runtime documentation major version" }, reason: "repeat the same search",
    }), tasks, new AgentRunStore(runPath), chatPath);
    await third.onModuleInit();
    await vi.waitFor(async () => expect((await third.messages(session.id, "tenant-1")).at(-1)).toMatchObject({
      task_phase: "completion",
      content: expect.stringMatching(/摘要不足.*https:\/\/docs\.example\.test\/runtime/su),
    }), { timeout: 5_000, interval: 25 });
    const messages = await third.messages(session.id, "tenant-1");
    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(messages.at(-1)?.content).not.toMatch(/^根据已完成的只读检查/u);
    await third.onModuleDestroy();
  });

  function webObservation(query: string, url: string) {
    return {
      tool_call_id: "pending", tool: "web.search" as const, status: "succeeded" as const, retryable: false, side_effect: "none" as const,
      data: { qa0144_read_result: { schema_version: "qa0144-read-result/v1", output_schema_id: "web-search-result/v1", value: {
        schema_version: "web-search-result/v1", query, provider: "fixture",
        results: [{ title: "Runtime documentation", url, snippet: "Version requirements are documented here.", date: "" }],
      } } },
      evidence: { ids: [url], summaries: ["one documented result"] },
    };
  }

  function randomRequestId() { return `request-${Math.random().toString(16).slice(2)}`; }
});
