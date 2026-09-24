import { afterEach, describe, expect, it, vi } from "vitest";
import { apiStream } from "./api";

describe("apiStream event pacing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for an async status renderer before consuming the following event", async () => {
    const bytes = new TextEncoder().encode([
      JSON.stringify({ type: "status", text: "正在理解请求" }),
      JSON.stringify({ type: "done", result: { message: { id: "message-1" } } }),
      "",
    ].join("\n"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }))));
    const seen: string[] = [];
    let releasePaint!: () => void;
    const painted = new Promise<void>((resolve) => { releasePaint = resolve; });

    const pending = apiStream<{ type: string }>("/stream", {}, async (event) => {
      seen.push(event.type);
      if (event.type === "status") await painted;
    });

    await vi.waitFor(() => expect(seen).toEqual(["status"]));
    releasePaint();
    await pending;
    expect(seen).toEqual(["status", "done"]);
  });
});
