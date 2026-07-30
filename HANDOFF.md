# MCAI 项目交接记录

更新时间：2026-07-30 19:29（Asia/Hong_Kong）

## 当前结论

MCAI 已支持通过自然语言操控页面当前选中的 Minecraft 实例控制台。控制台真实输出回读、基于回调生成最终答复、常见只读请求的确定性路由均已部署到 Linux 测试端。

控制台能力是受控工具 `console.command`，不是 Linux Shell。Cloud 做第一次风险分级，Go Agent 在服务器本地再次校验；MCSManager API Key 仍只由 Agent 本机读取。

## 本轮已完成

- Web 创建或发送会话时始终使用页面当前选择的实例。
- 切换实例会自动切到该实例最近会话；没有会话时在首次发送时创建。
- Cloud 能识别 `console command list`、`在控制台执行 list`、`控制台输入 say hello` 等明确指令。
- 明确控制台指令使用本地确定性路由，不等待上游模型，避免模型容量或 240 秒超时阻塞执行。
- Agent 新增 `console.command` 并调用 MCSManager `/api/protected_instance/command`。
- Agent 在发命令前读取控制台基线，发命令后最多轮询约 3 秒，计算新增日志并作为 `kind=console` 证据回传；不会再把“命令已提交”误当作执行结果。
- 控制台证据会移除 ANSI/控制字符、隐藏疑似密钥，并限制为最多 8 KiB。
- 已按服务器安装的 MCSManager 10 源码确认契约：`daemonId`、`uuid` 和 `command` 均为查询参数。
- 工具执行后不会直接结束；Cloud 会继续根据 Agent 回调生成最终成功结果或失败原因。
- “在线玩家/多少玩家在线”直接确定性映射为 `console.command list`；TPS/MSPT、服务端版本、插件列表也有只读映射，不依赖模型容量。
- 模型工具说明已明确：白名单、时间、天气、游戏规则、传送、物品、踢出、封禁等游戏内操作应主动使用 Minecraft 控制台，不得声称没有控制台工具。
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
- 2026-07-30 19:29 最终部署后四个服务均为 `active`，Cloud 和模型云健康端点均返回 `ok`。

## 真实验收结果

通过 Cloud 会话 API 创建绑定实例“测试”的临时会话，并执行：

1. `console command list`
2. `console command say MCAI console control ready`

该轮旧验收两条任务均满足：

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

注意：旧验收中的 `console` 证据只证明命令已提交；2026-07-30 19:17 后已修复为回传命令后的真实新增控制台日志。远端 Go 集成测试已断言证据包含 `There are 0 of a max of 20 players online`，Cloud 完成阶段会把该 evidence 发送给结果说明模型，模型不可用时也会直接回退显示控制台证据。

新版本真实会话验收脚本位于 `.deploy/verify-console-control.mjs`。它会发送自然语言“帮我看看现在有多少玩家在线”，并严格断言：路由为 `tool`、工具为 `console.command`、任务为 `SUCCEEDED`、证据包含真实在线人数、最终消息引用人数结果。该脚本需要读取 `/etc/mcai/setup.json` 生成 5 分钟本机认证令牌；当前执行环境的安全审批拒绝了这一步，尚未运行，不能把它写成已通过。密钥不应输出或复制到脚本外。

## 验证状态

- 本机 `npm run typecheck`：通过
- 本机定向测试：Cloud 15 项通过（`planner` 与 `chat`）
- 本机 `npm run build`：通过
- 本机 `local-cloud npm test`：6 项通过
- Linux `go test ./...`：通过
- Linux Go Agent 构建：通过
- Linux 全量 TypeScript 类型检查、17 项 Cloud 测试和生产构建：通过
- Linux 模型云测试：6 项通过
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

- 控制台回读与 Web 修复已同步到 Windows 本地、Linux 测试端和 GitHub，提交为 `26c712d Add console evidence and web motion`。
- 自然语言只读路由已同步到 GitHub，提交为 `ade573b Route common server queries deterministically`；模型控制台工具说明与本交接文档已提交为 `322a22c Teach agent when to use the Minecraft console`。
- `origin/main` 已包含上述控制台回读、自然语言路由和模型工具说明提交。
- 控制台主体提交：`d84cc2e Harden chat operations and response handling`。
- MCSManager 查询参数修复：`e43b3c2 Fix MCSManager console command request`。
- 确定性控制台路由：`1b6b0d9 Route explicit console commands deterministically`。
- 当前源码、Linux 测试端和 GitHub 已同步，无未提交功能修改。
- 后续可继续扩展更多明确操作的本地确定性路由，使启动、文件查询和安装等操作同样不受上游模型容量影响。
- 中风险和高风险控制台命令仍应通过页面确认按钮进行人工验收，不能绕过确认策略。

