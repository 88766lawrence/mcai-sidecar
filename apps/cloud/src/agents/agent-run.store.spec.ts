import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunStore } from "./agent-run.store";

describe("AgentRunStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("restores the active run, ordered events, calls and observations after a process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-run-"));
    directories.push(directory);
    const path = join(directory, "agent-runs.json");
    const first = new AgentRunStore(path);
    const run = await first.create({
      tenant_id: "tenant-1", session_id: "session-1", instance_ref: "instance-1",
      original_user_message: "Read the current version", system_prompt: "Use tools safely.",
      prompt_version: "prompt/v1", tool_catalog_version: "catalog/v1", policy_version: "policy/v1",
      current_task_id: "task-1",
      initial_call: { id: "call-1", key: "console.command:version", tool: "console.command", arguments: { command: "version" }, reason: "read version" },
    });
    await first.recordObservation(run.run_id, "task-1", {
      tool_call_id: "call-1", tool: "console.command", status: "succeeded", retryable: false, side_effect: "none",
      data: { version: "1.21.1" }, evidence: { ids: ["e1"], summaries: ["Paper 1.21.1"] },
    });
    await first.advance(run.run_id, "task-1", "task-2", {
      id: "call-2", key: "config.inspect:max-players", tool: "config.inspect",
      arguments: { path: "server.properties", keys: ["max-players"] }, reason: "read capacity",
    });

    const restarted = new AgentRunStore(path);
    const restored = await restarted.findByCurrentTask("task-2", "tenant-1");
    expect(restored).toMatchObject({
      run_id: run.run_id, status: "RUNNING", round_count: 2, tool_call_count: 2,
      current_task_id: "task-2", version: 3,
    });
    expect(restored?.calls.map((call) => call.id)).toEqual(["call-1", "call-2"]);
    expect(restored?.observations).toEqual([expect.objectContaining({ tool_call_id: "call-1", status: "succeeded" })]);
    expect((await restarted.events(run.run_id)).map((event) => [event.sequence, event.type])).toEqual([
      [1, "user_message"], [2, "tool_call"], [3, "tool_observation"], [4, "tool_call"],
    ]);
  });

  it("does not append or execute the same observation and call twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-run-"));
    directories.push(directory);
    const store = new AgentRunStore(join(directory, "agent-runs.json"));
    const run = await store.create({
      tenant_id: "tenant-1", session_id: "session-1", instance_ref: "instance-1",
      original_user_message: "Read version", system_prompt: "Safe", prompt_version: "p1", tool_catalog_version: "t1", policy_version: "o1",
      current_task_id: "task-1", initial_call: { id: "call-1", key: "k1", tool: "console.command", arguments: { command: "version" }, reason: "read" },
    });
    const observation = { tool_call_id: "call-1", tool: "console.command", status: "succeeded" as const, retryable: false, side_effect: "none" as const, evidence: { ids: ["e1"], summaries: ["ok"] } };
    await store.recordObservation(run.run_id, "task-1", observation);
    await store.recordObservation(run.run_id, "task-1", observation);
    const restored = await store.get(run.run_id, "tenant-1");
    expect(restored?.observations).toHaveLength(1);
    expect((await store.events(run.run_id)).filter((event) => event.type === "tool_observation")).toHaveLength(1);
  });

  it("persists approval suspension and resolution across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-run-"));
    directories.push(directory);
    const path = join(directory, "agent-runs.json");
    const first = new AgentRunStore(path);
    const run = await first.create({
      tenant_id: "tenant-1", session_id: "session-1", instance_ref: "instance-1",
      original_user_message: "Start it", system_prompt: "Safe", prompt_version: "p1", tool_catalog_version: "t1", policy_version: "o1",
      current_task_id: "task-1", initial_call: { id: "call-1", key: "k1", tool: "instance.start", arguments: { target: "instance-1" }, reason: "start" },
    });
    await first.putApproval({
      approval_id: "approval-1", run_id: run.run_id, call_id: "call-1", tool: "instance.start",
      canonical_arguments: { target: "instance-1" }, risk: "medium", summary: "Start instance", call_hash: "hash-1",
      status: "PENDING", created_at: new Date().toISOString(),
    });
    const restarted = new AgentRunStore(path);
    expect(await restarted.getApproval("approval-1")).toMatchObject({ status: "PENDING", run_id: run.run_id });
    expect(await restarted.get(run.run_id, "tenant-1")).toMatchObject({ status: "WAITING_APPROVAL" });
    await restarted.resolveApproval("approval-1", "APPROVED", "user-1");
    const twice = await restarted.resolveApproval("approval-1", "APPROVED", "user-1");
    expect(twice.status).toBe("APPROVED");
    expect((await restarted.events(run.run_id)).filter((event) => event.type === "approval_resolved")).toHaveLength(1);
  });

  it("atomically removes a deleted session's runs, events and approvals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-agent-run-"));
    directories.push(directory);
    const path = join(directory, "agent-runs.json");
    const store = new AgentRunStore(path);
    const run = await store.create({
      tenant_id: "tenant-1", session_id: "session-delete", instance_ref: "instance-1",
      original_user_message: "Prepare a write", system_prompt: "Safe", prompt_version: "p1", tool_catalog_version: "t1", policy_version: "o1",
      current_task_id: "task-1", initial_call: { id: "call-1", key: "k1", tool: "console.command", arguments: { command: "say hello" }, reason: "write" },
    });
    await store.putApproval({
      approval_id: "approval-delete", run_id: run.run_id, call_id: "call-1", tool: "console.command",
      canonical_arguments: { command: "say hello" }, risk: "medium", summary: "Broadcast", call_hash: "hash-delete",
      status: "PENDING", created_at: new Date().toISOString(),
    });
    expect(await store.removeBySession("session-delete", "tenant-1")).toMatchObject({ removed_runs: 1, removed_approvals: 1 });
    const restarted = new AgentRunStore(path);
    expect(await restarted.get(run.run_id, "tenant-1")).toBeUndefined();
    expect(await restarted.events(run.run_id)).toEqual([]);
    expect(await restarted.getApproval("approval-delete")).toBeUndefined();
  });
});
