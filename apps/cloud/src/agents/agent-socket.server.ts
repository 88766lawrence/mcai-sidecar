import { Injectable, Logger } from "@nestjs/common";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEnvelope, ServerProfile } from "@mcai/contracts";
import { AGENT_MESSAGE_SCHEMA_VERSION } from "@mcai/contracts";
import { AgentConnectionRegistry } from "./agent-connection.registry";
import { PairingService } from "../pairing/pairing.service";
import { CloudStore } from "../store/cloud.store";
import { TasksService } from "../tasks/tasks.service";

@Injectable()
export class AgentSocketServer {
  private readonly logger = new Logger(AgentSocketServer.name);
  private readonly seenNonces = new Map<string, number>();

  constructor(
    private readonly registry: AgentConnectionRegistry,
    private readonly pairing: PairingService,
    private readonly store: CloudStore,
    private readonly tasks: TasksService,
  ) {}

  attach(server: HttpServer) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== "/agent") return socket.destroy();
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });
    wss.on("connection", (socket, request) => this.handleConnection(socket, request));
  }

  private handleConnection(socket: WebSocket, _request: IncomingMessage) {
    let agentId = "";
    const helloTimeout = setTimeout(() => socket.close(4000, "hello timeout"), 10_000);
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as AgentEnvelope<Record<string, unknown>>;
        if (message.schema_version !== AGENT_MESSAGE_SCHEMA_VERSION) throw new Error("unsupported schema");
        if (!message.agent_id || !message.type) throw new Error("invalid envelope");
        this.verifyEnvelope(message);
        agentId = message.agent_id;
        if (message.type === "agent.hello") {
          clearTimeout(helloTimeout);
          this.handleHello(socket, message);
        } else if (message.type === "inventory.report") {
          this.handleInventory(message as AgentEnvelope<{ instances: ServerProfile[] }>);
        } else if (message.type === "task.event") {
          void this.tasks.recordAgentEvent(message.payload);
        } else if (message.type === "heartbeat") {
          const agent = this.store.agents.get(agentId);
          if (agent) agent.lastSeen = new Date().toISOString();
        }
      } catch (error) {
        this.logger.warn(`Rejected agent message: ${error instanceof Error ? error.message : "unknown"}`);
        socket.close(4002, "invalid message");
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimeout);
      if (!agentId) return;
      this.registry.disconnect(agentId, socket);
      const agent = this.store.agents.get(agentId);
      if (agent) agent.status = "offline";
    });
  }

  private handleHello(socket: WebSocket, message: AgentEnvelope<Record<string, unknown>>) {
    const payload = message.payload;
    const code = String(payload.pairing_code ?? "");
    const existing = this.store.agents.get(message.agent_id);
    const autoTenant = process.env.MCAI_AUTO_PAIR_TENANT ?? "";
    if (!existing && autoTenant && message.tenant_id === autoTenant) {
      this.store.agents.set(message.agent_id, {
        id: message.agent_id,
        tenantId: autoTenant,
        publicKey: String(payload.public_key ?? ""),
        displayName: String(payload.display_name ?? message.agent_id),
        version: String(payload.version ?? "dev"),
        status: "online",
        lastSeen: new Date().toISOString(),
      });
    } else if (!existing?.tenantId) {
      this.pairing.register({
        code,
        agentId: message.agent_id,
        publicKey: String(payload.public_key ?? ""),
        displayName: String(payload.display_name ?? message.agent_id),
        version: String(payload.version ?? "dev"),
      });
    } else {
      existing.status = "online";
      existing.lastSeen = new Date().toISOString();
    }
    const connected = this.store.agents.get(message.agent_id);
    this.registry.connect(message.agent_id, socket);
    socket.send(JSON.stringify({
      schema_version: AGENT_MESSAGE_SCHEMA_VERSION,
      message_id: randomUUID(),
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
      tenant_id: connected?.tenantId ?? "",
      agent_id: message.agent_id,
      type: "agent.welcome",
      payload: { paired: Boolean(connected?.tenantId), heartbeat_seconds: 20 },
    }));
  }

  private handleInventory(message: AgentEnvelope<{ instances: ServerProfile[] }>) {
    const agent = this.store.agents.get(message.agent_id);
    if (!agent?.tenantId) return;
    for (const profile of message.payload.instances ?? []) {
      this.store.instances.set(profile.instance_id, { ...profile, tenant_id: agent.tenantId, agent_id: agent.id });
    }
  }

  private verifyEnvelope(message: AgentEnvelope<Record<string, unknown>>) {
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 2 * 60_000) throw new Error("message timestamp outside the allowed window");
    const replayKey = `${message.agent_id}:${message.nonce}`;
    if (!message.nonce || this.seenNonces.has(replayKey)) throw new Error("replayed nonce");
    const existing = this.store.agents.get(message.agent_id);
    const publicKeyText = existing?.publicKey ?? (message.type === "agent.hello" ? String(message.payload.public_key ?? "") : "");
    if (!publicKeyText || !message.signature) throw new Error("missing device signature");
    const rawPublicKey = Buffer.from(publicKeyText, "base64");
    if (rawPublicKey.length !== 32) throw new Error("invalid Ed25519 public key");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const key = createPublicKey({ key: Buffer.concat([spkiPrefix, rawPublicKey]), format: "der", type: "spki" });
    const payloadHash = createHash("sha256").update(JSON.stringify(message.payload)).digest("hex");
    const canonical = [message.message_id, message.timestamp, message.nonce, message.tenant_id, message.agent_id, message.type, payloadHash].join("|");
    if (!verify(null, Buffer.from(canonical), key, Buffer.from(message.signature, "base64"))) throw new Error("invalid device signature");
    if (existing?.tenantId && message.tenant_id !== existing.tenantId) throw new Error("tenant mismatch");
    this.seenNonces.set(replayKey, Date.now());
    if (this.seenNonces.size > 10_000) {
      const cutoff = Date.now() - 2 * 60_000;
      for (const [nonce, seenAt] of this.seenNonces) if (seenAt < cutoff) this.seenNonces.delete(nonce);
    }
  }
}
