# MCAI 项目交接记录

## 2026-08-02 Agent 工作台界面重构（Linux 同步待重试）

### 本轮完成内容

登录后的 Agent 页面已从普通聊天布局改为紧凑的三栏运维工作台，同时保留米黄色纸张基调：

- 左侧为实例选择、实例资源上下文与会话列表；资源区只展示当前已知上下文，不伪造服务器文件内容。
- 中间新增顶部会话切换器和标签栏；消息按 `COMMAND`、`TOOLS`、`OUTPUT`、`DONE` 分层展示，用户指令以深色命令块呈现，最终成功/失败结果以明确状态卡呈现。
- 工具调用过程默认收起为“执行记录”；展开后才显示计划、步骤、工具标识和证据。进行中的状态只显示“正在规划”，不暴露内部推理文本。
- 右侧工具面板改为常驻：有任务时展示任务、调用工具与最新证据；无任务时展示可用能力、会话策略和系统提示词入口。
- 会话轮询增加版本保护与相同消息列表复用，减少轮询替换历史消息导致的滚动跳动；用户在消息区按下/向上滚动后不再自动追随最新消息，仍可使用“回到最新消息”。
- 375/390px 窄屏自动隐藏非核心右栏并保留标签、状态、结果与输入框，截图验证无横向滚动。

### 修改文件

- `apps/web/components/agent-workspace.tsx`
- `apps/web/app/globals.css`

### 本地验收（已完成）

- `npm run typecheck -w @mcai/web`：通过。
- `npm run build -w @mcai/web`：通过。
- 本机生产预览（Edge 无头）桌面 `1440×1024`：通过；断言包含常驻右栏、标签栏、折叠执行记录、最终结果卡，且 `scrollWidth === viewportWidth`。
- 本机生产预览移动 `390×844`：通过；`scrollWidth === viewportWidth`，输入框和最终结果未被遮挡。
- 视觉截图为本地忽略文件：`.deploy/workbench-desktop.png`、`.deploy/workbench-mobile.png`，均基于真实 React/Next 生产构建和受控模拟 API 数据，不是手工拼图。

### 同步状态

- Windows 本地：已完成且已构建验证。
- Linux `191.40.37.148`：尚未更新。本轮两次 SCP 和一次只读 SSH 检查均在 22 端口握手前超时，未上传文件、未重启 `mcai-web.service`，也未触及 Cloud、Agent、模型云或 Minecraft。
- GitHub：本地提交 `0ab0d26 Redesign agent operations workbench` 已创建；直接推送到 `origin/main` 需要用户对本次提交重新明确授权，当前尚未推送。在 Linux 网络恢复前，不应声称三端一致。

### Linux 恢复连接后的最小发布步骤

仅使用 `.deploy/deploy-agent-ui.sh` 发布，因为它只备份/覆盖上述两个 Web 文件，执行 Web 类型检查与生产构建，然后只重启 `mcai-web.service`。发布后必须重新核对两个文件的 SHA-256，并访问 `http://127.0.0.1:3000/`；不应运行任何会重启 Cloud、Agent、模型云或 Minecraft 的旧部署脚本。

## 2026-08-02 模型适配器与 Agent 循环修复（当前最新状态）

### 本轮结论

模型服务本身可用；此前“模型云暂时不可用”“暂时没有可用回答”和聊天里出现原始 JSON，根因是 MCAI 的兼容适配与超时策略，而不是所有配置模型都失效。当前 Linux 测试端已部署修复，且只重启了 `mcai-model-cloud`，没有重启 `mcai-cloud`、`mcai-agent`、`mcai-web` 或 Minecraft 实例。

当前运行环境：

- Windows 工作区：`E:\aimcs`
- Linux 源码：`/opt/mcai-src`
- LangGraph 运行 release：`/opt/mcai-langgraph-cloud/releases/20260801130804`
- 当前 release 软链接：`/opt/mcai-langgraph-cloud/current`
- 最新可回滚备份：`/tmp/mcai-model-adapter-backup-20260802150053`

### 已修复的模型行为

