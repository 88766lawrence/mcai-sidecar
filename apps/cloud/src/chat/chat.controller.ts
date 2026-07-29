import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { actorFrom } from "../http-context";
import { ChatService } from "./chat.service";

@Controller("sessions")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@Req() request: Request) {
    return this.chat.list(actorFrom(request).tenantId);
  }

  @Post()
  create(@Body() body: { instance_ref?: string; title?: string }, @Req() request: Request) {
    return this.chat.create(actorFrom(request).tenantId, body.instance_ref ?? "", body.title);
  }

  @Get(":id/messages")
  async messages(@Param("id") id: string, @Req() request: Request) {
    return this.chat.messages(id, actorFrom(request).tenantId);
  }

  @Post(":id/messages")
  send(@Param("id") id: string, @Body() body: { content?: string }, @Req() request: Request) {
    return this.chat.send(id, actorFrom(request).tenantId, body.content ?? "");
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: { title?: string; system_prompt?: string },
    @Req() request: Request,
  ) {
    return this.chat.update(id, actorFrom(request).tenantId, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string, @Req() request: Request) {
    return this.chat.remove(id, actorFrom(request).tenantId);
  }
}
