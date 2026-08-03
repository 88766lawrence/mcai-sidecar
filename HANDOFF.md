# MCAI Sidecar 项目交接文档

> 最后核对时间：2026-08-03 13:16（Asia/Hong_Kong）
> Windows 工作区：`E:\aimcs`
> Linux 测试端：`191.40.37.148`
> 当前功能基线：`29084bf Add two-model goal planning pipeline`（文档提交以本地 `HEAD` 为准）

## 1. 当前结论

MCAI Sidecar 是位于 Web 用户和 MCSManager 之间的安全 Minecraft AI 运维层。用户用自然语言描述目标；Cloud 将目标绑定到页面当前实例并生成受约束任务；Linux 上的 Go Agent 使用本机保存的 MCSManager API Key 执行白名单工具；Python LangGraph 根据真实回调继续验证并生成最终回答。

截至本次交接：

- Windows 本地代码和 Linux 测试端的最新关键文件一致。
- Linux 上 `mcai-model-cloud`、`mcai-cloud`、`mcai-agent`、`mcai-web` 四个服务均为 `active`。
- Cloud 健康端点、模型进程健康端点、真实模型 readiness 和 Web 首页均通过。
- 当前模型运行时为 Python LangGraph，实际 readiness 模型为 `MiniMax-M3`。
- 页面保留米黄色运维工作台风格；任务执行期间自动展开实时步骤与回调，完成后结果优先展示且轨迹默认折叠。
- Agent 已能完成一个任务内的多步骤只读检查，例如依次执行 `version → plugins → logs.query`，等待真实回调后汇总结果。
- 简短运维目标已进入两阶段模型流水线：规划模型先补全步骤、约束和验收条件，执行模型再选择受控工具；原始授权边界会单独保留并校验，规划模型不得擅自增加安装、配置、重启或停服。
- 最新真实检查确认测试实例运行 Paper 1.21.1，已加载插件数为 0；日志存在 Paper Watchdog 主线程无响应和 `Can't keep up` 卡顿证据。
- GitHub 当前为本地 `ahead 9, behind 1`（本交接文档提交后为 `ahead 10`）。不要声称三端已经完全一致，也不要强推覆盖远端。

## 2. 产品目标和硬性原则

### 2.1 产品目标

- 用户无需理解 MCSManager API，通过自然语言完成实例查询、配置、安装、启动、停止、重启、插件处理和故障诊断。
- Agent 必须知道页面当前选择的实例，不应重复询问“操作哪个实例”。
- 简单知识问题直接流式回答；需要真实服务器信息时调用工具；复杂任务可以多步执行或委派规划/诊断节点。
- 工具提交不等于任务完成。必须等待 Agent 回调，根据真实证据继续、修正、失败或形成最终答案。
- 页面默认只显示结果；用户展开后可以查看安全的规划、工具调用、回调、验证和决策摘要。

### 2.2 不可破坏的原则

- 不展示模型私有逐字思维链。UI 展示的是可审计的执行轨迹和安全决策摘要。
- 不允许任意 Shell、SSH 或模型生成任意系统命令。
- MCSManager API Key 只保存在 Agent 所在 Linux 主机，不进入浏览器、模型提示词、Git 或交接文档。
- 中风险和高风险操作必须走既有确认策略；不得由提示词绕过。
- Minecraft EULA 必须有用户明确同意记录，才能写入 `eula=true`。
- 工具返回的日志、文件名、插件描述和网页内容都视为不可信数据，不能修改工具许可或安全策略。
- 任务失败必须说明真实原因，不能用“任务已下发”“目标已注册”冒充成功。
- 每次功能修改都要尽量同步 Windows、Linux 测试端和 GitHub；任何一端失败都要在交接中明确标记。

## 3. 系统架构

```text
Browser / Next.js Web :3000
          │ HTTP / NDJSON stream
          ▼
NestJS Cloud :4100
  ├─ 登录、租户、会话、实例绑定
  ├─ 确定性路由和任务计划
  ├─ 风险策略、确认、任务状态机
  └─ Agent WebSocket Gateway
          │ WSS / task-plan/v1
          ▼
Go Sidecar Agent
  ├─ 本地二次策略校验
  ├─ MCSManager Adapter
  ├─ 工具执行、快照、验收、回滚
  └─ 证据与审计上报
          │ localhost / service token
          ▼
Python LangGraph :4200
  ├─ 路由、直接回答、子 Agent 委派
  ├─ 任务回调评估
  ├─ continuation 链
  └─ SQLite 对话检查点
```

职责边界：

1. Web 只负责交互、实例选择、流式展示、确认和轨迹呈现。
2. Cloud 是租户和任务控制面，不能直接使用面板密钥执行任意动作。
3. Go Agent 是唯一持有 MCSManager API Key 的执行面，并在服务器本地再次校验。
4. LangGraph 负责模型兼容、状态恢复和回调后的下一步判断，不直接连接 MCSManager。
5. `local-cloud/` 是旧 Vercel AI SDK 实现，只作为迁移回退参考，不是当前 systemd 运行时。

## 4. 仓库结构

