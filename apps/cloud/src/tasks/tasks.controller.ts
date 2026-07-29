import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { actorFrom } from "../http-context";
import { TasksService } from "./tasks.service";

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Req() request: Request) {
    return this.tasks.list(actorFrom(request).tenantId);
  }

  @Get(":id")
  get(@Param("id") id: string, @Req() request: Request) {
    return this.tasks.get(id, actorFrom(request).tenantId);
  }

  @Post()
  create(@Body() body: { instance_ref?: string; intent?: string }, @Req() request: Request) {
    return this.tasks.create({
      tenantId: actorFrom(request).tenantId,
      instanceRef: body.instance_ref ?? "",
      intent: body.intent ?? "",
    });
  }

  @Post(":id/confirmation")
  issueConfirmation(@Param("id") id: string, @Req() request: Request) {
    return this.tasks.issueConfirmation(id, actorFrom(request).tenantId);
  }

  @Post(":id/confirm")
  confirm(@Param("id") id: string, @Body() body: { token?: string }, @Req() request: Request) {
    return this.tasks.confirm(id, actorFrom(request).tenantId, body.token ?? "");
  }
}

