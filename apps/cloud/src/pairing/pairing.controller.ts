import { Body, Controller, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { actorFrom } from "../http-context";
import { PairingService } from "./pairing.service";
import { AgentConnectionRegistry } from "../agents/agent-connection.registry";

@Controller("pairing")
export class PairingController {
  constructor(private readonly pairing: PairingService, private readonly connections: AgentConnectionRegistry) {}

  @Post("claim")
  claim(@Body() body: { code?: string }, @Req() request: Request) {
    if (!body.code) return { error: "code is required" };
    const actor = actorFrom(request);
    const agent = this.pairing.claim(body.code, actor.tenantId);
    this.connections.send(agent.id, { type: "agent.paired", tenant_id: actor.tenantId });
    return agent;
  }
}
