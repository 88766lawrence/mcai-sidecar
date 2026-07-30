# MCAI 项目交接记录

更新时间：2026-07-30 17:50（Asia/Hong_Kong）

## 1. 当前结论

项目已经可以在本地构建，并已部署到 Linux 测试服务器。当前正在处理的核心问题是：

> 用户在当前实例中发出明确操作指令时，Agent 仍可能追问目标实例或补充信息，而不是直接使用当前实例执行。

这个问题目前只完成了代码链路诊断，**尚未修改代码，也尚未部署修复**。本地 Git 工作树在创建本文档前是干净的。

## 2. 已完成内容

### Agent 与任务能力

- 对话支持多会话、系统提示词、流式输出和工具任务回调。
- 工具执行后会根据回调结果继续生成最终回答，不会在调用工具后直接结束。
- 已实现或接入实例启动、停止、重启、文件列表、服务端安装、配置修改、日志读取等受控操作。
- Paper/Fabric 安装流程支持从自然语言提取平台和 Minecraft 版本。
- Paper 1.21.1 已完成 EULA 受控安装与启动验收流程。
- Agent 会周期上报实例库存，MCSManager 实例状态可同步到 Cloud。
- MCSManager Daemon WebSocket 使用 `24444/tcp`，面板使用 `23333/tcp`。

### 对话 UI

- 保留米黄色 Paper Ops 整体风格。
- 最终结果使用明确的成功/失败区域展示。
- 工具调用过程默认折叠，可展开查看步骤、目标实例、失败原因和下一步。
- Agent 身份头像位于左侧栏，头像、名称、在线状态横向排列。
- 底部聊天输入框已向左移动约 40px。
- 修复了查看历史消息时页面自动跳回最新消息的问题。
- 每次 UI 修改均通过桌面和手机截图检查；最新公网截图在 `.deploy/` 下。

最近本地提交：

```text
6342062 Move agent composer left
897b9d7 Place agent identity in sidebar
81ea239 Improve agent results and tool process UI
eba62c4 fix MCSManager terminal page scroll jumps
b8b0a50 Report instance inventory periodically
95c27c6 Add confirmed instance stop control
1322c68 Fix EULA-controlled server installation verification
4d17606 Loop through transient tool failures and verification
```

## 3. 当前部署状态

### Linux 测试端

- 主机：`191.40.37.148`
- Web：`http://191.40.37.148:3000/`
- MCSManager：`http://191.40.37.148:23333/`
- 代码目录：`/opt/mcai-src`
- Web 服务：`mcai-web.service`
- Cloud 服务：`mcai-cloud.service`
- 模型云服务：独立本地服务，Cloud 通过回环地址调用。
- Node.js：`/opt/node-v22.17.0-linux-x64/bin`

最近一次部署后 `mcai-web.service` 为 `active`，公网 3000 页面已通过 Playwright 加载与截图验证。

部署辅助文件位于 `.deploy/`：

- `.deploy/deploy-agent-ui.sh`
- `.deploy/mcai-agent-ui-update.tar.gz`
- `.deploy/capture-agent-ops.cjs`

部署脚本已经加入服务启动等待重试，避免 systemd 刚重启、3000 端口尚未监听时产生假失败。

### GitHub

- 远端：`origin -> https://github.com/88766lawrence/mcai-sidecar.git`
- 当前分支：`main`
- 上述最新提交尚未推送到 GitHub。
- 推送曾被安全策略阻止。执行前需要用户明确授权具体提交推送到 `origin/main`，不要通过其他方式绕过。

## 4. 正在排查的问题：Agent 不应重复询问实例

用户的最新要求是：

- 当前页面已经选中实例时，Agent 必须知道目标实例。
- 用户发出明确操作指令时，执行优先，不要再次询问实例。
- 仅当操作参数确实无法从指令和实例库存中获得时才追问。

### 已确认的请求链路

1. Web 创建会话时会传递 `instance_ref`：
   - `apps/web/components/agent-workspace.tsx`
