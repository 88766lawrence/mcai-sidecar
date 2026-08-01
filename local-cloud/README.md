# MCAI Local Model Cloud（旧回退实现）

生产测试端的主编排服务已迁移到根目录 `langgraph-cloud/`。本目录保留 Vercel AI SDK 实现，便于回滚和对照测试，不再作为默认部署入口。

这是与 MCAI 主项目分开的本地模型网关。它只监听回环地址，模型供应商 API Key
仅保存在本服务的 root-only 配置文件中。

配置文件默认位于 `/etc/mcai-model-cloud/config.json`，格式参见
`config.example.json`。MCAI Cloud 使用独立的服务令牌调用 `POST /v1/respond`。

模型网关使用 Vercel AI SDK `ToolLoopAgent` 编排对话：

- 简单问题直接回答，不进入工具循环。
- 复杂但不需要实时数据的问题委派给诊断或规划子 Agent。
- 缺少关键范围时只提出一个澄清问题。
- 需要实时数据或变更时调用 `requestOperation`，只提交受控运维目标。

系统提示词采用受 OpenClaw 启发的分层结构：稳定的身份、工具、执行与安全规则位于前部，
当前实例、可用操作和会话偏好位于动态尾部。MCAI 没有直接复制 OpenClaw 的通用个人助理提示词，
而是保留其执行闭环与工具纪律，并改写为 Minecraft 运维、Cloud 风险策略和 Sidecar 本地校验契约。

模型网关不执行 Minecraft 工具，也不能访问 MCSManager API Key。实际工具计划仍由
MCAI Cloud 的确定性策略、风险确认和 Agent 本地校验控制。
