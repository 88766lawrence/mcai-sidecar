import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CloudStore } from "../store/cloud.store";

@Injectable()
export class PairingService {
  constructor(private readonly store: CloudStore) {}

  register(input: { code: string; agentId: string; publicKey: string; displayName: string; version: string }) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(code)) throw new BadRequestException("Invalid pairing code");
    const now = new Date();
    this.store.agents.set(input.agentId, {
      id: input.agentId,
      publicKey: input.publicKey,
      displayName: input.displayName,
      version: input.version,
      status: "pending",
      lastSeen: now.toISOString(),
    });
    this.store.pairings.set(code, {
      code,
      agentId: input.agentId,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
    return this.store.pairings.get(code)!;
  }

  claim(codeInput: string, tenantId: string) {
    const code = codeInput.trim().toUpperCase();
    const pairing = this.store.pairings.get(code);
    if (!pairing) throw new NotFoundException("Pairing code not found");
    if (pairing.claimedAt) throw new BadRequestException("Pairing code already used");
    if (Date.parse(pairing.expiresAt) < Date.now()) throw new BadRequestException("Pairing code expired");
    const agent = this.store.agents.get(pairing.agentId);
    if (!agent) throw new NotFoundException("Agent not found");
    agent.tenantId = tenantId;
    agent.status = "online";
    pairing.claimedAt = new Date().toISOString();
    return agent;
  }
}

