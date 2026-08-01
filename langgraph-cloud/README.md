# MCAI LangGraph Model Cloud

该服务替代旧的一次性模型路由层，负责保存会话状态、恢复待执行动作，并在受控任务回调后判断结束、失败或继续调用下一工具。

边界保持不变：LangGraph 不直接连接 MCSManager，不读取面板 API Key，也不执行 Shell。NestJS Cloud 重新规划每个 continuation 并执行风险策略；Go Agent 执行和验证实际操作。

## 接口

- `GET /health`
- `POST /v1/chat`
- `POST /v1/chat/stream`
- `POST /v1/respond`

所有写接口使用现有模型云 service token。状态默认保存到 `/var/lib/mcai-model-cloud/langgraph.sqlite3`。

## 测试

```bash
PYTHONPATH=langgraph-cloud .venv-langgraph/bin/python -m unittest discover -s langgraph-cloud/tests -v
```

## 安全约束

- 当前页面实例是唯一工具目标。
- 工具提交不是完成，最终回答只能引用 Agent 回调证据。
- continuation 最多串联 6 层，并且每一步重新经过 Cloud 规划和策略检查。
- 中高风险任务仍进入人工确认，不会被 LangGraph 自动批准。
- 不展示内部推理，不生成任意 Shell 或 SSH。