1. 兼容 OpenAI 风格但不严格遵守 JSON Schema 的上游：接受自然文本、`answer/content/text/response/message/output/result/final/summary` 等安全正文键，以及嵌套内容；绝不暴露 `analysis` 或 `reasoning` 字段。
2. 子 Agent（规划/诊断）不再对同一个模型依次浪费三轮 `response_format` 探测。它使用兼容的 prompt 模式，并在主模型慢响应时允许一次 20 秒的正文生成窗口，再为备用模型保留时间。
3. 子 Agent 输出预算从 512 降至 256 tokens，并采用固定的短结果模板：诊断必须覆盖“已知事实、推断、验证、风险、验收”；规划必须覆盖“阶段、依赖、风险、验收、回滚、停止条件”。
4. 若上游在 token 上限前截断 JSON，例如 `{"route":"direct","answer":"...` 未闭合，系统只恢复公开 `answer` 正文，不会把原始 JSON 显示在聊天气泡中。
5. 双层 JSON 包装会递归解包；兼容网关返回的顶层或嵌套 `content` 也不会丢失。
6. `availableTools: []` 现在真正表示没有工具。模型即使尝试选择工具，也会降级为“未执行任何操作”。
7. 对话历史增加每条 1,600 字符、总计 6,000 字符的压缩上限，保留最新上下文，避免旧日志或长回调拖慢后续模型请求。
8. `/health` 只表示进程和配置存在；新增 `/ready` 会真实调用一次模型并要求回显随机 nonce，不能再把假健康误报为模型可用。
9. 模型失败会返回明确的认证、限流、网络、超时或格式错误状态，而不再一律伪装成“没有可用回答”。
10. 路由提示词要求模型在事实不确定时省略或标明不确定，禁止编造项目名、版本、性能指标或工具能力。

### 真实验收记录（2026-08-02）

Linux 最新部署执行了 54 项 Python LangGraph/FastAPI 单元与集成测试，全部通过。部署脚本同时验证 `/health` 和实际推理 `/ready`；仅有服务启动初期的一次瞬时 `curl connection refused`，随后 readiness 成功，部署以退出码 0 完成。

无真实服务器数据的复杂 Agent 验收（`/tmp/verify-offline-delegate.mjs`）通过：虚构性能诊断题走 `delegate/diagnostics` 并覆盖事实、推断、验证、风险和验收；虚构大型 Paper 治理题走 `delegate/planner` 并覆盖阶段、依赖、风险、验收、回滚和停止条件。验收请求只发送虚构压测文本和 synthetic 实例标识；没有读取或发送真实实例日志、文件或控制台内容。

通用模型/Cloud 流式验收（`/tmp/verify-model-runtime.mjs`）通过：

- `/ready`：`status=ready`、`runtime=python-langgraph`，实际使用 `MiniMax-M3`；
- `17 × 19`：`route=direct`，返回 `323`；
- Paper/Fabric 概念题：`route=direct`，有实质回答且不再显示原始 JSON；
- 请求“启动服务器”但 `availableTools=[]`：没有创建工具任务；
- Cloud NDJSON 流式路径：`route=direct`，输出自然语言，收到多个 `delta` 后结束。

工具回调闭环验收（`/tmp/verify-langgraph-loop.mjs`）通过：用户确认“需要”后恢复 `files.list`；安装插件任务只有中间状态时会继续读取 `/plugins` 取证；真实只读 `files.list /plugins` 任务为 `SUCCEEDED`；当前证据为 `.paper-remapped`、`bStats`、`spark`；最终回答明确说明未发现 EssentialsX，不能确认已安装，没有假称成功。

### 未覆盖的安全边界

本轮没有把 Linux 测试实例的真实控制台日志、文件列表或性能数据发送给外部模型服务。真实日志“读取 → 模型诊断 → 回答”的端到端验收仍需要用户明确授权：`允许将 Linux 测试实例日志发送给已配置的模型服务用于 Agent 验收`。在未授权前，可验证的是本地受控读取、工具回调和完全虚构的模型分析，不应声称已经完成真实日志外发分析。

### 当前同步状态与下一步

截至本节写入时，Windows 工作区与 Linux `/opt/mcai-src`/运行 release 已部署相同的 `app.py`、`graph.py`、`test_app.py`、`test_graph.py`。GitHub 尚待本轮最终哈希核对后提交推送；提交前必须再次执行 `git diff --check`，并比较四个文件的 Windows/Linux SHA-256。

更新时间：2026-08-01 13:18（Asia/Hong_Kong）

## 当前结论

MCAI 的默认模型编排层已从一次性 Vercel AI SDK 路由迁移为 Python LangGraph。对话、待执行动作和任务回调使用 SQLite 检查点；Cloud 能消费回调返回的 continuation，创建下一项受控任务并保持原会话/实例绑定。插件闭环已接入 Modrinth 解析、哈希验证、MCSManager 一次性上传、落盘与启动证据验收和失败删除回滚。

