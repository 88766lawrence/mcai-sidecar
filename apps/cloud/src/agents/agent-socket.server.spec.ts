import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { AgentSocketServer } from "./agent-socket.server";
import { AgentConnectionRegistry } from "./agent-connection.registry";
import { CloudStore } from "../store/cloud.store";
import type { PairingService } from "../pairing/pairing.service";
import type { TasksService } from "../tasks/tasks.service";

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; });
}

describe("signed Agent connection isolation", () => {
  const sockets: FakeSocket[] = [];
  afterEach(() => { for (const socket of sockets.splice(0)) socket.emit("close"); });

  function setup() {
    const store = new CloudStore();
    const registry = new AgentConnectionRegistry();
    const recordAgentEvent = vi.fn().mockResolvedValue(undefined);
    const keys = { a: generateKeyPairSync("ed25519"), b: generateKeyPairSync("ed25519") };
    for (const id of ["a", "b"] as const) {
      store.agents.set(id, {
        id, tenantId: "tenant", publicKey: keys[id].publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
        displayName: id, version: "test", status: "online", lastSeen: new Date().toISOString(),
      });
      store.instances.set(id, {
        instance_id: id, agent_id: id, tenant_id: "tenant", name: id, platform: "paper",
        minecraft_version: "1.21.1", state: "running", profile_revision: "rev",
        provider_type: "mcsmanager", collected_at: new Date().toISOString(),
      });
    }
    const server = new AgentSocketServer(registry, {} as PairingService, store, { recordAgentEvent } as unknown as TasksService);
    const connect = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      (server as unknown as { handleConnection(socket: WebSocket, request: IncomingMessage): void })
        .handleConnection(socket as unknown as WebSocket, {} as IncomingMessage);
      return socket;
    };
    const send = (socket: FakeSocket, id: "a" | "b", type: string, payload: Record<string, unknown> = {}) => {
      const message = {
        schema_version: "agent-message/v1", message_id: randomUUID(), timestamp: new Date().toISOString(),
        nonce: randomUUID(), tenant_id: "tenant", agent_id: id, type, payload,
      };
      const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const canonical = [message.message_id, message.timestamp, message.nonce, message.tenant_id, id, type, hash].join("|");
      socket.emit("message", Buffer.from(JSON.stringify({ ...message, signature: sign(null, Buffer.from(canonical), keys[id].privateKey).toString("base64") })));
    };
    return { store, registry, connect, send, recordAgentEvent };
  }

  it("requires hello before accepting signed inventory", () => {
    const { connect, send } = setup();
    const socket = connect();
    send(socket, "a", "inventory.report", { instances: [] });
    expect(socket.close).toHaveBeenCalledWith(4002, "invalid message");
  });

  it("binds a socket to the identity established by hello", () => {
    const { connect, send } = setup();
    const socket = connect();
    send(socket, "a", "agent.hello");
    send(socket, "b", "heartbeat");
    expect(socket.close).toHaveBeenCalledWith(4002, "invalid message");
  });

  it("does not mark a replacement connection offline when the old socket closes", () => {
    const { connect, send, store, registry } = setup();
    const old = connect();
    send(old, "a", "agent.hello");
    send(connect(), "a", "agent.hello");
    old.emit("close");
    expect(registry.isOnline("a")).toBe(true);
    expect(store.agents.get("a")?.status).toBe("online");
  });

  it("does not let another agent replace an existing instance", () => {
    const { connect, send, store } = setup();
    const socket = connect();
    send(socket, "a", "agent.hello");
    send(socket, "a", "inventory.report", { instances: [store.instances.get("b")] });
    expect(store.instances.get("b")?.agent_id).toBe("b");
    expect(socket.close).toHaveBeenCalledWith(4002, "invalid message");
  });

  it.each(["a", "b"] as const)("only accepts task events from owning agent: %s", id => {
    const { connect, send, store, recordAgentEvent } = setup();
    store.tasks.set("task", { id: "task", instance_ref: "b", tenant_id: "tenant" } as never);
    const socket = connect();
    send(socket, id, "agent.hello");
    send(socket, id, "task.event", { task_id: "task", state: "SUCCEEDED" });
    expect(recordAgentEvent).toHaveBeenCalledTimes(id === "b" ? 1 : 0);
  });
});
