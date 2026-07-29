import { Controller, Get, Req } from "@nestjs/common";
import type { Request } from "express";
import { actorFrom } from "../http-context";
import { CloudStore } from "../store/cloud.store";
import { AgentConnectionRegistry } from "./agent-connection.registry";

@Controller()
export class AgentsController {
  constructor(private readonly store: CloudStore, private readonly connections: AgentConnectionRegistry) {}

  @Get("agents")
  agents(@Req() request: Request) {
    const { tenantId } = actorFrom(request);
    return [...this.store.agents.values()]
      .filter((agent) => agent.tenantId === tenantId)
      .map((agent) => ({ ...agent, status: this.connections.isOnline(agent.id) ? "online" : "offline" }));
  }

  @Get("instances")
  instances(@Req() request: Request) {
    const { tenantId } = actorFrom(request);
    return [...this.store.instances.values()].filter((instance) => instance.tenant_id === tenantId);
  }
}