2026-08-01 的 Linux 真实只读验收已确认：用户回复“需要”会恢复 `files.list`；插件安装结果缺少文件证据时会继续读取 `/plugins`；当前实例真实目录只有 `.paper-remapped`、`bStats` 和 `spark`，最终答案明确说明未发现 EssentialsX，不能声称已安装。

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

## 2026-07-31 最终复杂 Agent 验收与执行闭环修复

### 本轮目标

本轮不是测试 Minecraft 服务端功能本身，而是验证 MCAI Agent 能否针对简单问题、复杂离线问题和需要实时数据的问题选择正确路径，并且在调用工具后持续等待回调、读取证据、输出结论或明确失败原因。验收要求包括：

1. 简单问题直接回答，不滥用工具或子 Agent。
2. 复杂离线诊断使用 `diagnostics` 子 Agent，复杂多阶段方案使用 `planner` 子 Agent。
3. 实时日志、实例状态和控制台问题必须调用实际工具，不允许依靠模型猜测。
4. 工具提交不是完成；必须等任务进入终态，根据 Agent 回传证据生成最终答案。
5. 不展示内部思维链，不生成任意 Shell、SSH、进程注入或性能分析脚本。
6. 结论必须区分事实、推断和待验证项，不伪造测量值或无证据建议回滚。

### 发现并修复的问题

#### 1. 实时日志请求可能被直接回答

真实路由测试发现，询问当前实例实时日志时，模型有时选择 `direct`，导致没有执行 `logs.query`。修复方式是在模型云和 Cloud 两层增加确定性实时日志识别：

- `local-cloud/agent.mjs` 在进入上游模型前识别实时日志意图，固定返回 `requestOperation(logs.query)`。
- `apps/cloud/src/chat/chat.service.ts` 和 `apps/cloud/src/tasks/planner.ts` 增加同等兜底路由，防止模型容量不足或模型选错工具时跳过实际执行。
- 对实时数据的工具路由优先级高于离线诊断委派。

#### 2. 复杂规划与诊断委派存在随机性

同一个明确要求“不读取当前实时数据”的多阶段规划问题，有时走 `delegate/planner`，有时被直接回答。修复后：

- 新增 `deterministicDelegationKind`，对明确的离线复杂规划和诊断做确定性委派。
- 同一句话同时包含诊断和规划语义时，诊断优先。
- 委派输出改用 `streamText` 流式返回，而不是等待完整文本后一次性输出。
- Cloud 调用模型云的超时由 60 秒提高到 180 秒，覆盖复杂子 Agent 的真实生成时间。

#### 3. `logs.query` 没有把日志内容交给结果模型

Sidecar 原来只上报“读取了多少字节”和 SHA-256，结果模型看不到日志正文，无法根据工具回调诊断。`apps/agent/internal/executor/executor.go` 已修改为：

- 优先读取实例根目录的 `logs/latest.log`，面板短输出作为回退。
- 上报最多 8 KiB 的最近日志摘要，同时保留总字节数和 SHA-256。
- 清理 ANSI 和控制字符。
- 对 API key、token、secret 和 password 等敏感字段做脱敏。

#### 4. 日志证据中的字符导致 WebSocket 签名失败

任务曾卡在 `VERIFYING`。Sidecar 审计显示执行已经完成，但 Cloud 没有收到最终证据。根因是 Go `encoding/json` 默认把 `<`、`>` 和 `&` 做 HTML 转义，而 Cloud 使用 JavaScript `JSON.stringify` 计算签名；包含这些字符的真实日志会导致两端签名原文不一致，Cloud 因签名失败关闭 Agent WebSocket。

`apps/agent/internal/protocol/protocol.go` 现在使用 `json.Encoder.SetEscapeHTML(false)` 生成与 JavaScript 一致的签名载荷，并新增 `apps/agent/internal/protocol/protocol_test.go` 回归测试。

#### 5. 子 Agent 可能给出无证据的运维命令和结论

早期复杂诊断曾生成 `jstat`、Profiler 脚本、JVM 参数和没有来源的百分比。`local-cloud/agent.mjs` 的委派提示词现已明确：

- 事实、推断、待验证项必须分开。
- 禁止输出任意 Shell、SSH、进程注入、Profiler 脚本和直接文件命令。
- 禁止编造测量值。
- 没有变更证据时不得建议回滚。
- 插件数量为 0 本身不是故障。