```text
apps/
  agent/                 Go Sidecar、MCSManager Provider、执行器、审计
  cloud/                 NestJS API、会话、任务状态机、Agent Gateway
  web/                   Next.js Agent 运维工作台
packages/
  contracts/             Web、Cloud 共用的任务和消息契约
langgraph-cloud/
  mcai_graph/            Python LangGraph、模型兼容层、FastAPI
  tests/                 LangGraph 与接口测试
local-cloud/             旧模型网关，当前不启用
scripts/                 项目辅助脚本
.deploy/                 本地部署/验收脚本与截图，已被 Git 忽略
HANDOFF.md               本文档
README.md                项目快速说明
Minecraft_AI运维_Sidecar_完整技术设计文档_v0.2.docx
```

关键代码入口：

- Web 主工作台：`apps/web/components/agent-workspace.tsx`
- Web 样式：`apps/web/app/globals.css`
- Cloud 对话闭环：`apps/cloud/src/chat/chat.service.ts`
- Cloud 任务计划：`apps/cloud/src/tasks/planner.ts`
- Cloud 任务状态机：`apps/cloud/src/tasks/tasks.service.ts`
- 模型网关：`apps/cloud/src/model-gateway/model-gateway.service.ts`
- LangGraph：`langgraph-cloud/mcai_graph/graph.py`
- LangGraph FastAPI：`langgraph-cloud/mcai_graph/app.py`
- Agent 执行器：`apps/agent/internal/executor/executor.go`
- MCSManager 客户端：`apps/agent/internal/provider/mcsmanager/client.go`
- 共享契约：`packages/contracts/src/index.ts`

## 5. Linux 测试环境

### 5.1 地址和目录

- 主机：`191.40.37.148`
- Web 原始地址：`http://191.40.37.148:3000/`
- 测试反代域名：`https://test.xiangmuban.com/`
- MCSManager Web：`http://191.40.37.148:23333/`
- MCSManager Daemon WebSocket：`191.40.37.148:24444`
- Linux 源码：`/opt/mcai-src`
- LangGraph release 根目录：`/opt/mcai-langgraph-cloud/releases`
- 当前运行 release：`/opt/mcai-langgraph-cloud/releases/20260801130804`
- 当前软链接：`/opt/mcai-langgraph-cloud/current`
- Node：`/opt/node-v22.17.0-linux-x64/bin/node`
- Go：`/opt/go/bin/go`

### 5.2 systemd 服务

| 服务 | 作用 | 当前状态 |
| --- | --- | --- |
| `mcai-web.service` | Next.js Web，端口 3000 | active |
| `mcai-cloud.service` | NestJS Cloud，端口 4100 | active |
| `mcai-agent.service` | Go Sidecar Agent | active |
| `mcai-model-cloud.service` | Python LangGraph，回环端口 4200 | active |

2026-08-03 实测：

```text
GET 127.0.0.1:4100/api/health -> status=ok
GET 127.0.0.1:4200/health     -> runtime=python-langgraph, configured=true
GET 127.0.0.1:4200/ready      -> status=ready, model=MiniMax-M3
GET 127.0.0.1:3000/           -> HTTP 200
```

`/health` 只验证进程和配置存在；判断模型是否真的能推理必须使用 `/ready`。

### 5.3 本地敏感文件位置

以下位置只能记录路径，不能复制内容：

- Windows SSH 私钥：`E:\aimcs\rainyun-rcs-sidebar.pem`
- Windows SSH known hosts：`E:\aimcs\.deploy\linux_ssh_known_hosts`
- Linux 首次配置与管理员哈希：`/etc/mcai/setup.json`
- Agent 配置：`/etc/mcai/agent.yaml`
- Agent 凭据：`/etc/mcai/credentials.yaml`
- 模型配置：`/etc/mcai-model-cloud/config.json`
- 模型服务环境：`/etc/mcai-model-cloud/mcai-cloud.env`
- LangGraph 状态：`/var/lib/mcai-model-cloud/langgraph.sqlite3`

不要将 API Key、密码、JWT、service token、SSH 私钥内容打印到终端输出、截图或 Git 提交。

## 6. 当前测试实例

- 实例名：`测试`
- 实例引用：`mcs:4419b32bc2c64110823a951d2f175833:8a54968e5a944f40b50b6cbefdec3e4f`
- 当前状态：`running`
- 服务端：Paper
- Minecraft：1.21.1
- Paper 构建：`1.21.1-133-ver/1.21.1@3cb8529`
- Java：25
- 控制台 `plugins`：`Server Plugins (0)`
- `/plugins` 目录曾读取到 `.paper-remapped`、`bStats`、`spark`；这些目录不等于已加载插件。

最近一次复杂只读健康检查发现：

- Paper Watchdog 曾报告主线程超过 15 秒未响应。
- 出现 `Can't keep up`，最大明确证据为落后 `18436ms / 368 ticks`。
- `PaperVersionFetcher` 访问 Paper API 时失败，但 `version` 命令仍返回了本地真实 Paper 版本。
- 当前进程可以响应命令，但不能仅凭“running”判定为完全健康。

## 7. Agent 路由和循环模型

### 7.1 请求生命周期

1. Web 发送消息，并携带当前会话和页面已选实例。
2. Cloud 优先检查安全的确定性路由；没有命中时再调用 LangGraph 模型路由。
3. `direct` 直接流式回答；`delegate` 进入规划或诊断子节点；`tool` 创建受控任务。
4. Cloud Planner 生成 `task-plan/v1`，计算最高风险。
5. 中/高风险任务进入确认；只读/低风险任务可自动执行。
6. Go Agent 逐步执行计划，每一步等待真实结果并上报证据。
7. 任务到终态后，Cloud 调用 `/v1/respond`。
8. LangGraph 根据 `taskState + plan + evidence` 输出最终回答，或返回 continuation 创建下一任务。
9. continuation 保持原会话、原实例、父任务和链深度，最大深度为 6。

