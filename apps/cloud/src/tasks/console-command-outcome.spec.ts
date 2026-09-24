import { classifyConsoleCommandOutcome } from "@mcai/contracts";
import { describe, expect, it } from "vitest";

describe("console command outcome policy", () => {
  it("uses the guarded audience command to classify a failed condition as zero targets", () => {
    const command = "execute if entity @a run execute as @a at @s run particle minecraft:happy_villager ~ ~1 ~ 0.25 0.25 0.25 0 5 force @s";
    expect(classifyConsoleCommandOutcome("控制台返回：\nTest failed", true, command)).toMatchObject({
      status: "rejected", code: "NO_TARGETS",
    });
    expect(classifyConsoleCommandOutcome("控制台返回：\nTest failed", true)).toMatchObject({
      status: "indeterminate", code: "INCOMPLETE_CALLBACK",
    });
  });

  it.each([
    ["No player was found", "rejected", "NO_TARGETS"],
    ["No entities matched the selector", "rejected", "NO_TARGETS"],
    ["没有找到任何目标", "rejected", "NO_TARGETS"],
    ["Unknown command. Type /help", "rejected", "INVALID_COMMAND"],
    ["Incorrect argument for command", "rejected", "INVALID_COMMAND"],
    ["Permission denied", "rejected", "PERMISSION_DENIED"],
    ["Failed to execute command", "rejected", "EXECUTION_ERROR"],
    ["Set the weather to clear", "applied", "EXPLICIT_SUCCESS"],
    ["[Server] Welcome to the arena", "applied", "EXPLICIT_SUCCESS"],
    ["", "indeterminate", "EMPTY_CALLBACK"],
  ])("classifies %s", (output, status, code) => {
    expect(classifyConsoleCommandOutcome(output)).toMatchObject({
      schema_version: "console-command-outcome/v1", status, code,
    });
  });

  it.each([
    "Backup timed out while saving region files",
    "HTTP request returned no player profile field",
    "World statistics worker reported an error",
  ])("does not turn unrelated text into a target-selection rejection: %s", (output) => {
    expect(classifyConsoleCommandOutcome(output).status).toBe("accepted_unverified");
  });

  it.each([
    "t",
    "No pla",
    "Displayed mess",
    "\uFFFD",
    "arbitrary transport fragment",
  ])("fails closed for strict write callback fragments: %s", (output) => {
    expect(classifyConsoleCommandOutcome(output, true)).toMatchObject({
      status: "indeterminate",
      code: "INCOMPLETE_CALLBACK",
    });
  });

  it.each([
    "Displayed message to 3 players",
    "[Server] Tournament registration is open",
  ])("accepts explicit strict write success: %s", (output) => {
    expect(classifyConsoleCommandOutcome(output, true)).toMatchObject({
      status: "applied",
      code: "EXPLICIT_SUCCESS",
    });
  });
});
