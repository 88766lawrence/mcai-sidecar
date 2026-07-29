import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AgentSocketServer } from "./agents/agent-socket.server";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  app.enableCors({
    origin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-tenant-id", "x-user-id"],
  });
  app.setGlobalPrefix("api");

  const port = Number(process.env.CLOUD_PORT ?? 4100);
  await app.listen(port, "0.0.0.0");
  app.get(AgentSocketServer).attach(app.getHttpServer());
  console.log(`MCAI cloud listening on http://localhost:${port}`);
}

void bootstrap();