任务完成阶段的提示词同时补充：Paper 更新检查失败不等于服务端崩溃，控制台命令回显不等于异常，缺少崩溃或退出证据时必须明确说明证据不足。

### 修改文件

- `apps/agent/internal/executor/executor.go`
- `apps/agent/internal/executor/install_test.go`
- `apps/agent/internal/protocol/protocol.go`
- `apps/agent/internal/protocol/protocol_test.go`
- `apps/cloud/src/chat/chat.service.ts`
- `apps/cloud/src/chat/chat.service.spec.ts`
- `apps/cloud/src/model-gateway/model-gateway.service.ts`
- `apps/cloud/src/tasks/planner.ts`
- `apps/cloud/src/tasks/planner.spec.ts`
- `local-cloud/agent.mjs`
- `local-cloud/agent.test.mjs`

### Linux 部署信息

- Linux 源码：`/opt/mcai-src`
- 模型云与 Cloud 部署前备份：`/tmp/mcai-realtime-log-routing-backup-20260731114308`
- Sidecar 源码与二进制部署前备份：`/tmp/mcai-log-evidence-backup-20260731114344`
- 早期可用备份：`/tmp/mcai-realtime-log-routing-backup-20260731113159`、`/tmp/mcai-log-evidence-backup-20260731113955`
- 本轮只重启 MCAI 相关服务，没有为了 Cloud 或模型云更新而重启 Minecraft 实例。

### 最终复杂验收

最终脚本：`.deploy/verify-complex-agent.mjs`。2026-07-31 重新上传至 `/tmp/verify-complex-agent.mjs` 并在 Linux 测试端执行，脚本最终返回：

```json
{"passed": true}
```

目标实例：

```text
名称：测试
引用：mcs:4419b32bc2c64110823a951d2f175833:8a54968e5a944f40b50b6cbefdec3e4f
```

验收覆盖与结果：

1. 复杂离线诊断：`route=delegate`、`delegate=diagnostics`。回答区分已知事实、推断和待验证项；没有输出可执行 Shell 命令；没有复用早期无证据的 `2.4%` 数值。
2. 复杂三阶段性能治理方案：`route=delegate`，通过 Cloud 流式输出；包含阶段、依赖、风险、量化验收、回滚和停止条件，并遵守 150 人、20 插件、20 分钟维护窗口约束。
3. 实时日志诊断：`route=tool`、`tool=logs.query`、任务 `state=SUCCEEDED`。本次读取 12,096 字节真实日志，证据包含 Paper Watchdog 和 `Can't keep up`。
4. 实时日志最终回答识别出服务器主线程长时间卡顿；引用了 Watchdog 10 秒无响应和最高约 58 秒/1160 ticks 落后；明确没有实际崩溃或退出证据；把 `PaperVersionFetcher` 404 识别为无关的版本检查噪声。

真实证据中的关键行包括：

```text
Paper Watchdog Thread/ERROR
The server has not responded for 10 seconds
Can't keep up!
Running 58011ms behind
```

### 路由与控制台回归

四类路由回归全部通过：

- 简单问题：`direct`
- 离线复杂规划：`delegate/planner`
- 实时日志：`tool/logs.query`
- 已停止实例启动：`tool/instance.start`

四项真实控制台回调全部进入 `SUCCEEDED`，最终回答引用实际控制台证据：

- 在线玩家：`0 / 20`
- TPS：`20.0, 20.0, 20.0`
- 服务端版本：Paper `1.21.1-133`
- 插件：`0`

### 本地验证基线

- 模型云测试：11/11 通过。
- Cloud 测试：19/19 通过。
- 全仓 TypeScript 类型检查：通过。
- Cloud 生产构建：通过。
- 模型云语法检查：通过。
- Go `go test ./...`：通过。
- `git diff --check`：通过。

2026-07-31 提交前已重新执行上述完整本地验证，所有项目均通过。推送后还需核对 Windows `HEAD` 与 GitHub `origin/main` 一致，并确认 Windows 工作区和 Linux `/opt/mcai-src` 的受影响文件 SHA-256 完全一致。

## 2026-08-01 LangGraph 编排、回调续跑与插件闭环

### 迁移原因

旧 `local-cloud/agent.mjs` 只在选择路由时循环。模型一旦调用 `requestOperation`，Cloud 创建任务后该次模型执行就结束；任务完成后的 `/v1/respond` 只能生成文字，不能再请求工具。短回复“需要”“继续”“确认”也只带当前一句话进入路由，上一轮待办会丢失。因此旧实现会出现以下确定性故障：

