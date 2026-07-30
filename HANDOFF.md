# MCAI 项目交接记录

更新时间：2026-07-30 18:30（Asia/Hong_Kong）

## 当前结论

MCAI 已支持通过自然语言操控页面当前选中的 Minecraft 实例控制台。该能力已部署到 Linux 测试端，并在实例“测试”上完成真实端到端验收。

控制台能力是受控工具 `console.command`，不是 Linux Shell。Cloud 做第一次风险分级，Go Agent 在服务器本地再次校验；MCSManager API Key 仍只由 Agent 本机读取。

## 本轮已完成

- Web 创建或发送会话时始终使用页面当前选择的实例。
- 切换实例会自动切到该实例最近会话；没有会话时在首次发送时创建。
- Cloud 能识别 `console command list`、`在控制台执行 list`、`控制台输入 say hello` 等明确指令。
- 明确控制台指令使用本地确定性路由，不等待上游模型，避免模型容量或 240 秒超时阻塞执行。
- Agent 新增 `console.command` 并调用 MCSManager `/api/protected_instance/command`。
- 已按服务器安装的 MCSManager 10 源码确认契约：`daemonId`、`uuid` 和 `command` 均为查询参数。
- 工具执行后不会直接结束；Cloud 会继续根据 Agent 回调生成最终成功结果或失败原因。
- UI 工具名称显示为“发送控制台命令”，实例停止显示为“停止服务器”。
- 同一请求使用 `request_id` 去重，防止重复点击或重试创建重复任务。
- 消息发送中，发送按钮会切换为“停止发送”，用户可以立即中止并解锁输入框。
- 浏览器发送等待上限为 65 秒；Cloud 模型路由上限为 60 秒，不再出现旧版本最长 240 秒占用发送按钮的情况。

## 控制台安全规则

- 仅允许运行中实例执行命令。
- 仅允许单行可打印命令，最多 256 字节。
- 禁止把 `stop`、`restart`、`quit`、`end` 当普通控制台命令；必须走专用实例工具。
- `list/help/version/plugins/pl/tps/mspt/seed` 为只读，无需确认。
- `say/me` 为低风险，无需确认。
- `time/weather/difficulty/gamerule/gamemode/give/tp/effect` 等为中风险，必须确认。
- 未知命令及 `op` 等管理员命令按高风险处理，必须确认。
- 审计只保存命令动词与 SHA-256，不保存完整敏感参数。

## Linux 测试端

- 主机：`191.40.37.148`
- Web：`http://191.40.37.148:3000/`
- MCSManager：`http://191.40.37.148:23333/`
- 源码目录：`/opt/mcai-src`
- Go：`/opt/go/bin/go`，版本 `go1.23.5`
- 服务：`mcai-model-cloud.service`、`mcai-cloud.service`、`mcai-agent.service`、`mcai-web.service`
- 2026-07-30 18:25 部署后四个服务均为 `active`。

## 真实验收结果

通过 Cloud 会话 API 创建绑定实例“测试”的临时会话，并执行：

1. `console command list`
2. `console command say MCAI console control ready`

两条任务均满足：

- 路由：`tool`
- 工具：`console.command`
- 状态：`SUCCEEDED`
- 实例：`mcs:4419b32bc2c64110823a951d2f175833:8a54968e5a944f40b50b6cbefdec3e4f`
- Agent 回调包含 `console` 证据

Minecraft `logs/latest.log` 已确认：

```text
[Server] MCAI console control ready
There are 0 of a max of 20 players online:
```

## 验证状态

- 本机 `npm run typecheck`：通过
- 本机 `npm test`：Cloud 15 项通过
- 本机 `npm run build`：通过
- 本机 `local-cloud npm test`：6 项通过
- Linux `go test ./...`：通过
- Linux Go Agent 构建：通过
- Linux 全量 TypeScript 类型检查、测试和生产构建：通过
- 公网 Web `/api` 流式代理：控制台消息约 27ms 返回任务，普通消息约 3.1 秒返回直接回答
- `git diff --check`：通过

## 主要修改文件

- `apps/agent/internal/executor/executor.go`
- `apps/agent/internal/provider/provider.go`
- `apps/agent/internal/provider/mcsmanager/client.go`
- `apps/cloud/src/tasks/planner.ts`
- `apps/cloud/src/chat/chat.service.ts`
- `apps/cloud/src/model-gateway/model-gateway.service.ts`
- `apps/web/components/agent-workspace.tsx`
- `local-cloud/agent.mjs`
- `packages/contracts/src/index.ts`
- 对应 Go、Vitest 和 Node 测试文件

部署与验收辅助文件：

- `.deploy/deploy-console-control.sh`
- `.deploy/mcai-console-control-update.tar.gz`
- `.deploy/verify-console-control.mjs`

## Git 状态与后续工作

- 本轮功能源码已同步到 Windows 本地、Linux 测试端和 GitHub。
- `origin/main` 当前为 `1b6b0d9 Route explicit console commands deterministically`。
- 控制台主体提交：`d84cc2e Harden chat operations and response handling`。
- MCSManager 查询参数修复：`e43b3c2 Fix MCSManager console command request`。
- 确定性控制台路由：`1b6b0d9 Route explicit console commands deterministically`。
- 当前仅本交接文档和 `recovery_test.go` 的远端 `gofmt` 格式差异尚未提交。
- 后续可继续扩展更多明确操作的本地确定性路由，使启动、文件查询和安装等操作同样不受上游模型容量影响。
- 中风险和高风险控制台命令仍应通过页面确认按钮进行人工验收，不能绕过确认策略。

## 安全注意事项

- 不要在文档、日志、提交或聊天中写入模型 API Key、MCSManager API Key、管理员密码或 SSH 私钥内容。
- 不开放任意 Shell，不允许模型生成或执行 SSH 命令。
- 不绕过任务风险确认、Minecraft EULA 确认和实例生命周期专用工具。