### 8.1 两阶段模型目标规划

对于“看看服务器有没有问题”“检查一下服务器”等简短、面向当前实例的运维目标：

1. LangGraph `planner` 节点调用独立的规划 Provider，把短句补全为步骤、工具范围、只读/变更边界和验收标准。
2. Linux 未显式配置 `provider.plannerModel` 时，自动使用第一个 `fallbackModels` 作为规划模型；主 `provider.model` 继续作为执行/路由模型。当前配置因此形成备用模型规划、`MiniMax-M3` 执行的两个 Provider 实例。
3. 规划结果最多 1600 字，并经过授权升级检查；原文未授权时，规划结果不得新增安装、删除、配置修改、重启、停止或管理员权限动作。
4. 执行模型同时接收原始用户目标和细化后的任务说明，再选择一个受控入口工具。Cloud 安全 Planner 根据完整细化意图生成实际多步骤 `task-plan/v1`。
5. UI 只展示安全的“目标已细化”摘要和工具轨迹，不展示模型私有思维链。
6. 规划模型异常时仅允许使用确定性的安全技能补全兜底；风险策略、确认和 Agent 本机白名单仍然不可绕过。

### 7.2 当前可验证的循环形式

- 单任务多步骤：一个计划包含多个工具，Go Agent 顺序执行并逐步回调。
- 跨任务 continuation：证据不足时，LangGraph 请求下一受控工具，Cloud 创建子任务。
- 验证重试：Agent 对允许自主恢复的步骤做有限次数重试；确认型操作不会被自动重复。

最新真实复杂指令：

```text
请对当前实例完成一次只读健康检查：
1. 在控制台执行 version，确认服务端类型和 Minecraft 版本；
2. 在控制台执行 plugins，列出已加载插件；
3. 读取最近日志，检查 ERROR、WARN、崩溃或卡顿证据；
4. 等待每个工具的真实回调，根据回调继续下一步，最后给出综合结论。
不要修改配置，不要安装内容，不要重启或停止服务器。
```

实际轨迹：

```text
console.command(version)
  -> console evidence
console.command(plugins)
  -> console evidence
logs.query(60 minutes, 500 lines)
  -> logs evidence
completion evaluator
  -> 综合最终回答
```

结果：任务 `SUCCEEDED`、风险 `read`、`loopComplete=true`。测试会话已保留在网页会话列表中，标题以 `Readonly loop` 开头。

### 7.3 最新修复的否定语义错误

复杂指令第一次执行时，Planner 把“不要重启或停止服务器”中的“停止”误识别为授权，错误生成了 `instance.stop` 高风险计划。任务停在 `WAITING_CONFIRMATION`，没有实际停服。

提交 `a218544` 已修复：

- 识别“不要、不得、禁止、无需、不应、别、不可、避免”等否定上下文。
- 复合只读健康检查优先生成 `version + plugins + logs.query` 三步只读计划。
- 新增测试防止否定句再次变成生命周期授权。
- 最终回答优先解析真正的 `This server is running ...` 行，不再误取 Paper API URL。
- 日志结果不再机械报告关键词次数，而是归纳 Watchdog、落后 ticks 和版本检查失败等明确类别。

## 8. 已实现工具和风险

| 工具 | 用途 | 默认风险 | 关键保护 |
| --- | --- | --- | --- |
| `logs.query` | 读取受限日志 | read | 时间窗、行数、字节上限、敏感信息清理 |
| `files.list` | 读取实例目录 | read | 路径限制，不写入 |
| `console.command` | Minecraft 控制台 | 按命令分类 | 单行、256 字节、运行实例、双层策略 |
| `server.install` | 安装 Paper/Fabric 任意明确版本 | low/受控 | 官方来源、目标路径、EULA 条件、启动验收 |
| `plugin.resolve` | 查询兼容制品 | low | Modrinth、版本/loader 过滤 |
| `plugin.install` | 上传插件 | medium | 哈希、一次性上传、落盘验证、失败删除 |
| `config.patch` | 修改 Properties 配置 | medium | 路径/键白名单、快照、复读哈希、回滚 |
| `instance.start` | 启动实例 | low | 幂等状态检查、ready 验收 |
| `instance.stop` | 停止实例 | high | 明确授权和确认、幂等检查 |
| `instance.restart` | 重启实例 | high | 明确授权和确认、状态与日志验收 |
| `snapshot.restore` | 回滚快照 | 受控 | 只用于已有任务恢复路径 |

控制台分类：

- 只读：`list`、`help`、`version`、`plugins/pl`、`tps`、`mspt`、`seed`。
- 低风险：`say`、`me`。
- 中风险：`time`、`weather`、`difficulty`、`gamerule`、`gamemode`、`give`、`tp`、`effect` 等。
- 高风险：未知命令、管理员权限命令等。
- 禁止通过普通控制台发送：`stop`、`restart`、`quit`、`end`；必须走实例专用工具。

## 9. 控制台与插件证据语义