- 工具提交后直接停住，不根据回调继续验证。
- 文件落盘证据不足时只能输出文字，不能再调用 `files.list`。
- 用户回复“需要”后不知道是在确认读取插件目录。
- `planner.ts` 把所有通用插件安装硬编码成 LuckPerms。
- Go Executor 对 `plugin.resolve` 和 `plugin.install` 直接返回未启用。
- `plugin_enabled` 虽出现在计划中，但 Go `verify()` 没有实现该规则，存在空验收风险。

### 当前架构

职责仍严格分离：

1. `langgraph-cloud` 保存会话状态、恢复 pending action、评估回调，并提出下一项受控工具。
2. NestJS Cloud 绑定租户、会话和页面当前实例，重新生成确定性计划并执行风险策略。
3. 中风险和高风险 continuation 只会创建 `WAITING_CONFIRMATION` 任务，不会自动批准。
4. Go Agent 使用本机 MCSManager API Key 执行工具、采集证据、验收和回滚。
5. 模型云不连接 MCSManager，不持有面板 API Key，不执行 Shell/SSH。

Cloud continuation 链包含 `session_id`、`parent_task_id` 和 `chain_depth`，最大深度为 6。达到上限后停止自动串联。任务提交、面板接受或中间状态不等于完成，只有 Agent 回调证据能形成最终答案。

### Python LangGraph 服务

新增目录 `langgraph-cloud/`：

- `mcai_graph/graph.py`：聊天图、回调评估图、SQLite 检查点、确定性路由和 pending action 恢复。
- `mcai_graph/app.py`：兼容原 Cloud 的 `/v1/chat`、`/v1/chat/stream`、`/v1/respond` 和 `/health`。
- `tests/test_graph.py`：短回复续跑、插件验证、缺证据 continuation、禁止伪成功等测试。
- `tests/test_app.py`：service token、thread ID、健康端点和回调接口测试。
- `mcai-model-cloud.service`：只监听 `127.0.0.1:4200`，状态库为 `/var/lib/mcai-model-cloud/langgraph.sqlite3`。

SQLite 使用 `AsyncSqliteSaver`。早期版本误用了同步 `SqliteSaver`，首次测试即报 `SqliteSaver does not support async methods`，已改为异步连接并显式执行 `setup()`。状态文件权限强制为 `0600`，状态目录应为 `0700`。

确定性规则包括：

- “你确定 Essentials 安装了吗”使用 `files.list`，不再次触发安装。
- 助手上一轮询问是否读取 `/plugins` 后，用户回复“需要/继续/确认”恢复该待办。
- 插件任务只有 state/verification 中间证据时，`/v1/respond` 返回 `files.list` continuation。
- `files.list` 没有 `kind=files` 证据时明确失败，不交给模型润色成成功。
- 文件证据没有目标插件时，明确回答“未发现，不能确认已安装”，并引用实际清单。

### Cloud 续跑

主要修改：

- `model-gateway.service.ts` 发送 `threadId/sessionId/taskId/chainDepth`，接收并验证可选 continuation。
- `tasks.service.ts` 持久化父任务和深度，并缓存 completion continuation，避免进程内重复求值。
- `chat.service.ts` 在任务终态消息出现后创建下一任务；并发轮询先写入 completion 标记，防止重复创建。
- `planner.ts` 解析实际插件项目名，携带当前 platform/loader/Minecraft 版本，不再硬编码 LuckPerms。
- `packages/contracts` 增加任务链元数据和 completion continuation 契约。

Cloud 回归测试新增“回调返回 continuation 时只创建一个下一任务”，并验证下一任务保持相同会话、正确父任务、深度 `1` 和 `files.list` 工具提示。

### 插件执行闭环

Go Agent 新增 `plugins.go`，当前支持 Paper 兼容插件：

1. 使用 Modrinth `/v2/project/{project}/version`，按 Paper loader 和当前 Minecraft 版本过滤。
2. 选择主 JAR；只信任官方环境中的 `https://cdn.modrinth.com`。
3. 下载到 Agent 本地隔离区，最大 64 MiB。
4. 验证 Modrinth 声明的 SHA-512，并计算/记录本地 SHA-256。
5. 使用 MCSManager `/api/files/upload` 注册一次性 passport。
6. 向 Daemon `/upload/{password}?overwrite=true` 发送 multipart `file` 字段。
7. 读取 `/plugins` 文件清单确认 JAR 实际落盘。
8. 重启后执行 Minecraft 控制台 `plugins`，同时读取面板输出和 `logs/latest.log` 验证插件已启用。
9. 落盘核验、后续步骤或最终验收失败时，调用 MCSManager 文件删除 API 移除刚上传的 JAR。

