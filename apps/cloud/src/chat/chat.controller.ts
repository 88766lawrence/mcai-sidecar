import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from "@nestjs/common";
import type { ConversationStreamEvent } from "@mcai/contracts";
import type { Request, Response } from "express";
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
  send(@Param("id") id: string, @Body() body: { content?: string; request_id?: string }, @Req() request: Request) {
    return this.chat.send(id, actorFrom(request).tenantId, body.content ?? "", body.request_id);
  }

  @Post(":id/messages/stream")
  async sendStream(
    @Param("id") id: string,
    @Body() body: { content?: string; request_id?: string },
    @Req() request: Request,
    @Res() response: Response,
  ) {
    response.status(200);
    response.set({
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    try {
      const result = await this.chat.sendStream(
        id,
        actorFrom(request).tenantId,
        body.content ?? "",
        body.request_id,
        (event) => writeEvent(response, event),
      );
      writeEvent(response, { type: "done", result });
    } catch (cause) {
      writeEvent(response, {
        type: "error",
        message: cause instanceof Error ? cause.message : "流式回答失败",
      });
    } finally {
      response.end();
    }
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

function writeEvent(response: Response, event: ConversationStreamEvent) {
  if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
}