- Agent 发控制台命令前读取面板输出和 `logs/latest.log` 两份基线。
- 发命令后轮询增量；任一来源得到完整合法结果才形成 `kind=console` 证据。
- `version` 的 `Checking version, please wait...` 是中间状态，不能提前判定成功。
- `mspt` 的 Paper 输出是 `Server tick times (avg/min/max)`，不一定包含字面量 `mspt`。
- `plugins` 的权威“已加载插件”证据是控制台 `Server Plugins (N)`。
- `/plugins` 文件夹中的配置目录不代表插件已加载；JAR 落盘和运行时加载是两种不同验收。
- 插件安装只有“任务下发/目标注册”而没有文件或控制台证据时，必须继续核验，不能宣称完成。

## 10. 模型适配层

当前模型供应商使用 OpenAI 兼容接口。文档只记录非敏感配置：

- Base URL：`https://ai.profileeast.com/v1`
- 当前 readiness 模型：`MiniMax-M3`
- 配置还包含备用模型；具体列表以 Linux 配置文件为准，不在文档复制密钥。

已修复的兼容问题：

- 上游不严格遵守 `json_schema` 时依次尝试兼容模式。
- 支持自然文本和 `answer/content/text/response/message` 等正文外壳。
- 截断 JSON 只恢复公开 answer，不显示原始 JSON。
- 忽略 `analysis/reasoning` 等私有字段。
- 每个模型请求、整个路由和回调评估都有时间上限。
- 主模型失败时按配置尝试备用模型，并区分认证、限流、超时、网络、格式和内部错误。
- `availableTools: []` 真正表示禁止工具；模型不能自行越权。
- 对话历史按单条和总长度裁剪，避免长日志无限占用上下文。

## 11. Web 工作台现状

页面是米黄色三栏运维工作台：

- 左栏：当前实例、实例资源入口、会话列表、Agent 在线状态。
- 中栏：实例标签、对话、最终结果、折叠轨迹、输入框。
- 右栏：当前任务、工具列表、最新证据。
- 用户消息显示为 `COMMAND`；最终结果显示为 `DONE`。
- 任务运行时自动展开执行卡，标题随状态切换为“正在生成计划 / 准备执行 / 正在执行 / 正在验证”。
- 每个工具步骤分别显示“等待 / 执行中 / 验证中 / 完成”，最近 5 条回调会在执行卡内实时追加；轮询到新证据时保持跟随最新内容，但用户向上滚动后不会强制拉回底部。
- 完成后隐藏重复的中间任务气泡，只保留一个结果卡。
- “展开规划与执行轨迹”展示任务目标、工具 ID、回调证据类型、状态和时间。
- 直接回答使用“展开回答轨迹”，展示安全路由摘要，不展示私有思维链。
- 用户向上翻历史时不会自动跳到底部；接近底部才继续跟随新消息。
- 移动端隐藏非核心右栏，输入区和结果不能横向溢出。
- 图标使用 Lucide；保留键盘焦点和 `prefers-reduced-motion`。

视觉验收截图位于被忽略的 `.deploy/audit-20260802/`：

- `13-live-process-collapsed.png`
- `14-live-process-expanded.png`
- `15-live-direct-collapsed.png`
- `16-agent-trace-expanded.png`
- `17-real-plugin-answer-trace.png`

2026-08-03 运行态验收截图位于 `.deploy/audit-20260803/agent-loop-running-linux.png`。该截图使用 Linux 已部署的 Web 构建和受控验收数据，确认 3 个步骤分别显示“完成 / 执行中 / 等待”、执行卡自动展开、最新回调可见且 1600px 视口无横向溢出。

截图脚本使用已部署 Web 构建和受控 API 数据验证布局；真实后端行为由独立 Linux API 验收脚本验证。不要把模拟 UI 数据误称为真实服务器会话。

## 12. 最近真实验收

### 12.1 插件查询

输入：`查看现在有哪些插件`

结果：

```text
route=tool
tool=console.command
command=plugins
task=SUCCEEDED
answer=当前服务器没有已加载的插件，插件数量为 0。
```

原始控制台日志只保留在折叠证据中，最终回答不再显示时间戳和 `[Server thread/INFO]` 噪声。

### 12.2 多步骤只读健康检查

结果：

```text
tools=console.command,console.command,logs.query
commands=version,plugins
task=SUCCEEDED
evidence=state,console,logs
loopComplete=true
```

最终回答引用：

- Paper `1.21.1-133-ver/1.21.1@3cb8529`
- 已加载插件 0
- Watchdog 超过 15 秒无响应
- 落后 18436ms / 368 ticks
- Paper 版本检查远端 API 失败

### 12.3 两阶段模型短句验收

Linux 真实输入仅为：`看看服务器有没有问题`

结果：

```text
route=tool
plannerVisible=true
tools=console.command,console.command,logs.query
task=SUCCEEDED
passed=true
```

最终回答确认 Paper 1.21.1、已加载插件 0，并从真实日志识别 Watchdog 超过 10 秒未响应、落后 8014ms / 160 ticks 和 Paper 版本检查 API 异常。验收会话已保留在 Web，会话标题以 `Two-model short goal` 开头。

第一次真实验收暴露了旧完成节点依赖“健康检查”固定关键词的问题：三步已执行成功但只返回最后一条插件回调。随后改为以精确工具序列 `console.command → console.command → logs.query` 识别健康检查技能，第二次真实验收通过。

### 12.4 测试门禁

最新 Linux 发布门禁：

- Cloud：34/34 通过。
- Cloud TypeScript typecheck：通过。
- Cloud Nest 生产构建：通过。
- Python LangGraph/FastAPI：65/65 通过。
- Web Next.js 生产构建：通过（最近 UI 发布）。
- 四个 MCAI systemd 服务：active。
- 模型 `/ready`：ready。