存在必需依赖时当前安全行为是停止并报告依赖项目 ID，不能无审批地递归安装。递归依赖计划仍是后续工作。隔离区 JAR 在成功上传后删除，只保留不含密钥的 manifest 和哈希证据。

### 本地和 Linux 验证

Windows 最终结果：

- Python 编译：通过。
- LangGraph/FastAPI：11 项测试通过。
- Cloud：22 项测试通过。
- 全仓 TypeScript 类型检查：通过。
- Next/Nest/Contracts 生产构建：通过。
- Go `go test ./...`：通过，包含 Modrinth 哈希不匹配拒绝、上传 passport、multipart、落盘和回滚测试。
- `git diff --check`：提交前仍需最终重跑。

Linux 迁移最终结果：

- 安装 Debian 官方 `python3-venv`，Python 为 3.11.2。
- Python 测试通过。
- Cloud 22/22 通过。
- Go 全量测试和构建通过。
- `mcai-model-cloud`、`mcai-cloud`、`mcai-agent`、`mcai-web` 均为 active。
- `/health` 返回 `runtime=python-langgraph`。
- 当前 release：`/opt/mcai-langgraph-cloud/releases/20260801130804`。
- 成功部署备份：`/tmp/mcai-langgraph-backup-20260801131037`。

前两次未激活迁移分别暴露：Debian 缺少 `python3-venv`；npm shebang 找不到 Node PATH。第三次远端 Cloud 测试又发现 `/tmp` 清理超时，改用 `/opt/mcai-src/.test-tmp-*` 后 22 项在 1.81 秒内全部通过。每次失败均在 systemd 激活前退出并保持旧服务可用。

### 真实只读对话验收

脚本：`.deploy/verify-langgraph-loop.mjs`。最终输出 `passed=true`，目标为页面当前运行实例，未安装、删除或重启 Minecraft。

验收结果：

- Runtime：`python-langgraph`。
- “需要”恢复上一轮操作：`files.list`。
- 插件任务缺落盘证据的 continuation：`files.list`。
- Cloud 真实任务：`SUCCEEDED`。
- 工具与路径：`files.list /plugins`。
- 实际文件证据：`.paper-remapped`、`bStats`、`spark`。
- 最终答案：未在 `/plugins` 中发现 EssentialsX，因此不能确认该插件已安装，并附实际文件清单。

### 尚未执行和后续限制

- 本轮没有真实安装 EssentialsX，因为插件计划包含高风险重启，必须由用户在 UI 对具体计划确认后才能执行。
- 尚未实现必需依赖的递归解析/多插件统一审批与回滚。
- Cloud 任务仍是内存存储；Cloud 重启会清空任务记录。LangGraph 对话检查点不受此限制。
- 功能提交 `c6e5165 Add LangGraph task orchestration` 已推送到私有仓库 `88766lawrence/mcai-sidecar` 的 `main`。该提交涉及的 25 个文件已逐文件比较 Windows 与 Linux `/opt/mcai-src` SHA-256，差异数为 0；核对时 Windows `HEAD` 与 `origin/main` 均为 `c6e5165c5b8b3ea2f1df6be97aac4f420951df23`。

## 2026-08-01 实例生命周期确定性路由修复

### 故障与根因

用户在页面输入“重启实例”后，MCAI 只显示“暂时没有可用回答。”。Planner、Cloud 工具注册和 Go Agent 均已支持 `instance.restart`，但 Python LangGraph 的确定性路由没有覆盖启动、停止和重启命令。该请求因此被交给模型路由；模型返回空 `answer` 时，`_normalize_decision` 使用了上述兜底文案。

### 修复

- `langgraph-cloud/mcai_graph/graph.py` 新增当前实例生命周期的确定性路由：
  - 启动实例/服务器：`instance.start`。
  - 停止实例/服务器：`instance.stop`。
  - 重启实例/服务器：`instance.restart`。
- “重启实例”现在固定返回“已生成重启计划，等待确认。”，不再依赖模型是否有容量或能否返回完整结构。
- 重启和停止仍保持原有高风险审批策略；路由命中不会自动执行或绕过确认。
- `langgraph-cloud/tests/test_graph.py` 增加直接重启和三类生命周期命令的回归覆盖。

### 验证与部署

