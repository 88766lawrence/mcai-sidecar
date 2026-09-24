import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunStore } from "./agent-run.store";

describe("QA0144 in-flight session deletion", () => {
  it("keeps a scrubbed cancellation tombstone and makes late model callbacks harmless", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcai-qa0144-run-"));
    try {
      const path = join(directory, "agent-runs.json");
      const store = new AgentRunStore(path);
      const run = await store.create({
        tenant_id: "tenant-1", session_id: "session-race", instance_ref: "instance-1",
        original_user_message: "private user text", system_prompt: "private system text",
        prompt_version: "p1", tool_catalog_version: "t1", policy_version: "o1",
      });
      expect(await store.removeBySession("session-race", "tenant-1")).toMatchObject({ removed_runs: 1 });
      await expect(store.recordDecision(run.run_id, 1, { action: "final", answer: "late" })).resolves.toMatchObject({ status: "CANCELLED" });
      await expect(store.recordDecisionError(run.run_id, 1, { code: "late" })).resolves.toMatchObject({ status: "CANCELLED" });
      const restored = await new AgentRunStore(path).get(run.run_id, "tenant-1");
      expect(restored).toMatchObject({ status: "CANCELLED", original_user_message: "", system_prompt: "", calls: [], observations: [] });
      expect(restored?.model_name).toBeUndefined();
      expect(await store.events(run.run_id)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