常用真实验收脚本：

- `.deploy/verify-model-runtime.mjs`
- `.deploy/verify-command-matrix.mjs`
- `.deploy/verify-complex-agent.mjs`
- `.deploy/verify-plugin-inventory.mjs`
- `.deploy/verify-agent-trace-final.mjs`
- `.deploy/verify-two-model-short-goal.mjs`
- `.deploy/verify-readonly-agent-loop.mjs`

这些脚本会在 Linux 本机读取受保护配置生成短期认证。禁止把生成的 bearer token 下载到 Windows 或输出到日志。

## 13. 当前同步和 Git 状态

### 13.1 Windows 与 Linux

以下关键文件在 2026-08-03 的 Windows 和 Linux SHA-256 一致：

| 文件 | SHA-256 |
| --- | --- |
| `apps/cloud/src/tasks/planner.ts` | `dcb2be6dd1349dccd5f9fd9de4ca81665f0b94a88d322af7b52f7e08204383d6` |
| `apps/cloud/src/tasks/planner.spec.ts` | `8e950fc1371279b36e2301679ec665082b51aefd9fdc6e89ad47fd4f4a988e1b` |
| `apps/web/components/agent-workspace.tsx` | `dc7ca31e305ec9c29288ac1351a7b1f312d0622da04835e5e09b5e4586b52951` |
| `langgraph-cloud/mcai_graph/graph.py` | `2c39d4ad3c012c5ecc7e8977d4a78b0a75941dd0a879104c086e8f85da0caa5a` |
| `langgraph-cloud/tests/test_graph.py` | `bd4c143950d50da36dc1909e41812c1bfcb7e162555bda4d233e7ee0b3b2d72b` |

### 13.2 本地提交

最新提交顺序：

```text
29084bf Add two-model goal planning pipeline
78ac562 Show live agent execution progress
a218544 Run multi-step read-only health checks
757427b Explain tool results and expose execution trace
d78bb2a Route plugin inventory queries correctly
cb9c5f7 Collapse agent process into results
7609613 Refine agent workbench hierarchy
32f19a2 Prevent stale console entry caching
da9f953 Redesign agent operations workbench
05c8d78 Harden LangGraph model adapter
0748bc8 Complete agent command matrix
f4aa2ca Complete lifecycle execution and thinking UI
d12148a Fix instance lifecycle routing
```

### 13.3 GitHub 未同步风险

2026-08-03 已成功 fetch。当前本地 `main` 相对 `origin/main` 为 `ahead 7, behind 1`：

- 本地最新功能提交：`78ac562`；其上将继续产生本交接文档提交。
- 远端 `origin/main`：`2dbfc56 Collapse agent process into results (styles)`。
- 共同祖先：`7609613 Refine agent workbench hierarchy`。

远端 `2dbfc56` 是早期 GitHub 连接器创建的单文件提交，只写入 `apps/web/app/globals.css`。与共同祖先比较，它表现为约 20 行新增、2114 行删除，说明连接器提交的是截断样式文件，不应直接合并覆盖本地完整 CSS。随后对 `agent-workspace.tsx` 的配套写入当时被审批拒绝，因此该远端提交本身不构成完整 UI 功能。

恢复网络后的正确步骤：

1. 从当前本地 `main` 创建临时安全分支。
2. `git show 2dbfc56:apps/web/app/globals.css`，确认远端 20 行样式是否已由本地 `cb9c5f7` 等提交完整实现。
3. 合并 `origin/main` 时明确保留本地完整 `apps/web/app/globals.css`；不要接受远端截断文件。
4. 检查 `git diff 7609613..HEAD -- apps/web/app/globals.css apps/web/components/agent-workspace.tsx`，确认 CSS 和组件成对存在。
5. 运行 Web typecheck、生产构建、桌面/移动截图和 `git diff --check`。
6. 以普通非强制 push 更新 `main`。

禁止使用 `git push --force`、`git reset --hard` 或覆盖远端 connector 提交。

## 14. 部署和回滚

### 14.1 发布原则

- 只发布本次涉及的服务，避免无关重启。
- 发布脚本必须先备份源码、构建产物和运行 release 文件。
- 先测试和构建，再切换/重启服务。
- 健康检查失败必须自动恢复备份。
- Cloud/模型/Web 更新不应顺便重启 Minecraft 实例。

### 14.2 最近部署脚本

- UI：`.deploy/deploy-agent-ui.sh`
- 模型适配：`.deploy/deploy-model-adapter-fix.sh`
- 插件查询：`.deploy/deploy-plugin-inventory-fix.sh`
- 结果与轨迹：`.deploy/deploy-agent-trace-fix.sh`
- 多步骤只读循环：`.deploy/deploy-readonly-loop-fix.sh`

这些脚本针对当时的明确文件集合。使用前必须重新阅读，不要把旧 payload 直接用于新代码。

2026-08-03 12:55 已用 `.deploy/deploy-agent-ui.sh` 发布实时执行过程 UI，只重启 `mcai-web.service`；Linux 自动备份为 `/tmp/mcai-agent-ui-backup-20260803125520`。Linux Web 类型检查、生产构建、本机首页健康检查和公网运行态截图验收均通过。

