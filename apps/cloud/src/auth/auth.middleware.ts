import { Injectable, type NestMiddleware, UnauthorizedException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { SetupService } from "../setup/setup.service";

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly setup: SetupService) {}

  async use(request: Request, _response: Response, next: NextFunction) {
    const path = request.originalUrl.split("?")[0];
    if (["/api/health", "/api/setup/status", "/api/setup", "/api/auth/login"].includes(path)) return next();
    if (!path.startsWith("/api/")) return next();
    const authorization = request.header("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) throw new UnauthorizedException("请先登录");
    const session = await this.setup.verify(authorization.slice(7));
    request.headers["x-tenant-id"] = session.tenantId;
    request.headers["x-user-id"] = session.sub;
    next();
  }
}
