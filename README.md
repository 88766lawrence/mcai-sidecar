# MCAI Sidecar

MCAI 是面向已有 MCSManager 的安全 Minecraft AI 运维层。用户在 Web/PWA 提出目标，云端生成受约束计划，VPS 上的 Go Agent 通过面板 API 执行并留下快照、验证结果和审计证据。

当前仓库实现了技术设计文档的首个可运行基线：

- Next.js 运维控制台：Agent 配对、实例选择、任务会话、计划审阅、风险确认和证据时间线。
- NestJS 控制面：设备会话、租户隔离、结构化任务、策略状态机、一次性确认令牌和 Agent WSS 网关。
- Go Sidecar Agent：Ed25519 设备身份、主动出站连接、MCSManager Adapter、实例锁、配置快照、复读验证和哈希链审计。
- Python LangGraph 模型云：SQLite 会话检查点、任务回调评估、有界 continuation 链和短回复待办恢复。
- 共享 `task-plan/v1` 与 `agent-message/v1` 协议。

## 仓库结构

```text
apps/
  agent/       Go Sidecar、MCSManager Adapter、受控执行器
  cloud/       NestJS API、Agent Gateway、任务状态机
  web/         Next.js/PWA 运维控制台
packages/
  contracts/   云端与 Web 共享协议
langgraph-cloud/ Python LangGraph 编排服务，仅通过回环地址接受 Cloud 调用
local-cloud/     旧 Vercel AI SDK 网关，保留为迁移回退实现
```

## 本地启动

要求 Node.js 22.12+。运行 Agent 还需要 Go 1.23+。

```bash
npm install
npm run dev
```

模型编排服务单独启动：

```bash
python3 -m venv .venv-langgraph
.venv-langgraph/bin/pip install -r langgraph-cloud/requirements.txt
MCAI_MODEL_CONFIG=/etc/mcai-model-cloud/config.json \
MCAI_LANGGRAPH_STATE=/var/lib/mcai-model-cloud/langgraph.sqlite3 \
.venv-langgraph/bin/uvicorn mcai_graph.app:app --app-dir langgraph-cloud --host 127.0.0.1 --port 4200
```

默认地址：

- Web 控制台：`http://localhost:3000`
- 云端 API：`http://localhost:4100/api`
- Agent Gateway：`ws://localhost:4100/agent`

只预览控制台时，可给云端设置 `MCAI_DEV_SEED=1`，它会创建一个离线的演示实例。演示数据不会在未设置该变量时加载。

## Agent 配置

1. 将 `apps/agent/config/agent.example.yaml` 复制为 `/etc/mcai/agent.yaml`。
2. 将 `apps/agent/config/credentials.example.yaml` 复制为 `/etc/mcai/credentials.yaml`，权限设为 `0600`。
3. 使用 MCSManager 中单独创建的专用 API Key，不要复用日常管理员凭据。
4. 构建并启动：

```bash
cd apps/agent
go build -o mcai-agent ./cmd/mcai-agent
./mcai-agent -config ./config/agent.example.yaml
```

Agent 会输出 8 位配对码。在 Web 左侧输入配对码后，Agent 才会上报已授权租户的实例。

生产环境要求云端使用 HTTPS/WSS；Agent 仅允许 localhost 使用明文 HTTP/WS。Agent 不监听任何公网管理端口。

## 验证命令

```bash
npm run typecheck
npm test
npm run build
go test ./...       # 在 apps/agent 中运行
```

## 已实现的受控工具

| 工具 | 状态 | 本地保护 |
| --- | --- | --- |
| `logs.query` | 已实现 | 响应体和行量受限，仅返回摘要证据 |
| `config.patch` | 已实现 Properties 单键修改 | 路径/扩展名白名单、2 MiB 上限、S1 快照、复读哈希 |
| `instance.restart` | 已实现 | 高风险二次确认、档案 revision 检查、运行状态验收 |
| `plugin.resolve/install` | 已实现 Paper 兼容插件闭环 | Modrinth 版本约束、来源 SHA-512、本地 SHA-256、隔离区、一次性上传、落盘/启动日志验收、失败删除回滚 |
| 任意 Shell | 永久禁止 | 云端和 Agent 双重拒绝未知工具 |

## 当前开发边界

这是设计文档 W1-W3 的工程基线，不是已经达到付费发布门禁的成品。仓库包含独立的 LangGraph 模型云，但需要单独配置 OpenAI 兼容模型供应商。正式部署前仍需接入 PostgreSQL/Redis 任务持久化、插件依赖递归安装、Pterodactyl Adapter、签名更新器、对象存储和故障注入测试。当前 Cloud 任务存储仍在进程内，重启后任务记录会清空；LangGraph 会话检查点使用 SQLite 持久化。

所有面板 API Key 只由 Agent 本机读取；云端数据模型不包含明文 Key。日志、插件描述和网页内容均视为不可信数据，不能修改工具许可、风险或确认规则。