## 安全注意事项

- 不要在文档、日志、提交或聊天中写入模型 API Key、MCSManager API Key、管理员密码或 SSH 私钥内容。
- 不开放任意 Shell，不允许模型生成或执行 SSH 命令。
- 不绕过任务风险确认、Minecraft EULA 确认和实例生命周期专用工具。

## 2026-07-30 22:33 控制台真实回读修复

### 故障复现

部署前通过公网 HTTPS 对话 API 对运行中的实例“测试”执行了四条自然语言指令：

1. `帮我看看现在有多少玩家在线`
2. `查看服务器 TPS`
3. `查看服务端版本`
4. `列出已安装插件`

四条请求均正确路由为 `tool`，工具均为 `console.command`，但 Agent 只上报“控制台已接受命令，但等待窗口内没有新的控制台输出”，任务仍错误地进入 `SUCCEEDED`。普通问题 `1+1等于几？只回答数字。` 能直接返回 `2`，因此问题明确位于 Agent 到 MCSManager 的控制台回读边界，不在登录、会话、模型或 Cloud 路由。

### 根因与实现

- `apps/agent/internal/executor/executor.go` 原先只轮询 MCSManager `/api/protected_instance/outputlog`。该接口在当前 MCSManager 实例上不会及时返回命令后的新增行，但 Minecraft 会正常把结果写入实例根目录的 `logs/latest.log`。
- 发送命令前现在同时读取面板输出和 `logs/latest.log` 作为两份基线，发送后轮询两种来源；任一来源产生合法增量即可作为 `kind=console` 的真实证据。
- 两种来源都不可读时，命令不会在无法验证的情况下继续执行。
- 等待窗口结束仍没有合法增量时，步骤返回错误，不再用“已接受命令”冒充成功证据。
- 对 `list`、`tps`、`version`、`plugins/pl` 和 `mspt` 增加了结果完整性判断。特别是 Paper 的 `version` 会先输出 `Checking version, please wait...`，该中间状态不再提前结束任务；Agent 会等待 `This server is running Paper version ...` 等最终版本行。
- `apps/agent/internal/executor/install_test.go` 新增 `logs/latest.log` 回退、无证据失败和版本中间状态等待测试。

### 部署与回滚

- Linux 源码目录：`/opt/mcai-src`
- Agent 二进制：`/opt/mcai-agent`
- 本轮仅重新构建并重启 `mcai-agent.service`，没有重启 Minecraft 实例、Cloud、Web 或模型云。
- 部署前源码与二进制备份：`/tmp/mcai-console-log-backup-20260730223301`
- 部署脚本：`.deploy/deploy-console-log-fallback.sh`
- 四项验收脚本：`.deploy/verify-console-control.mjs`

### 真实验收结果

目标实例：`mcs:4419b32bc2c64110823a951d2f175833:8a54968e5a944f40b50b6cbefdec3e4f`

- 在线玩家：`There are 0 of a max of 20 players online:`；最终回答为当前在线 `0 / 20`。
- TPS：`TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.57`；最终回答引用三项 TPS 数值。
- 版本：`This server is running Paper version 1.21.1-133-ver/1.21.1...`；最终回答给出 Paper、Minecraft 和 API 版本。
- 插件：`Server Plugins (0):`；最终回答说明当前插件数为 0。

四条任务的共同验收结果均为：

- `route=tool`
- `tool=console.command`
- `state=SUCCEEDED`
- `kind=console` 证据包含真实 Minecraft 日志行
- 最终回答引用控制台结果，不再停留在“命令已提交”或“没有新增输出”

### 验证状态

- Windows 本地 `go test ./...`：通过。
- Linux `go test ./...`：通过。
- Linux Agent 构建与 `mcai-agent.service` 重启：通过，服务为 `active`。
- Linux 四项真实自然语言对话验收：全部通过。
- `node --check .deploy/verify-console-control.mjs`：通过。
- `git diff --check`：通过。

## 2026-07-30 OpenClaw 式系统提示词改造

### 目标与参考边界

