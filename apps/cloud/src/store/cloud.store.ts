import { Injectable } from "@nestjs/common";
import type { ConversationMessage, ConversationSession, ServerProfile, TaskRecord } from "@mcai/contracts";

export interface AgentRecord {
  id: string;
  tenantId?: string;
  publicKey: string;
  displayName: string;
  version: string;
  status: "pending" | "online" | "offline";
  lastSeen: string;
}

export interface PairingRecord {
  code: string;
  agentId: string;
  expiresAt: string;
  claimedAt?: string;
}

@Injectable()
export class CloudStore {
  readonly agents = new Map<string, AgentRecord>();
  readonly pairings = new Map<string, PairingRecord>();
  readonly instances = new Map<string, ServerProfile & { tenant_id: string; agent_id: string }>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly sessions = new Map<string, ConversationSession>();
  readonly messages = new Map<string, ConversationMessage[]>();

  constructor() {
    if (process.env.MCAI_DEV_SEED !== "1") return;
    const now = new Date().toISOString();
    this.agents.set("agent_demo", {
      id: "agent_demo", tenantId: "tenant_demo", publicKey: "development-only",
      displayName: "Hong Kong Node 01", version: "0.1.0", status: "offline", lastSeen: now,
    });
    this.instances.set("mcs:daemon-demo:survival", {
      instance_id: "mcs:daemon-demo:survival", name: "生存服", platform: "paper",
      minecraft_version: "1.21.4", state: "running", loader: "Paper",
      profile_revision: "3f97a1d89bf129bda934998ddc2db8aa", provider_type: "mcsmanager",
      collected_at: now, tenant_id: "tenant_demo", agent_id: "agent_demo",
    });
  }
}
