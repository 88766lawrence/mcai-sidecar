import { Injectable } from "@nestjs/common";
import type { WebSocket } from "ws";

@Injectable()
export class AgentConnectionRegistry {
  private readonly sockets = new Map<string, WebSocket>();

  connect(agentId: string, socket: WebSocket) {
    this.sockets.get(agentId)?.close(4001, "replaced by a newer connection");
    this.sockets.set(agentId, socket);
  }

  disconnect(agentId: string, socket: WebSocket) {
    if (this.sockets.get(agentId) === socket) this.sockets.delete(agentId);
  }

  send(agentId: string, message: unknown): boolean {
    const socket = this.sockets.get(agentId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  isOnline(agentId: string) {
    return this.sockets.get(agentId)?.readyState === 1;
  }
}

