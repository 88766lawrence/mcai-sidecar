import type { AgentLoopToolName } from "./agent-loop";

export type AgentEvalCategory = "single" | "multi" | "recovery" | "approval" | "honest_failure" | "context" | "restart";
export interface AgentEvalCase {
  id: string;
  category: AgentEvalCategory;
  prompt: string;
  expected_tools: AgentLoopToolName[];
  expected_terminal: "final" | "cannot_proceed" | "waiting_approval";
  requires_confirmation: boolean;
  fault?: "retryable" | "non_retryable" | "empty" | "indeterminate" | "restart";
}

const single: Array<[string, AgentLoopToolName, string]> = [
  ["server implementation and game version", "console.command", "version"],
  ["online player count", "console.command", "list"],
  ["loaded plugin names", "console.command", "plugins"],
  ["mobGriefing value", "console.command", "gamerule mobGriefing"],
  ["keepInventory value", "console.command", "gamerule keepInventory"],
  ["world seed", "console.command", "seed"],
  ["world border diameter", "console.command", "worldborder get"],
  ["world game time", "console.command", "time query gametime"],
  ["enabled datapacks", "console.command", "datapack list enabled"],
  ["available datapacks", "console.command", "datapack list available"],
  ["whitelist members", "console.command", "whitelist list"],
  ["banned players", "console.command", "banlist players"],
  ["scoreboard teams", "console.command", "team list"],
  ["scoreboard objectives", "console.command", "scoreboard objectives list"],
  ["forced chunks", "console.command", "forceload query"],
  ["server.properties MOTD", "config.inspect", "motd"],
  ["view and simulation distance", "config.inspect", "view-distance"],
  ["JAR files in plugins", "files.list", "/plugins"],
  ["JSON files in world stats", "files.list", "/world/stats"],
  ["recent lag warnings", "logs.query", "cannot_keep_up"],
  ["process uptime and memory", "instance.metrics", "uptime"],
  ["first online player's gamemode", "players.inspect", "gamemode"],
  ["ViaVersion metadata for Paper", "plugin.resolve", "viaversion"],
  ["LuckPerms metadata for Paper", "plugin.resolve", "luckperms"],
  ["crash report files", "files.list", "/crash-reports"],
];

const promptForms = [
  (goal: string) => `Please read the current ${goal}; do not change anything.`,
  (goal: string) => `Without modifying the server, tell me the actual ${goal}.`,
  (goal: string) => `Check ${goal} on this server and report only verified results.`,
];

export const AGENT_EVAL_MATRIX: AgentEvalCase[] = [
  ...single.map(([goal, tool], index) => ({
    id: `single-${String(index + 1).padStart(2, "0")}`, category: "single" as const,
    prompt: promptForms[index % promptForms.length]!(goal), expected_tools: [tool], expected_terminal: "final" as const, requires_confirmation: false,
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    id: `multi-${String(index + 1).padStart(2, "0")}`, category: "multi" as const,
    prompt: index % 2 === 0
      ? `Read the online count and maximum capacity, then explain the occupancy using verified values only (variant ${index + 1}).`
      : `Read uptime, CPU and memory including capacity, then judge resource pressure (variant ${index + 1}).`,
    expected_tools: index % 2 === 0 ? (["console.command", "config.inspect"] satisfies AgentLoopToolName[]) : (["instance.metrics"] satisfies AgentLoopToolName[]),
    expected_terminal: "final" as const, requires_confirmation: false,
  })),
  ...Array.from({ length: 15 }, (_, index) => ({
    id: `recovery-${String(index + 1).padStart(2, "0")}`, category: "recovery" as const,
    prompt: `Locate the requested safe instance data and adapt honestly if the first read fails (variant ${index + 1}).`,
    expected_tools: index % 3 === 0 ? (["files.list", "files.list"] satisfies AgentLoopToolName[]) : index % 3 === 1 ? (["logs.query", "console.command"] satisfies AgentLoopToolName[]) : (["config.inspect"] satisfies AgentLoopToolName[]),
    expected_terminal: index % 3 === 2 ? "cannot_proceed" as const : "final" as const,
    requires_confirmation: false, fault: index % 3 === 0 ? "retryable" as const : "non_retryable" as const,
  })),
  ...Array.from({ length: 15 }, (_, index) => ({
    id: `approval-${String(index + 1).padStart(2, "0")}`, category: "approval" as const,
    prompt: index % 3 === 0 ? `Make the weather clear once (variant ${index + 1}).` : index % 3 === 1 ? `Start this stopped instance once (variant ${index + 1}).` : `Apply the bounded configuration change after I approve it (variant ${index + 1}).`,
    expected_tools: [index % 3 === 0 ? "console.command" : index % 3 === 1 ? "instance.start" : "config.patch"] satisfies AgentLoopToolName[],
    expected_terminal: "waiting_approval" as const, requires_confirmation: true,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `honest-${String(index + 1).padStart(2, "0")}`, category: "honest_failure" as const,
    prompt: `Report the bounded result honestly when the provider returns no usable target or capability (variant ${index + 1}).`,
    expected_tools: [index % 2 ? "console.command" : "plugin.resolve"] satisfies AgentLoopToolName[], expected_terminal: "cannot_proceed" as const,
    requires_confirmation: index % 2 === 1, fault: index % 2 ? "indeterminate" as const : "empty" as const,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `context-${String(index + 1).padStart(2, "0")}`, category: "context" as const,
    prompt: `Using the selected instance and the preceding request, read the same target's related value (variant ${index + 1}).`,
    expected_tools: [index % 2 ? "config.inspect" : "console.command"] satisfies AgentLoopToolName[], expected_terminal: "final" as const, requires_confirmation: false,
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `restart-${String(index + 1).padStart(2, "0")}`, category: "restart" as const,
    prompt: `Continue this exact run after a Cloud process restart without repeating completed calls (variant ${index + 1}).`,
    expected_tools: [index % 2 ? "config.inspect" : "console.command"] satisfies AgentLoopToolName[], expected_terminal: "final" as const,
    requires_confirmation: false, fault: "restart" as const,
  })),
];
