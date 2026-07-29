# MCAI Local Model Cloud

这是与 MCAI 主项目分开的本地模型网关。它只监听回环地址，模型供应商 API Key
仅保存在本服务的 root-only 配置文件中。

配置文件默认位于 `/etc/mcai-model-cloud/config.json`，格式参见
`config.example.json`。MCAI Cloud 使用独立的服务令牌调用 `POST /v1/respond`。

模型网关使用 Vercel AI SDK `ToolLoopAgent` 编排对话：

- 简单问题直接回答，不进入工具循环。
- 复杂但不需要实时数据的问题委派给诊断或规划子 Agent。
- 缺少关键范围时只提出一个澄清问题。
- 需要实时数据或变更时调用 `requestOperation`，只提交受控运维目标。

模型网关不执行 Minecraft 工具，也不能访问 MCSManager API Key。实际工具计划仍由
MCAI Cloud 的确定性策略、风险确认和 Agent 本地校验控制。