- Windows LangGraph/FastAPI：13/13 通过。
- Windows Cloud 定向回归：20/20 通过。
- Linux LangGraph/FastAPI：13/13 通过。
- 仅重启 `mcai-model-cloud`；未重启 `mcai-cloud`、`mcai-agent`、`mcai-web` 或 Minecraft 实例。
- Linux 回滚备份：`/tmp/mcai-lifecycle-routing-backup-20260801142525`。
- Runtime 仍为 `/opt/mcai-langgraph-cloud/releases/20260801130804`。
- 真实 `/v1/chat/stream` 验收结果：`passed=true`、`route=tool`、`preferredTool=instance.restart`、流式和最终回答均为“已生成重启计划，等待确认。”。
- 验收目标是页面当前实例 `mcs:4419b32bc2c64110823a951d2f175833:8a54968e5a944f40b50b6cbefdec3e4f`，验收明确记录 `minecraftRestarted=false`。

## 2026-08-01 生命周期幂等执行、最终回答与折叠思考 UI

### `panel returned HTTP 500` 根因

页面中的失败任务实际为“启动服务器”，任务 `task_e93837e1-2842-4c86-aeb5-7b5da92d3e55` 连续四次调用 `instance.start` 后失败。MCSManager Daemon 原始日志明确返回：`实例未处于关闭状态，无法再进行启动`。实例当时已经运行，Agent 不应重复调用 `/api/protected_instance/open`，更不应把确定性状态冲突当作暂时错误重试四次。

### Agent 修复

- `instance.start` 执行前读取真实实例状态：
  - `running`：直接成功并输出“实例已在运行，无需重复启动”。
  - `starting`：不重复调用面板，进入状态验收。
  - 其他状态：调用面板；若面板响应异常但复查发现已进入 `starting/running`，按真实状态继续验收。
- `instance.stop` 同样具备幂等行为：实例已停止时直接成功；面板响应异常后复查已停止也视为目标已达成。
- 新增 Go 回归覆盖：已运行实例重复启动、已停止实例重复停止、面板响应错误但目标状态已达成。
- 部署回滚点：`/tmp/mcai-lifecycle-execution-backup-20260801144345`。

### LangGraph 最终回答

- 生命周期工具回调不再依赖模型二次生成结果。
- 成功时直接引用 `instance` 工具证据；失败时直接输出真实 `diagnosis/tool` 原因。
- 新增成功和失败两条确定性回调测试。

### 真实幂等启动验收

通过 Cloud 会话真实发送“启动服务器”，目标为页面当前实例。结果：

- 任务：`task_9f22de63-bb8c-4d2a-acfc-04e4e5a2ad7e`。
- 工具：`instance.start`。
- 状态：`SUCCEEDED`。
- 工具证据：`实例已在运行，无需重复启动`。
- 最终回答：`实例已在运行，无需重复启动`。
- MCSManager “实例未处于关闭状态”冲突日志计数：执行前 16，执行后 16，证明没有重复调用 `/open`。
- `minecraftRestarted=false`。

### 折叠思考与工具调用 UI

- LangGraph `/v1/chat/stream` 在文本片段前发送 `route` 事件。
- Cloud 和 Contracts 透传 `direct/clarify/delegate/tool` 路由提示。
- 直接回答继续流式输出。
- 工具任务执行时只显示一个“思考中”；中间工具回答不会作为可见聊天文本流出。
- 工具名称、原始工具 ID、目标实例和状态仅在用户展开“思考中/查看思考过程”后显示。
- 任务结束后单独显示最终结果卡；工具过程默认保持折叠。
- 保留米黄色纸张风格，清除负字间距，保留键盘焦点、44px 以上操作目标与 reduced-motion 支持。
- UI 部署回滚点：`/tmp/mcai-thinking-ui-backup-20260801145342`。

### 最终测试与截图

- Windows LangGraph/FastAPI：16/16 通过。
- Linux LangGraph/FastAPI：16/16 通过。
- Cloud：22/22 通过。
- Go `go test ./...`：通过。
- 全仓 TypeScript 类型检查：通过。
- Next/Nest/Contracts 生产构建：通过。
- 真实流式路由：`route=tool`、`preferredTool=instance.restart`、`passed=true`。
- Edge/Playwright 视觉验收：1440px、390px、375px 均无横向溢出和浏览器运行错误。
- 截图目录：`screenshot/`。
  - `thinking-desktop.png`：仅显示一个“思考中”，工具内容不可见。
  - `tools-expanded-desktop.png`：展开后显示工具与目标实例。
  - `result-desktop.png`：默认折叠过程并显示最终结果。
  - `result-mobile.png`、`result-mobile-375.png`：移动端最终结果。