2026-08-03 13:14 已用 `.deploy/deploy-two-model-planner.sh` 发布两阶段模型流水线，只重启 `mcai-model-cloud` 和 `mcai-cloud`；最终自动备份为 `/tmp/mcai-two-model-planner-backup-20260803131456`。Cloud 34 项、LangGraph/FastAPI 65 项、Cloud typecheck/build、模型 readiness、Cloud health 和四服务 active 检查均通过。

### 14.3 最近可用回滚点

```text
/tmp/mcai-readonly-loop-backup-20260802202706
/tmp/mcai-readonly-loop-backup-20260802202628
/tmp/mcai-readonly-loop-backup-20260802202432
/tmp/mcai-agent-trace-backup-20260802201111
/tmp/mcai-plugin-inventory-backup-20260802195956
/tmp/mcai-agent-ui-backup-20260802181424
/tmp/mcai-model-adapter-backup-20260802150053
```

`20260802202628` 对应一次因 Python 测试失败而自动回滚的尝试；失败原因是正则改造后错误使用 `group(1)`，已在后续 `20260802202706` 修复并通过 61 项测试。不要把失败备份当成首选发布版本。

### 14.4 服务检查命令

```bash
systemctl status mcai-model-cloud mcai-cloud mcai-agent mcai-web
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS http://127.0.0.1:4200/health
curl -fsS http://127.0.0.1:4200/ready
curl -fsSI http://127.0.0.1:3000/
```

日志：

```bash
journalctl -u mcai-model-cloud -n 200 --no-pager
journalctl -u mcai-cloud -n 200 --no-pager
journalctl -u mcai-agent -n 200 --no-pager
journalctl -u mcai-web -n 200 --no-pager
```

## 15. 本地开发和验证

要求：Node.js 22.12+、Go 1.23+、Python 3.11+。

```powershell
cd E:\aimcs
npm install
npm run typecheck
npm test
npm run build
```

Agent：

```powershell
cd E:\aimcs\apps\agent
go test ./...
go build ./cmd/mcai-agent
```

LangGraph：

```powershell
$env:PYTHONPATH='E:\aimcs\langgraph-cloud'
python -m py_compile langgraph-cloud\mcai_graph\graph.py
```

Windows 环境若缺少 `httpx/langgraph/fastapi`，不要把导入失败算成功能失败；完整 Python 测试应在 Linux release 的 `.venv` 中执行。

提交前检查：

```powershell
git status --short
git diff --check
git diff --stat
```

## 16. 已知限制和技术债

### P0：必须优先处理

1. GitHub 与本地/测试端未同步，并可能存在远端分叉；先安全 fetch 和合并。
2. Cloud 任务存储仍以内存为主，Cloud 重启会丢失任务列表和部分会话任务关系；需要 PostgreSQL/Redis 持久化。
3. 多工具循环目前是“确定性复合计划 + 特定 continuation”组合，不是任意自然语言任务都能自动生成可靠多工具 DAG。
4. 生命周期否定语义只修复了已发现的停止场景和复合健康检查。后续应实现统一的授权/否定语义解析，并覆盖启动、重启、安装、删除和配置修改。

### P1：重要增强

1. 插件必需依赖目前只报告依赖项目，不自动递归安装；需要统一审批、顺序安装和整体回滚。
2. 完善通用工具回调状态机，让模型能基于每一步结果动态改计划，而不只执行预生成步骤。
3. 为真实 Agent 循环增加浏览器端 E2E：登录、发送、等待三步工具、展开轨迹、截图。
4. 增加任务取消后的 Agent 中止传播；当前前端“停止发送”主要中止浏览器等待，不一定取消已创建任务。
5. 对长日志做结构化去重和事件聚类，避免重复 Watchdog 堆栈占用证据窗口。

### P2：发布前工程化

1. Pterodactyl Adapter。
2. 对象存储、审计导出、签名更新器。
3. 故障注入、断网恢复、并发任务锁和升级回滚演练。
4. 更严格的 CSP、反向代理安全头、速率限制和告警。
5. 自动上下文压缩的可观测指标和人工查看入口。

## 17. 常见故障定位

### 页面显示 `Failed to fetch`

检查顺序：浏览器 Network → `mcai-web` → `/api` 反代 → `mcai-cloud` → CORS/HTTPS 混合内容。测试域名走 HTTPS 时必须同时支持 API 流和 WebSocket。

### MCSManager 显示无法连接 Daemon

确认 `24444/tcp` 对公网开放，节点地址使用可访问 IP，反向代理启用 WebSocket upgrade。此前 UFW 已为该端口放行，但云厂商安全组也可能单独阻断。

### 模型显示不可用

先看 `/health`，再看 `/ready`。`/health=ok` 不能证明模型可推理。检查模型配置文件、上游 `/models`、认证、容量、超时和响应格式。

### 工具任务成功但没有最终回答

检查任务是否进入终态、是否有 `task_phase=completion` 消息、Cloud 是否调用 `/v1/respond`、LangGraph 是否命中确定性 evidence formatter，最后检查 continuation 是否超过深度 6。

### 插件查询返回根目录

“插件有哪些”应走控制台 `plugins`；“插件目录/插件文件/JAR”才走 `files.list /plugins`。如果 `/` 被误读，completion 应创建 `/plugins` continuation。

### 页面滚动跳动

检查消息轮询是否替换了完全相同的数组、`followLatestRef` 是否在用户上滚后仍为 false、依赖数组是否因 planning/streaming 频繁触发滚底。

### 启动实例返回 HTTP 500

