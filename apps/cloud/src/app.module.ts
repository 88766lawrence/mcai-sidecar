import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { CloudStore } from "./store/cloud.store";
import { PairingController } from "./pairing/pairing.controller";
import { PairingService } from "./pairing/pairing.service";
import { AgentsController } from "./agents/agents.controller";
import { AgentConnectionRegistry } from "./agents/agent-connection.registry";
import { AgentSocketServer } from "./agents/agent-socket.server";
import { TasksController } from "./tasks/tasks.controller";
import { TasksService } from "./tasks/tasks.service";
import { SetupController } from "./setup/setup.controller";
import { SetupService } from "./setup/setup.service";
import { AuthMiddleware } from "./auth/auth.middleware";
import { ModelGatewayService } from "./model-gateway/model-gateway.service";
import { ChatController } from "./chat/chat.controller";
import { ChatService } from "./chat/chat.service";
import { AgentRunStore } from "./agents/agent-run.store";

@Module({
  controllers: [HealthController, SetupController, PairingController, AgentsController, TasksController, ChatController],
  providers: [CloudStore, AgentRunStore, SetupService, AuthMiddleware, PairingService, AgentConnectionRegistry, AgentSocketServer, ModelGatewayService, TasksService, ChatService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes("*");
  }
}
