import { Body, Controller, Get, Post } from "@nestjs/common";
import { SetupService, type SetupInput } from "./setup.service";

@Controller()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get("setup/status")
  status() {
    return this.setup.status();
  }

  @Post("setup")
  configure(@Body() body: SetupInput) {
    return this.setup.configure(body);
  }

  @Post("auth/login")
  login(@Body() body: { username?: string; password?: string }) {
    return this.setup.login(body.username ?? "", body.password ?? "");
  }
}
