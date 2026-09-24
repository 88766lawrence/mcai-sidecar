import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchRegisteredCapability } from "./capability-registry";

describe("registered executable capability templates", () => {
  it.each([
    ["Review recent logs for memory exhaustion or a server falling behind; count matches and assess impact.", [["memory_resource"], ["server_lag"]]],
    ["Review recent logs for a server falling behind or authentication denied; count matches and assess impact.", [["server_lag"], ["client_connection"]]],
    ["Review logs for authentication denied or world chunk corruption or out of memory; count matches and assess impact.", [["client_connection"], ["world_storage"], ["memory_resource"]]],
    ["\u68c0\u67e5\u6700\u8fd1\u4e00\u5c0f\u65f6\u65e5\u5fd7\u91cc\u6709\u6ca1\u6709\u5185\u5b58\u4e0d\u8db3\u6216\u8005\u670d\u52a1\u5668\u8ddf\u4e0d\u4e0a\u8fd0\u884c\u7684\u62a5\u9519\uff0c\u544a\u8bc9\u6211\u5339\u914d\u6570\u91cf\uff0c\u5e76\u5224\u65ad\u662f\u5426\u9700\u8981\u5904\u7406\u3002", [["memory_resource"], ["server_lag"]]],
  ])("compiles registered OR concepts in source order: %s", (intent, expected) => {
    const match = matchRegisteredCapability(intent);
    expect(match?.id).toBe("logs.registered-observation");
    if (match?.id !== "logs.registered-observation") throw new Error("missing log capability");
    expect(match.args.filter_query.groups.map((group) => group.all_of)).toEqual(expected);
    expect(match.resultKinds).toEqual(["collection", "count", "judgement"]);
  });

  it("fails closed to the AI fallback when any explicit branch is unregistered", () => {
    expect(matchRegisteredCapability("Review logs for memory exhaustion or moon phase drift; count and assess.")) .toBeUndefined();
  });

  it("matches the published Chinese log request and preserves exact source spans", () => {
    const intent = "\u68c0\u67e5\u6700\u8fd1\u4e00\u5c0f\u65f6\u65e5\u5fd7\u91cc\u6709\u6ca1\u6709\u5185\u5b58\u4e0d\u8db3\u6216\u8005\u670d\u52a1\u5668\u8ddf\u4e0d\u4e0a\u8fd0\u884c\u7684\u62a5\u9519\uff0c\u544a\u8bc9\u6211\u5339\u914d\u6570\u91cf\uff0c\u5e76\u5224\u65ad\u662f\u5426\u9700\u8981\u5904\u7406\u3002";
    const match = matchRegisteredCapability(intent);
    expect(match?.id).toBe("logs.registered-observation");
    expect(match?.sourceSpans.map((span) => span.text)).toEqual(["\u5185\u5b58\u4e0d\u8db3", "\u670d\u52a1\u5668\u8ddf\u4e0d\u4e0a"]);
    expect(match?.sourceSpans.every((span) => intent.slice(span.start, span.end) === span.text)).toBe(true);
  });

  it("matches the published Chinese E4 structure with running-language after the lag concept", () => {
    const intent = "\u68c0\u67e5\u6700\u8fd1\u4e00\u5c0f\u65f6\u65e5\u5fd7\u91cc\u6709\u6ca1\u6709\u5185\u5b58\u4e0d\u8db3\u6216\u8005\u670d\u52a1\u5668\u8ddf\u4e0d\u4e0a\u8fd0\u884c\u7684\u62a5\u9519\uff0c\u544a\u8bc9\u6211\u5339\u914d\u6570\u91cf\uff0c\u5e76\u5224\u65ad\u662f\u5426\u9700\u8981\u5904\u7406\u3002";
    expect(matchRegisteredCapability(intent)?.id).toBe("logs.registered-observation");
  });

  it.each([
    "\u8bf7\u53ea\u8bfb\u5217\u51fa\u6d3b\u8dc3\u63d2\u4ef6\u540d\u79f0\u5e76\u7edf\u8ba1\u603b\u6570\u3002",
    "Show the loaded plugin inventory and total count, read only.",
  ])("selects the read-only plugin inventory template: %s", (intent) => {
    expect(matchRegisteredCapability(intent)).toMatchObject({ id: "plugins.loaded-inventory", tool: "console.command", args: { command: "plugins" }, risk: "read", requiresConfirmation: false });
  });

  it("does not confuse plugin mutation with inventory", () => {
    expect(matchRegisteredCapability("Download and install a plugin, then list plugins.")) .toBeUndefined();
  });

  it("matches the published Chinese plugin inventory request", () => {
    const intent = "\u5f53\u524d\u670d\u52a1\u5668\u52a0\u8f7d\u4e86\u54ea\u4e9b\u63d2\u4ef6\uff1f\u8bf7\u628a\u63d2\u4ef6\u540d\u79f0\u548c\u603b\u6570\u4e00\u8d77\u544a\u8bc9\u6211\uff0c\u53ea\u8bfb\u67e5\u8be2\u3002";
    const match = matchRegisteredCapability(intent);
    expect(match?.id).toBe("plugins.loaded-inventory");
    expect(match?.sourceSpans.every((span) => intent.slice(span.start, span.end) === span.text)).toBe(true);
  });

  it("keeps the registry ASCII-only and free of common mojibake markers", () => {
    const bytes = readFileSync(fileURLToPath(new URL("./capability-registry.ts", import.meta.url)));
    const source = bytes.toString("utf8");
    expect(Buffer.from(source, "utf8").equals(bytes)).toBe(true);
    expect([...source].every((character) => character.charCodeAt(0) <= 0x7f)).toBe(true);
    expect(source).not.toMatch(/[\u9350\u93c8\u93bb\u8b81\u8930]/u);
  });
});