先读取实例真实状态。已运行实例的重复启动必须幂等成功，不能再次调用面板 `/open`。停止同理。

## 18. 接手人的首轮检查清单

1. 阅读本文、根目录技术设计文档和 `TEST_ACCEPTANCE.md`；所有发布结论按验收文档执行。
2. `git status --short --branch`，确认没有覆盖用户修改。
3. 安全 fetch GitHub，解决远端分叉，不强推。
4. 只读检查 Linux 四个服务、Cloud health、模型 ready 和 Web 200。
5. 比较本地与 Linux 关键文件哈希。
6. 运行本地 TypeScript 测试、typecheck、build。
7. 在 Linux 运行 Python 全量测试和涉及服务的测试。
8. 使用只读真实指令验收，不先执行安装、配置、停止或重启。
9. UI 改动必须在 1440px 和 375/390px 截图自审；保持米黄色整体风格。
10. 更新本文的提交、哈希、服务状态、测试数字、回滚点和未同步事项。

## 19. 用户明确偏好

- 执行结果比解释过程重要；不要让用户重复提供实例、版本或库存中已有信息。
- 每次修复后必须自己发送真实命令测试。
- 不接受仅靠 mock 或单元测试宣称修复，必须有真实 Linux 端到端证据。
- 工具调用后必须根据回调继续判断，不能直接结束。
- 正常只显示最终结果；轨迹可展开。
- 不要显示冗长“正在做什么”，进行中只需简洁状态。
- 保留米黄色风格，避免过时大卡片和粗糙聊天气泡。
- 用户翻看历史时不能被强制滚回底部。
- 每次发布尽量同步 Windows、Linux 和 GitHub，并诚实说明失败端。

## 20. 近期变更时间线

- `05c8d78`：修复模型兼容、超时、纯文本/嵌套响应和真实 readiness。
- `da9f953`：Agent 工作台重构。
- `7609613`：细化工作台层级。
- `cb9c5f7`：工具过程默认折叠到最终结果。
- `d78bb2a`：区分插件加载列表与 `/plugins` 文件目录。
- `757427b`：把原始工具日志转为人类可读结果，并展示真实执行轨迹。
- `a218544`：修复否定语义误停服，新增 `version → plugins → logs` 多步骤只读健康检查和综合归纳。

## 21. 2026-08-03 复杂模型与日志诊断修复

本轮针对真实复杂任务验收中暴露的问题完成了以下修复：

1. 知识比较问题（例如“Paper 与 Fabric 的适用场景有什么不同”）不再误入目标规划模型，避免“规划模型 → 执行模型”双调用耗尽超时预算。
2. answer-only 输出预算由 256 tokens 调整为 512 tokens；带明确量化约束的三阶段性能治理方案使用受约束综合器，完整保留阶段、依赖、风险、验收、回滚、停止条件、人数、插件数和维护窗口。
3. Minecraft 性能诊断加入领域硬约束：正常满速是 20 TPS，不能产生 `TPS≥30` 等不可能指标；性能边界主要使用 50ms/tick 与 MSPT 判断。
4. `TPS + MSPT + GC/新区块探索` 场景走稳定的证据综合器，不再因模型瞬时超时返回“模型不可用”，也不会无证据假设 spark、timings、JFR、heapdump 或 MAT 可用。
5. 单独的 `logs.query` 故障诊断改为证据驱动总结：明确区分 PaperVersionFetcher 的 FileNotFoundException/HTTP 404 语义、Watchdog 主线程无响应和 `Can't keep up` 卡顿；不得把 404 擅自归因于 DNS、出口网络或防火墙。
6. 修复 Windows 测试环境关闭 SQLite 后临时目录句柄延迟释放造成的非功能性清理抖动。

最终验证：

- Windows LangGraph：74/74 通过。
- Windows Cloud：35/35 通过。
- contracts/cloud/web TypeScript typecheck：通过。
- Linux LangGraph：74/74 通过。
- 真实复杂 Agent：离线指标诊断、三阶段规划、`logs.query` 工具任务、真实回调和最终日志结论全部通过。
- 真实流式模型：`/ready`、算术直答、Paper/Fabric 知识比较、空工具集安全限制、Cloud NDJSON 流式回答全部通过。
- 三轮 TPS 稳定性：3/3 通过，均正确识别 20 TPS、50ms MSPT 边界，无不可能 TPS 指标和无证据 profiler。
- Linux 四个服务：`mcai-model-cloud`、`mcai-cloud`、`mcai-agent`、`mcai-web` 均为 active。

Linux 最新回滚备份：`/tmp/mcai-model-adapter-backup-20260803163442`。

三端文件哈希：

- `langgraph-cloud/mcai_graph/graph.py`：`0349bfd09d70043a77678bdcda329623eaf98e859828f9ad2e52ee889dfdd021`
- `langgraph-cloud/tests/test_graph.py`：`426ce51e1138541d2ab751a43ea2c27d2bbb63a0cf7a2ebadcac23869098f5a8`
- Windows、本地 Linux 源码目录和 Linux 当前运行 release 三处一致。

外部限制：2026-08-03 验收期间 `ai.profileeast.com` 曾出现一次主模型及备用模型连续超时；随后 `/models` 为 HTTP 200，三个模型恢复返回，最终全量验收通过。受约束的 Minecraft 性能诊断与规划已不依赖该瞬时可用性；普通开放域知识问答仍可能受上游容量影响。