- `tools-expanded-mobile-375.png`：375px 展开工具过程。

## 2026-08-01 全命令矩阵验收与回调稳定性修复

### 验收范围与安全边界

针对页面当前实例 `mcs:4419b32bc2c64110823a951d2f175833:8a54968e5a944f40b50b6cbefdec3e4f` 执行全命令矩阵。实例在验收前后均保持 `running`，没有停止或重启 Minecraft，没有修改配置、安装服务端或安装插件。

真实执行 12 项：

- `logs.query`：读取最近日志并获得 `kind=logs` 证据。
- `files.list /`：读取实例根目录，共 24 项，包含 `server.jar`、`server.properties`、世界目录和插件目录。
- `files.list /plugins`：读取插件目录，实际清单为 `.paper-remapped`、`bStats`、`spark`。
- `console.command`：依次执行 `list`、`help`、`version`、`plugins`、`pl`、`tps`、`mspt`、`seed`。
- `instance.start`：在已运行实例上做幂等启动验证，结果为“实例已在运行，无需重复启动”。

只验证路由、明确没有执行的 7 项：

- `instance.stop`
- `instance.restart`
- `config.patch`
- `server.install`（Paper 任意明确版本）
- `server.install`（Fabric 任意明确版本）
- `plugin.resolve`
- `plugin.install`

另验证简单问题 `1+1` 走 `direct` 并返回 `2`。最终矩阵为 `20/20` 通过，`destructiveCommandsExecuted=false`，完整复测耗时约 51 秒。

### `mspt` 失败根因与修复

第一次真实矩阵中，`mspt` 命令确实被发送到 Paper 控制台，但任务最终失败。Paper 1.21.1 的实际返回格式为：

```text
Server tick times (avg/min/max) from last 5s, 10s, 1m:
0.1/0.0/0.2, 0.1/0.0/0.8, 0.1/0.0/3.0
```

输出中不含字面量 `mspt`，而 Agent 的完成条件只接受包含 `mspt` 的文本，因此连续读取到了真实输出仍错误判定超时。现已兼容 Paper 的 `Server tick times (avg/min/max)` 标记，并增加 Go 回归测试。最终真实证据为：

```text
Server tick times (avg/min/max) from last 5s, 10s, 1m:
0.3/0.1/15.0, 0.2/0.0/15.0, 0.1/0.0/15.0
```

### 工具回调卡住根因与修复

第一次矩阵还发现：控制台或文件任务已经进入 `SUCCEEDED` 后，LangGraph 仍调用外部模型生成最终文字。模型请求的单次超时为 180 秒且可能在结构化/非结构化及备用模型间重试，导致真实工具已完成但对话长时间没有最终回答。

修复后：

- `console.command` 成功时直接使用 `kind=console` 的真实证据完成回答。
- `files.list` 成功时直接使用 `kind=files` 的真实证据完成回答。
- 工具失败时直接引用失败状态或诊断证据，不把失败润色成成功。
- 路由、复杂委派和其余需要模型的完成评估增加 30 秒总等待上限，超时后进入已有的证据回退，不再无限拖住会话。
- Paper/Fabric 明确版本安装、`view-distance` 配置、插件制品解析增加确定性路由，不依赖模型容量。
- `plugin.resolve` 只创建解析步骤；“解析兼容版本但不要安装”不会误生成插件上传和实例重启计划。

### 测试、部署与回滚点

Windows：

- Go `go test ./...`：通过。
- Cloud Planner：12/12 通过。
- 全仓 TypeScript typecheck：通过。
- Python 语法检查：通过；Windows 未安装 LangGraph/FastAPI 依赖，完整 Python 测试在 Linux 执行。

Linux 部署门禁：

- Go `go test ./...`：通过。
- Python LangGraph/FastAPI：21/21 通过。
- Cloud Planner：12/12 通过。
- 全仓 TypeScript typecheck：通过。
- Cloud 生产构建：通过。
- `mcai-model-cloud`、`mcai-cloud`、`mcai-agent`、`mcai-web`：全部 active。

部署回滚点：

```text
/tmp/mcai-command-matrix-backup-20260801160833
```

部署后最终真实矩阵结果：`passed=true`、`total=20`、`failed=[]`。Minecraft 没有因验收而停止或重启。