2. `ConversationSession` 会永久保存 `instance_ref`：
   - `packages/contracts/src/index.ts`
   - `apps/cloud/src/chat/chat.service.ts`
3. Cloud 发送消息时会通过会话找到实例，并把完整 `ServerProfile` 传给模型网关：
   - `apps/cloud/src/chat/chat.service.ts:144`
   - `apps/cloud/src/chat/chat.service.ts:155`
4. 模型网关请求中已经包含：
   - 实例 ID
   - 实例名称
   - 平台
   - Minecraft 版本
   - Loader
   - 当前状态
   - 位置：`apps/cloud/src/model-gateway/model-gateway.service.ts:191`

因此，实例信息并不是完全没有传递。当前更可能是以下两个问题共同导致：

### 问题 A：前端选择实例与活动会话可能不同步

`agent-workspace.tsx` 中：

- 下拉框直接修改 `selectedInstance`。
- 但 `current` 优先使用 `activeSession.instance_ref`。
- 修改下拉框后，没有同时切换或清空旧的 `activeSessionId`。
- 发送消息仍使用旧的活动会话，因此操作可能绑定到旧实例。

这会导致界面选择、当前会话和实际任务目标出现不一致，是下一步应优先修复的确定性问题。

### 问题 B：模型路由策略允许过度追问

Cloud 默认提示词当前包含：

```text
简单知识问题直接回答；目标含糊时先追问。
```

但没有明确告诉模型：

- 当前请求中的 `instance` 就是已选定的执行目标。
- 不得再次询问用户选择实例。
- 明确操作指令应优先返回 `route=tool`。
- 应先结合实例库存补全平台、版本和状态，再判断是否真的缺少参数。

模型云的 `/v1/chat` 路由提示词也需要检查，位置在 `local-cloud/`。本轮尚未完成这部分搜索。

## 5. 建议的下一步实现顺序

1. 修复 Web 实例切换：
   - 选择新实例时，自动切换到该实例最近的会话；若没有会话则清空活动会话并在发送时创建。
   - 禁止界面显示实例 A、实际向实例 B 的会话发送消息。
2. 强化 Cloud 默认系统提示词：
   - 明确 `instance` 是当前选定且已经授权的目标。
   - 明确操作意图优先 `tool`，不能询问已经存在于实例库存中的信息。
3. 检查并修改 `local-cloud` 的 `/v1/chat` 路由提示词和结构化输出约束。
4. 增加回归测试：
   - “启动服务器”直接产生 `instance.start` 任务。
   - “列出根目录文件”直接产生 `files.list` 任务。
   - 切换实例后任务的 `instance_ref` 必须是新实例。
   - 只有真正缺少版本等必要参数时才允许 `clarify`。
5. 本地运行类型检查、测试、构建。
6. 部署 Linux，并实际让 Agent 对当前实例执行启动或文件列表命令。
7. 对 UI 变化必须截取桌面与 375px 手机截图并人工检查后再交付。

## 6. 常用验证命令

```powershell
npm run typecheck
npm test
npm run build
```

Web 单独验证：

```powershell
npm run typecheck -w @mcai/web
npm run build -w @mcai/web
```

Cloud 单独验证：

```powershell
npm run typecheck -w @mcai/cloud
npm run test -w @mcai/cloud
```

Linux 服务状态：

```bash
systemctl status mcai-web.service --no-pager
systemctl status mcai-cloud.service --no-pager
```

## 7. 安全与操作注意事项

- 不要在文档、日志或提交中写入模型 API Key、MCSManager API Key、管理员密码或 SSH 私钥内容。
- 项目根目录存在服务器部署密钥文件，只能用于已授权的测试服务器，不要提交或输出其内容。
- MCSManager API Key 只应由 Agent 本机读取。
- 不要绕过任务风险确认、Minecraft EULA 确认和禁止任意 Shell 的策略。
- Linux 端、Windows 本地代码和 GitHub 应保持同步；GitHub 推送仍需明确授权。