## 22. 2026-08-03 任务润色 Agent 指令集与统一入口

本轮增加了正式的任务润色 Agent 指令集，并把它接入真实 LangGraph 路由，而不是只写一份未使用的提示词。完整可维护版本见根目录 `AGENT_REFINER_INSTRUCTIONS.md`，运行时等价规则位于 `langgraph-cloud/mcai_graph/graph.py` 的 planner prompt。

路由标准：

1. 默认所有非简单任务先进入独立润色模型，由它输出结构化 `plannedMessage + summary`，再交给执行模型或已锁定的受控工具。
2. 只豁免寒暄/感谢/告别、可确定的简单算术，以及参数完整的一步低风险只读操作（如 `version`、`plugins`、明确 `/plugins` 文件读取、单纯日志读取）。
3. 对安装、插件解析、配置修改、停止和重启等已经能确定工具的请求，仍先润色，但保留原先确定的工具，不允许润色模型把操作改成其他工具或扩大授权。
4. 当前会话绑定实例后，“服务、服务端、服务器、实例”均指当前实例，不得再次询问实例 ID。
5. “查看服务是否有异常”“看看服务器有没有问题”等短指令必须自动扩展为 `console version → console plugins → logs.query` 三步只读健康检查，逐一等待真实回调后给综合结论。
6. 任务下发不等于完成；安装必须验证落盘或加载，失败必须根据真实回调决定安全的下一步，禁止伪造成功和无限循环。
7. 润色 Agent 只输出用户可见的规划摘要，不展示私有思维链；UI 展开的“思考过程”是可审计的规划、工具调用与证据轨迹。

同时修复了 Cloud 入口的优先级错误：此前 `extractRealtimeLogIntent()` 会把“查看服务是否有异常”提前截断为单独 `logs.query`，导致绕过润色和三步健康检查。现在 Cloud 会先识别完整操作技能，复杂健康请求不再被日志快捷路由覆盖。

本轮验证：

- Windows LangGraph：80/80 通过。
- Linux LangGraph：80/80 通过。
- Windows 与 Linux Cloud：36/36 通过。
- contracts/cloud/web TypeScript typecheck：通过。
- 真实模型 readiness：通过。
- 真实端到端路由：简单算术跳过润色；插件列表一步直达；Paper/Fabric 知识问答先润色；插件安装和重启均先润色且保持原受控工具和审批路径。
- 真实 Cloud 只读任务：“查看服务是否有异常”成功执行 `console.command(version)`、`console.command(plugins)`、`logs.query`，任务为 `SUCCEEDED`，最终答案包含服务端、插件、日志与综合结论。
- 安装和重启仅验证路由，没有实际安装插件，也没有重启 Minecraft。

Linux 回滚备份：

- LangGraph：`/tmp/mcai-model-adapter-backup-20260803181355`
- Cloud：`/tmp/mcai-refiner-cloud-backup-20260803181824`

关键文件 SHA-256（Windows 与 Linux 源码一致；LangGraph 两个文件同时与当前运行 release 一致）：

- `AGENT_REFINER_INSTRUCTIONS.md`：`c48f042f6384c03350d1562c4a68fea45ecc7e08d801b00a152f4f52960746ad`
- `apps/cloud/src/chat/chat.service.ts`：`59f657fa08c0fcf1aaad29147080f320b1940280500e99133d76f1848d1e8e2e`
- `apps/cloud/src/chat/chat.service.spec.ts`：`dc6d74aa3c865bc44c61c64499cb4fb5e8eab1dda0e9a5e6d2f556954575b761`
- `apps/cloud/src/tasks/planner.ts`：`54e7b295a4d569b8ab61f9caeb821d208921f71eaacc3acdcc31bb552e6d239c`
- `langgraph-cloud/mcai_graph/graph.py`：`5c1ee00e4b1d78abb5461237164eef67c41e61354f996439033bfad0edfa2679`
- `langgraph-cloud/tests/test_graph.py`：`4c6758a0b970ef8ea4dab8b3a96a5a3514ccefe97b327e03aadf185599a48e6f`

## 23. 2026-08-03 多管理员支持

初始化账号仍作为主管理员保留；`SetupRecord.admins` 可以保存额外管理员。登录和 JWT 校验会在主管理员与附加管理员中查找账号，旧版只有单管理员字段的 `setup.json` 无需迁移即可继续使用。

- 新增受认证保护的 `POST /api/admin/accounts`，只有已登录用户才能创建附加管理员。
- 新账号继续使用独立随机 salt 和 scrypt 哈希，明文密码不写入 `setup.json`、源码、日志或本文。
- 重复用户名会被拒绝；新增账号不会替换或禁用原管理员。
- Windows 与 Linux Cloud 测试均为 37/37，通过类型检查和构建。
- Linux 部署回滚点：`/tmp/mcai-multi-admin-backup-20260803185155`。
- 已创建一个额外测试管理员并通过真实 `/api/auth/login` 验证；账号密码只在创建该账号的用户会话中交付，不记录在交接文档。

---

交接基准：当前 Linux 测试端可用，Windows 与 Linux 最新关键文件一致；本轮修复已在本地提交，但 2026-08-03 因访问 `github.com:443` 超时尚未推送，恢复网络后应先核对 `git status --short --branch` 再执行非强制推送。任何后续人员若未重新验证，不应把“服务 active”当作模型、Agent 循环或 Minecraft 实例完全健康的充分证据。