本轮目标不是复制 OpenClaw 的人格或通用个人助理能力，而是把它成熟的系统提示词组织方法改造成 MCAI 专用的 Minecraft 运维契约。参考项目为 `openclaw/openclaw`，固定参考提交为 `90a22b4f50226b13735e77dde81a92340ae724cf`，上游许可证为 MIT。来源和改造声明已写入根目录 `THIRD_PARTY_NOTICES.md`。

参考内容包括 OpenClaw 的 `docs/concepts/system-prompt.md` 和 `src/agents/system-prompt.ts`。MCAI 只吸收了稳定规则在前、动态上下文在后的分层结构，以及工具契约、执行闭环、证据完成和安全优先级等设计思想；OpenClaw 特有的通道、工作区、记忆、个人助理工具和运行时说明没有复制进项目。

### 实现内容

`local-cloud/agent.mjs` 新增导出的 `buildSystemInstructions(payload)`，系统提示词按以下顺序构建：

1. `Identity`：定义 MCAI 是执行导向的 Minecraft 运维 Agent，目标是实际完成和提供可验证证据。
2. `Tooling`：简单问题直接回答；离线复杂规划或诊断使用 `delegateAnalysis`；实时日志、文件、配置、性能、状态和变更必须使用 `requestOperation`。
3. `Execution Bias`：目标明确立即执行；工具已接受、命令已提交或任务运行中不算完成；失败或空结果必须依据回调安全重试、调整受控计划或说明阻塞。
4. `Minecraft Operations`：页面当前实例是唯一执行目标；控制台请求使用 `console.command`；Paper/Fabric 安装使用 `server.install`；Minecraft 控制台与 Linux Shell 严格分离。
5. `Safety`：不绕过审批、实例锁、路径限制、审计、EULA 和生命周期专用工具；不生成任意 Shell/SSH；不泄露密钥或密码。
6. `Interaction Style`：只展示工具摘要和最终结果，不暴露内部推理，不复述问题，不追加礼貌性邀请。
7. `Runtime Context`：在提示词尾部注入当前实例、Cloud 允许操作和低优先级会话偏好，便于稳定前缀缓存且防止会话提示覆盖安全规则。

`apps/cloud/src/chat/chat.service.ts` 的 Cloud 兜底提示词同步增加执行优先和回调证据约束。任务结果说明 Agent 也明确禁止把“已接受”“已提交”“正在运行”或空证据推断成完成。

### 自动化验证

`local-cloud/agent.test.mjs` 新增分层提示词契约测试，覆盖章节结构、复杂请求委派、实时数据优先使用运维工具、当前实例不重复询问、动态会话上下文和不再出现旧 `file.download` 指令。2026-07-30 23:42 本地结果：

- 模型云：7 项测试全部通过。
- Cloud：4 个测试文件、17 项测试全部通过。
- 全仓 TypeScript 类型检查：通过。
- Cloud 生产构建：通过。
- 公网 `http://191.40.37.148:3000/api/health`：HTTP 200，`mcai-cloud` 状态为 `ok`。

### Linux 部署与线上验收状态

改造已同步到 Linux 源码目录 `/opt/mcai-src` 和运行目录 `/opt/mcai-model-cloud`，并重启模型云与 Cloud。最近一次部署前备份为 `/tmp/mcai-openclaw-prompt-backup-20260730234028`。

部署过程中已验证过直接回答、复杂规划委派、控制台工具路由和停止实例启动路由。最后又加强了“实时数据优先于分析委派”规则，以修复实时日志请求被错误交给 `diagnostics` 的情况。该最后版本已经部署，但本次会话在重跑 `/tmp/verify-chat-routing.mjs` 时无交互 SSH 认证被服务器拒绝，错误为 `Permission denied (publickey,password)`，因此最后四路线上验收必须标记为待重跑，不能写成全部通过。公网健康检查正常，说明 Cloud 当前在线，但健康检查不能替代行为验收。

恢复 SSH 认证后，应执行：

```bash
/opt/node-v22.17.0-linux-x64/bin/node /tmp/verify-chat-routing.mjs
/opt/node-v22.17.0-linux-x64/bin/node /tmp/verify-console-control.mjs
```

预期路由依次为 `direct`、`delegate/planner`、`tool`、`tool`；控制台在线玩家、TPS、版本和插件四项应全部为 `SUCCEEDED`，并带真实 `kind=console` 回调证据。
