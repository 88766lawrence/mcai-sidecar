import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunStore } from "../agents/agent-run.store";
import type { AgentConnectionRegistry } from "../agents/agent-connection.registry";
import type { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { CloudStore } from "../store/cloud.store";
import { TasksService } from "../tasks/tasks.service";
import { ChatService } from "./chat.service";
import type { AgentLoopObservation } from "./agent-loop";
import { renderVerifiedFileDownloadFinal } from "../tasks/file-download-final";

describe("QA0153 durable validation and download finalization", () => {
  const directories: string[] = [];
  const services: ChatService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("persists one authoritative assistant result when the initial AI tool call fails technical validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-qa0153-validation-"));
    directories.push(directory);
    const cloud = cloudWithInstance();
    const decideAgentLoop = vi.fn().mockResolvedValue({
      status: "answered", requestId: "model-private", decision: {
        action: "tool_call", tool: "file.download",
        arguments: { url: "http://127.0.0.1/a.txt", target: "downloads/private.txt" },
        reason: "Attempt the requested download within the controlled boundary.",
      },
    });
    const model = { decideAgentLoop, route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
    const tasks = new TasksService(cloud, connections, model);
    const create = vi.spyOn(tasks, "create");
    const runs = new AgentRunStore(join(directory, "runs.json"));
    const finish = vi.spyOn(runs, "finish");
    const service = new ChatService(cloud, model, tasks, runs, join(directory, "conversations.json"));
    services.push(service);
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");
    const requestId = "request-private-qa0153";

    const first = await service.send(
      session.id, "tenant-1", "Download the private URL into a new inert file.", requestId,
    );
    expect(first.task).toBeUndefined();
    expect(first.message).toMatchObject({
      request_id: requestId,
      route: "clarify",
      task_phase: "completion",
      content: "请求的工具参数未通过安全校验，因此没有执行或写入任何内容。",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(connections.send).not.toHaveBeenCalled();
    expect(finish).toHaveBeenLastCalledWith(expect.any(String), "FAILED", expect.objectContaining({
      code: "AGENT_LOOP_TOOL_VALIDATION_REJECTED", stage: "initial_tool_validation",
    }));

    const replay = await service.send(
      session.id, "tenant-1", "Download the private URL into a new inert file.", requestId,
    );
    expect(replay.message.id).toBe(first.message.id);
    expect(decideAgentLoop).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    new BadRequestException("Intent must contain 1-2000 characters"),
    new Error("storage unavailable"),
  ])("does not swallow a non-agent-validation create failure: %s", async (cause) => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-qa0153-narrow-catch-"));
    directories.push(directory);
    const cloud = cloudWithInstance();
    const tasks = {
      create: vi.fn().mockRejectedValue(cause), get: vi.fn(), bindAgentApproval: vi.fn(),
      agentLoopObservation: vi.fn(), complete: vi.fn(),
    } as unknown as TasksService;
    const decideAgentLoop = vi.fn().mockResolvedValue({
      status: "answered", requestId: "model-failure", decision: {
        action: "tool_call", tool: "file.download",
        arguments: { url: "https://example.org/a.bin", target: "downloads/a.bin" }, reason: "download",
      },
    });
    const model = { decideAgentLoop, route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const runs = new AgentRunStore(join(directory, "runs.json"));
    const finish = vi.spyOn(runs, "finish");
    const service = new ChatService(cloud, model, tasks, runs, join(directory, "conversations.json"));
    services.push(service);
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");

    const requestId = cause instanceof BadRequestException ? "request-narrow-bad-request" : "request-narrow-error";
    await expect(service.send(session.id, "tenant-1", "download it", requestId)).rejects.toBe(cause);
    expect(finish).not.toHaveBeenCalled();
    expect((await service.messages(session.id, "tenant-1")).filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  it.each(["AGENT_TERMINAL_EVIDENCE_INCOMPLETE", "AGENT_TERMINAL_REVIEW_INVALID"])(
    "renders a byte-exact public download when terminal model finalization returns %s", async (errorCode) => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-qa0153-download-final-"));
    directories.push(directory);
    const cloud = cloudWithInstance();
    const observed = downloadResult();
    const observation = downloadObservation(observed);
    const record = {
      id: "task-download", state: "SUCCEEDED", evidence: [{ kind: "download", summary: "created" }],
      plan: { agent_execution: { tool_call_id: "" } },
    };
    const tasks = {
      create: vi.fn(async (input: { agentToolCall: { toolCallId: string } }) => {
        observation.tool_call_id = input.agentToolCall.toolCallId;
        record.plan.agent_execution.tool_call_id = input.agentToolCall.toolCallId;
        return record;
      }),
      get: vi.fn((id: string) => id === record.id ? record : undefined),
      bindAgentApproval: vi.fn(),
      agentLoopObservation: vi.fn((id: string) => id === record.id ? observation : undefined),
      complete: vi.fn(),
    } as unknown as TasksService;
    const decideAgentLoop = vi.fn()
      .mockResolvedValueOnce({ status: "answered", requestId: "model-download", decision: {
        action: "tool_call", tool: "file.download",
        arguments: { url: "https://example.org/release.bin", target: observed.target },
        reason: "Download the requested public artifact without executing it.",
      } })
      .mockResolvedValue({ status: "unavailable", error: errorCode });
    const model = { decideAgentLoop, route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const runs = new AgentRunStore(join(directory, "runs.json"));
    const finish = vi.spyOn(runs, "finish");
    const service = new ChatService(cloud, model, tasks, runs, join(directory, "conversations.json"));
    services.push(service);
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");
    await service.send(session.id, "tenant-1", "请下载公开文件并告诉我文件路径、字节数和校验值。", "request-download-qa0153");

    await vi.waitFor(async () => expect((await service.messages(session.id, "tenant-1")).at(-1)).toMatchObject({
      task_id: record.id,
      task_phase: "completion",
      content: `已下载并创建 ${observed.target}：${observed.size_bytes} 字节，SHA-256 ${observed.sha256}。`,
    }));
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(decideAgentLoop).toHaveBeenCalledTimes(3);
    expect(finish).toHaveBeenLastCalledWith(expect.any(String), "SUCCEEDED", expect.objectContaining({
      observation_status: "succeeded",
    }));
  });

  it("keeps an evidence-grounded model final ahead of the deterministic download fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-qa0153-model-priority-"));
    directories.push(directory);
    const cloud = cloudWithInstance();
    const observed = downloadResult();
    const observation = downloadObservation(observed);
    const record = {
      id: "task-model-priority", state: "SUCCEEDED", evidence: [{ kind: "download", summary: "created" }],
      plan: { agent_execution: { tool_call_id: "" } },
    };
    const tasks = {
      create: vi.fn(async (input: { agentToolCall: { toolCallId: string } }) => {
        observation.tool_call_id = input.agentToolCall.toolCallId;
        record.plan.agent_execution.tool_call_id = input.agentToolCall.toolCallId;
        return record;
      }),
      get: vi.fn((id: string) => id === record.id ? record : undefined), bindAgentApproval: vi.fn(),
      agentLoopObservation: vi.fn((id: string) => id === record.id ? observation : undefined), complete: vi.fn(),
    } as unknown as TasksService;
    const modelAnswer = "文件已通过读取验证，可以使用。";
    const decideAgentLoop = vi.fn()
      .mockResolvedValueOnce({ status: "answered", requestId: "model-priority-initial", decision: {
        action: "tool_call", tool: "file.download",
        arguments: { url: "https://example.org/release.bin", target: observed.target }, reason: "download",
      } })
      .mockResolvedValue({ status: "answered", requestId: "model-priority-final", decision: {
        action: "final", answer: modelAnswer, citations: ["call-download"],
      } });
    const model = { decideAgentLoop, route: vi.fn(), routeStream: vi.fn() } as unknown as ModelGatewayService;
    const runs = new AgentRunStore(join(directory, "runs.json"));
    const service = new ChatService(cloud, model, tasks, runs, join(directory, "conversations.json"));
    services.push(service);
    await service.onModuleInit();
    const session = await service.create("tenant-1", "instance-1");
    await service.send(session.id, "tenant-1", "请下载这个公开文件。", "request-model-priority");

    await vi.waitFor(async () => expect((await service.messages(session.id, "tenant-1")).at(-1)).toMatchObject({
      task_id: record.id, task_phase: "completion", content: modelAnswer,
    }));
  });

  it("fails closed when the download readback evidence is missing or disagrees", () => {
    const observed = downloadResult();
    const missingReadback = downloadObservation(observed);
    (missingReadback.data as { observations: unknown[] }).observations.pop();
    expect(renderVerifiedFileDownloadFinal("download it", [missingReadback])).toBeUndefined();

    const mismatchedReadback = downloadObservation(observed);
    const entries = (mismatchedReadback.data as { observations: Array<{ observed: Record<string, unknown> }> }).observations;
    entries[1]!.observed = { ...entries[1]!.observed, sha256: "b".repeat(64) };
    expect(renderVerifiedFileDownloadFinal("download it", [mismatchedReadback])).toBeUndefined();
  });

  it.each([
    ["duplicate create evidence", (items: AgentLoopObservation[]) => {
      const entries = observationEntries(items[0]!);
      entries.push(structuredClone(entries[0]!));
    }],
    ["an extra result field", (items: AgentLoopObservation[]) => {
      for (const entry of observationEntries(items[0]!)) entry.observed.extra = true;
    }],
    ["an invalid target", (items: AgentLoopObservation[]) => {
      for (const entry of observationEntries(items[0]!)) entry.observed.target = "plugins/a.jar";
    }],
    ["an invalid source hash", (items: AgentLoopObservation[]) => {
      for (const entry of observationEntries(items[0]!)) entry.observed.source_url_sha256 = "A".repeat(64);
    }],
    ["an invalid size", (items: AgentLoopObservation[]) => {
      for (const entry of observationEntries(items[0]!)) entry.observed.size_bytes = 0;
    }],
    ["different evidence steps", (items: AgentLoopObservation[]) => {
      observationEntries(items[0]!)[1]!.step_id = "s2";
    }],
    ["more than one top-level call", (items: AgentLoopObservation[]) => {
      items.push(structuredClone(items[0]!));
    }],
  ] as Array<[string, (items: AgentLoopObservation[]) => void]>) (
    "rejects download projection with %s", (_label, mutate) => {
      const items = [downloadObservation(downloadResult())];
      mutate(items);
      expect(renderVerifiedFileDownloadFinal("download it", items)).toBeUndefined();
    },
  );

  it.each(["missing", "mismatched"] as const)(
    "keeps the producer observation failed when byte readback is %s", async (mode) => {
      const cloud = cloudWithInstance();
      const connections = { send: vi.fn().mockReturnValue(true) } as unknown as AgentConnectionRegistry;
      const model = { compileIntent: vi.fn(), proposeConfirmedWrite: vi.fn(), answer: vi.fn(), decideRecovery: vi.fn() } as unknown as ModelGatewayService;
      const tasks = new TasksService(cloud, connections, model);
      const url = "https://example.org/qa0153.bin";
      const observed = {
        ...downloadResult(), target: "downloads/qa0153.bin",
        source_url_sha256: createHash("sha256").update(url).digest("hex"),
      };
      const task = await tasks.create({
        tenantId: "tenant-1", instanceRef: "instance-1", intent: "download it",
        assistantResponse: "Downloading.", modelStatus: "answered",
        agentToolCall: { toolCallId: `call-${mode}`, action: "tool_call", tool: "file.download", arguments: { url, target: observed.target }, reason: "download" },
      });
      await tasks.recordAgentEvent({ task_id: task.id, kind: "download", step_id: "s1", tool: "file.download", summary: "created", observed });
      if (mode === "mismatched") {
        await tasks.recordAgentEvent({
          task_id: task.id, kind: "verification.download", step_id: "s1", tool: "file.download", summary: "verified",
          observed: { ...observed, sha256: "b".repeat(64) },
        });
      }
      await tasks.recordAgentEvent({ task_id: task.id, state: "SUCCEEDED", kind: "execution", summary: "done", tool_calls: 1 });
      expect(tasks.agentLoopObservation(task.id, "tenant-1")).toMatchObject({ status: "failed" });
    },
  );

  function cloudWithInstance() {
    const cloud = new CloudStore();
    cloud.instances.set("instance-1", {
      instance_id: "instance-1", name: "Test", platform: "paper", minecraft_version: "1.21.1", state: "stopped",
      profile_revision: "rev-1", provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      tenant_id: "tenant-1", agent_id: "agent-1",
    });
    return cloud;
  }

  function downloadResult() {
    return {
      schema_version: "file-download-result/v1", target: "downloads/provider-release.bin", size_bytes: 237,
      sha256: "a".repeat(64), source_url_sha256: "c".repeat(64), created: true,
    };
  }

  function observationEntries(observation: AgentLoopObservation) {
    return (observation.data as { observations: Array<{
      kind: string; step_id: string; tool: string; observed: Record<string, unknown>; result: string;
    }> }).observations;
  }

  function downloadObservation(observed: ReturnType<typeof downloadResult>): AgentLoopObservation {
    return {
      tool_call_id: "call-download", tool: "file.download", status: "succeeded", retryable: false,
      side_effect: "applied", evidence: { ids: ["e-download", "e-readback"], summaries: ["created", "verified"] },
      data: {
        task_id: "task-download", task_state: "SUCCEEDED", goal_results: [], observations: [
          { kind: "download", step_id: "s1", tool: "file.download", observed: { ...observed }, result: "match" },
          { kind: "verification.download", step_id: "s1", tool: "file.download", observed: { ...observed }, result: "match" },
        ],
      },
    };
  }
});
