import { BadRequestException } from "@nestjs/common";
import type { Request } from "express";

export interface ActorContext {
  tenantId: string;
  userId: string;
}

export function actorFrom(request: Request): ActorContext {
  const tenantId = request.header("x-tenant-id") ?? (process.env.NODE_ENV === "production" ? "" : "tenant_demo");
  const userId = request.header("x-user-id") ?? (process.env.NODE_ENV === "production" ? "" : "user_demo");
  if (!tenantId || !userId) throw new BadRequestException("Tenant and user headers are required");
  return { tenantId, userId };
}

