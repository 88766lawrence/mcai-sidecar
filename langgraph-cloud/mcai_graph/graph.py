from __future__ import annotations

import json
import os
import re
import uuid
import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypedDict

import httpx
import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph


SUPPORTED_OPERATIONS = (
    "logs.query",
    "files.list",
    "server.install",
    "config.patch",
    "plugin.resolve",
    "plugin.install",
    "console.command",
    "instance.start",
    "instance.stop",
    "instance.restart",
)

AFFIRMATIVE = re.compile(r"^(?:需要|要|可以|好的?|好|确认|继续|是|对|行|执行|读取|检查|查一下|重试|yes|ok|continue)[。.!！ ]*$", re.I)


class AgentState(TypedDict, total=False):
    request: dict[str, Any]
    decision: dict[str, Any]
    pending_action: dict[str, str] | None
    next_node: Literal["model", "delegate", "end"]


@dataclass(frozen=True)
class ProviderConfig:
    api_key: str
    base_url: str
    model: str
    fallback_models: tuple[str, ...] = ()


class ModelProvider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    async def structured(self, system: str, messages: list[dict[str, str]], schema: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        models = tuple(dict.fromkeys((self.config.model, *self.config.fallback_models)))
        for model in models:
            for structured in (True, False):
                try:
                    return await self._request(model, system, messages, schema if structured else None)
                except Exception as error:  # noqa: BLE001 - provider errors are normalized here
                    last_error = error
                    if not _capacity_error(error) and structured:
                        continue
                    if not _capacity_error(error):
                        break
        raise RuntimeError("model provider unavailable") from last_error

    async def _request(
        self,
        model: str,
        system: str,
        messages: list[dict[str, str]],
        schema: dict[str, Any] | None,
    ) -> dict[str, Any]:
        endpoint = self.config.base_url.rstrip("/") + "/chat/completions"
        body: dict[str, Any] = {
            "model": model,
            "temperature": 0.15,
            "messages": [{"role": "system", "content": system}, *messages],
        }
        if schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "mcai_decision", "strict": True, "schema": schema},
            }
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(
                endpoint,
                headers={"authorization": f"Bearer {self.config.api_key}"},
                json=body,
            )
        if response.status_code >= 400:
            raise RuntimeError(f"provider HTTP {response.status_code}: {response.text[:240]}")
        payload = response.json()
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        if isinstance(content, list):
            content = "".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
        parsed = _parse_json(str(content))
        if not isinstance(parsed, dict):
            raise RuntimeError("provider did not return a JSON object")
        return parsed


class McaiGraph:
    def __init__(self, provider: ModelProvider, checkpoint_path: Path):
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = aiosqlite.connect(checkpoint_path)
        self._checkpoint_path = checkpoint_path
        self._checkpointer = AsyncSqliteSaver(self._connection)
        self._connection_started = False
        self._connection_lock = asyncio.Lock()
        self.provider = provider
        self.chat = self._build_chat_graph()
        self.completion = self._build_completion_graph()

    def _build_chat_graph(self):
        graph = StateGraph(AgentState)
        graph.add_node("prepare", self._prepare)
        graph.add_node("model", self._model_route)
        graph.add_node("delegate", self._delegate)
        graph.add_edge(START, "prepare")
        graph.add_conditional_edges("prepare", lambda state: state["next_node"], {
            "model": "model",
            "delegate": "delegate",
            "end": END,
        })
        graph.add_conditional_edges("model", lambda state: state["next_node"], {
            "delegate": "delegate",
            "end": END,
        })
        graph.add_edge("delegate", END)
        return graph.compile(checkpointer=self._checkpointer)

    def _build_completion_graph(self):
        graph = StateGraph(AgentState)
        graph.add_node("evaluate", self._evaluate_completion)
        graph.add_edge(START, "evaluate")
        graph.add_edge("evaluate", END)
        return graph.compile(checkpointer=self._checkpointer)

    async def route(self, payload: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_connection()
        thread_id = _thread_id(payload)
        state = await self.chat.ainvoke(
            {"request": payload},
            config={"configurable": {"thread_id": thread_id, "checkpoint_ns": "chat"}},
        )
        return _normalize_decision(state.get("decision"))

    async def respond(self, payload: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_connection()
        thread_id = _thread_id(payload)
        state = await self.completion.ainvoke(
            {"request": payload},
            config={"configurable": {"thread_id": thread_id, "checkpoint_ns": "completion"}},
        )
        return state.get("decision") or _response("任务结果不可用。", status="unavailable")

    async def close(self) -> None:
        if self._connection_started:
            await self._connection.close()
            self._connection_started = False

    async def _ensure_connection(self) -> None:
        if self._connection_started:
            return
        async with self._connection_lock:
            if not self._connection_started:
                await self._connection
                await self._checkpointer.setup()
                os.chmod(self._checkpoint_path, 0o600)
                self._connection_started = True

    async def _prepare(self, state: AgentState) -> AgentState:
        request = state.get("request", {})
        message = str(request.get("message", "")).strip()
        history = request.get("history") if isinstance(request.get("history"), list) else []
        available = set(request.get("availableTools") or SUPPORTED_OPERATIONS)
        pending = state.get("pending_action") or _infer_pending_action(history, available)

        if pending and AFFIRMATIVE.fullmatch(message):
            return {
                "decision": _tool_decision(pending["intent"], pending["tool"], "继续上一轮待执行操作"),
                "pending_action": None,
                "next_node": "end",
            }

        deterministic = _deterministic_decision(message, history, available)
        if deterministic:
            return {"decision": deterministic, "pending_action": None, "next_node": "end"}
        return {"next_node": "model"}

    async def _model_route(self, state: AgentState) -> AgentState:
        request = state.get("request", {})
        history = _history(request)
        try:
            result = await self.provider.structured(_router_prompt(request), history, _decision_schema())
        except Exception:  # noqa: BLE001 - return a stable user-facing failure
            return {
                "decision": _direct("模型云暂时不可用。现有 Agent 与任务执行不受影响。"),
                "next_node": "end",
            }
        decision = _normalize_decision(result)
        pending = decision.pop("pendingAction", None)
        return {
            "decision": decision,
            "pending_action": pending if isinstance(pending, dict) else None,
            "next_node": "delegate" if decision.get("route") == "delegate" else "end",
        }

    async def _delegate(self, state: AgentState) -> AgentState:
        request = state.get("request", {})
        decision = state.get("decision", {})
        kind = decision.get("delegate") if decision.get("delegate") in {"planner", "diagnostics"} else "diagnostics"
        role = (
            "你是规划子 Agent。给出阶段、依赖、风险、验收、回滚与停止条件。"
            if kind == "planner"
            else "你是诊断子 Agent。严格区分事实、推断和待验证项。"
        )
        system = "\n".join((
            role,
            "不得声称已读取实时数据，不得编造测量值，不得输出 Shell、SSH 或 profiler 脚本。",
            "只描述 MCAI 已注册的受控工具；没有变更证据时不得建议回滚。",
            "用简洁中文回答，回答后停止。",
        ))
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }
        try:
            result = await self.provider.structured(system, _history(request), schema)
            answer = str(result.get("answer", "")).strip()
        except Exception:  # noqa: BLE001
            answer = "复杂分析暂时不可用。"
        return {
            "decision": {
                "route": "delegate",
                "delegate": kind,
                "answer": answer,
                "requestId": str(uuid.uuid4()),
                "trace": [{"stage": "delegation", "label": "调用子 Agent", "result": kind}],
            },
            "next_node": "end",
        }

    async def _evaluate_completion(self, state: AgentState) -> AgentState:
        request = state.get("request", {})
        task_state = str(request.get("taskState", ""))
        evidence = request.get("evidence") if isinstance(request.get("evidence"), list) else []
        intent = str(request.get("intent", ""))
        plan = request.get("plan") if isinstance(request.get("plan"), dict) else {}
        tools = [str(step.get("tool", "")) for step in plan.get("steps", []) if isinstance(step, dict)]
        substantive = [item for item in evidence if isinstance(item, dict) and item.get("kind") not in {"state", "verification"}]

        continuation: dict[str, Any] | None = None
        if task_state == "SUCCEEDED" and any(tool in {"plugin.resolve", "plugin.install"} for tool in tools):
            has_plugin_evidence = any(item.get("kind") in {"plugin", "files", "console"} for item in substantive)
            if not has_plugin_evidence:
                continuation = _tool_decision(
                    "列出当前实例 /plugins 目录，确认插件 JAR 已实际落盘",
                    "files.list",
                    "插件任务缺少文件级落盘证据",
                )
        if task_state == "SUCCEEDED" and "files.list" in tools and not any(item.get("kind") == "files" for item in substantive):
            return {
                "decision": _response("文件清单工具未返回文件级证据，无法确认操作完成。", status="answered"),
                "next_node": "end",
            }

        plugin_name = _plugin_name_from_intent(intent)
        files_evidence = next((str(item.get("summary", "")) for item in reversed(substantive) if item.get("kind") == "files"), "")
        if task_state == "SUCCEEDED" and "files.list" in tools and plugin_name and files_evidence:
            normalized_evidence = files_evidence.lower()
            aliases = {plugin_name.lower()}
            if plugin_name.lower() == "essentialsx":
                aliases.add("essentials")
            if any(re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?=[^a-z0-9]|$)", normalized_evidence) for alias in aliases):
                answer = f"已在 /plugins 中发现 {plugin_name}，文件清单证据：{files_evidence}"
            else:
                answer = f"未在 /plugins 中发现 {plugin_name}，因此不能确认该插件已安装。当前文件清单：{files_evidence}"
            return {"decision": _response(answer, status="answered"), "next_node": "end"}

        lifecycle_tool = next((tool for tool in reversed(tools) if tool in {"instance.start", "instance.stop", "instance.restart"}), "")
        if lifecycle_tool and task_state in {"SUCCEEDED", "FAILED", "ROLLED_BACK", "MANUAL_INTERVENTION"}:
            lifecycle_names = {
                "instance.start": "启动实例",
                "instance.stop": "停止实例",
                "instance.restart": "重启实例",
            }
            evidence_summary = next((
                str(item.get("summary", "")).strip()
                for item in reversed(substantive)
                if item.get("kind") in {"instance", "diagnosis", "tool"} and str(item.get("summary", "")).strip()
            ), "")
            if task_state == "SUCCEEDED":
                answer = evidence_summary or f"{lifecycle_names[lifecycle_tool]}已完成。"
            else:
                reason = re.sub(r"^工具返回错误[：:]\s*", "", evidence_summary) or "工具未返回可验证的完成证据"
                answer = f"{lifecycle_names[lifecycle_tool]}失败：{reason}"
            return {"decision": _response(answer, status="answered"), "next_node": "end"}

        if continuation:
            return {
                "decision": {
                    **_response("插件任务缺少实际落盘证据，正在继续读取 /plugins 目录核验。", status="answered"),
                    "continuation": continuation,
                },
                "next_node": "end",
            }

        system = "\n".join((
            "你是 MCAI 的任务回调评估节点。",
            "只依据 task_state、plan 和 evidence；工具已提交或中间状态不等于完成。",
            "成功时引用真实证据，失败时说明真实原因。不得编造文件、版本、插件或数值。",
            "输出简洁中文，不展示内部推理，不追加邀请。",
        ))
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }
        try:
            result = await self.provider.structured(system, [{"role": "user", "content": json.dumps(request, ensure_ascii=False)}], schema)
            answer = str(result.get("answer", "")).strip()
        except Exception:  # noqa: BLE001
            answer = _completion_fallback(task_state, substantive, intent)

        response = _response(answer, status="answered")
        if continuation:
            response["continuation"] = continuation
        return {"decision": response, "next_node": "end"}


def _router_prompt(request: dict[str, Any]) -> str:
    instance = json.dumps(request.get("instance") or {}, ensure_ascii=False)
    operations = json.dumps(request.get("availableTools") or SUPPORTED_OPERATIONS, ensure_ascii=False)
    session = str(request.get("systemPrompt", ""))
    return "\n".join((
        "You are MCAI Sidecar, an execution-oriented Minecraft operations agent.",
        "简单知识直接回答；实时日志、文件、状态和变更必须选择 tool。",
        "复杂且不需要实时数据的规划选择 delegate/planner，复杂诊断选择 delegate/diagnostics。",
        "当前实例是唯一目标，不得重复询问实例。控制台不是 Shell，禁止生成 Shell 或 SSH。",
        "用户要求安装或验证插件时必须调用受控工具，绝不能在没有回调证据时声称安装完成。",
        "若必须澄清，pendingAction 必须保存用户确认后要继续执行的 intent 和 tool。",
        "只输出符合 JSON schema 的对象。",
        f"<current_instance>{instance}</current_instance>",
        f"<available_operations>{operations}</available_operations>",
        f"<session_instructions>{session}</session_instructions>",
    ))


def _decision_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "route": {"type": "string", "enum": ["direct", "clarify", "delegate", "tool"]},
            "answer": {"type": "string"},
            "toolIntent": {"type": ["string", "null"]},
            "preferredTool": {"type": ["string", "null"], "enum": [*SUPPORTED_OPERATIONS, None]},
            "delegate": {"type": ["string", "null"], "enum": ["planner", "diagnostics", None]},
            "pendingAction": {
                "anyOf": [
                    {"type": "null"},
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "intent": {"type": "string"},
                            "tool": {"type": "string", "enum": list(SUPPORTED_OPERATIONS)},
                        },
                        "required": ["intent", "tool"],
                    },
                ]
            },
        },
        "required": ["route", "answer", "toolIntent", "preferredTool", "delegate", "pendingAction"],
    }


def _deterministic_decision(message: str, history: list[Any], available: set[str]) -> dict[str, Any] | None:
    lower = message.lower()
    if not message:
        return _direct("消息不能为空。")
    lifecycle_routes = (
        (
            "instance.restart",
            r"(?:重启|重新启动|restart).{0,10}(?:实例|服务器|服务端)|(?:实例|服务器|服务端).{0,10}(?:重启|重新启动|restart)|^\s*(?:请|帮我|麻烦)?\s*(?:重启|重新启动|restart)(?:一下)?\s*$",
            "重启当前实例并等待重新进入运行状态",
            "已生成重启计划，等待确认。",
        ),
        (
            "instance.stop",
            r"(?:停止|关闭|关停|stop|shutdown).{0,10}(?:实例|服务器|服务端)|(?:实例|服务器|服务端).{0,10}(?:停止|关闭|关停|stop|shutdown)",
            "停止当前实例并等待进入停止状态",
            "已生成停止计划，等待确认。",
        ),
        (
            "instance.start",
            r"(?:启动|开启|开机|start).{0,10}(?:实例|服务器|服务端)|(?:实例|服务器|服务端).{0,10}(?:启动|开启|开机|start)",
            "启动当前实例并等待进入运行状态",
            "正在启动当前实例。",
        ),
    )
    for tool, pattern, intent, answer in lifecycle_routes:
        if tool in available and re.search(pattern, lower, re.I):
            return _tool_decision(intent, tool, "需要执行实例生命周期操作", answer)
    if "logs.query" in available and re.search(r"(?:读取|查看|查询|检查|分析|为什么).{0,12}(?:日志|崩服|报错|卡服)|(?:日志|崩服|报错|卡服).{0,12}(?:原因|分析|检查)", message, re.I):
        return _tool_decision(message, "logs.query", "需要当前实例真实日志")
    if "files.list" in available and re.search(r"(?:确认|检查|查看|读取|列出).{0,16}(?:plugins/?|插件.{0,6}(?:目录|文件|jar|落盘))|(?:plugins/?).{0,16}(?:确认|检查|查看|读取|列出)", message, re.I):
        return _tool_decision("列出当前实例 /plugins 目录并返回实际文件清单", "files.list", "需要文件级证据")
    if "files.list" in available and re.search(r"(?:确定|确认|核实|真的).{0,20}(?:essentials|luckperms|插件).{0,12}(?:安装|存在|落盘)|(?:essentials|luckperms|插件).{0,20}(?:确定|确认|核实|真的|安装了吗|存在吗)", lower, re.I):
        return _tool_decision("列出当前实例 /plugins 目录并确认目标插件 JAR 是否实际落盘", "files.list", "安装声明必须由文件级证据确认")
    if "plugin.install" in available and re.search(r"(?:安装|部署|更新|升级|install|update).{0,24}(?:插件|plugin|essentials|luckperms)|(?:essentials|luckperms).{0,12}(?:安装|部署|更新|升级)", lower, re.I):
        return _tool_decision(message, "plugin.install", "需要执行受控插件工作流")
    if "console.command" in available:
        if re.search(r"(?:服务器|服务端).{0,5}(?:版本|version)|(?:什么|哪种).{0,4}服务端", message, re.I):
            return _tool_decision("在当前实例 Minecraft 控制台执行 version", "console.command", "需要实时服务端版本")
        if re.search(r"(?:已安装|当前).{0,4}插件|插件列表", message, re.I):
            return _tool_decision("在当前实例 Minecraft 控制台执行 plugins", "console.command", "需要实时插件列表")
    if "files.list" in available and re.search(r"根目录|文件列表|目录列表|列出.{0,8}(?:文件|目录)", message, re.I):
        return _tool_decision(message, "files.list", "需要当前实例文件清单")
    return None


def _infer_pending_action(history: list[Any], available: set[str]) -> dict[str, str] | None:
    for item in reversed(history[-6:]):
        if not isinstance(item, dict) or item.get("role") != "assistant":
            continue
        content = str(item.get("content", ""))
        if "files.list" in available and re.search(r"(?:plugins/?|插件).{0,50}(?:读取|读一次|文件清单|确认)|(?:读取|读一次|确认).{0,50}(?:plugins/?|插件)", content, re.I):
            return {"tool": "files.list", "intent": "列出当前实例 /plugins 目录并确认插件 JAR 是否实际落盘"}
        if "instance.restart" in available and re.search(r"(?:是否|要不要|需要).{0,10}重启|重启.{0,10}(?:吗|？|\?)", content, re.I):
            return {"tool": "instance.restart", "intent": "重启当前实例并等待重新进入运行状态"}
        break
    return None


def _history(request: dict[str, Any]) -> list[dict[str, str]]:
    history = request.get("history") if isinstance(request.get("history"), list) else []
    messages = [
        {"role": "assistant" if item.get("role") == "assistant" else "user", "content": str(item.get("content", ""))}
        for item in history[-16:]
        if isinstance(item, dict)
    ]
    message = str(request.get("message", "")).strip()
    if message:
        messages.append({"role": "user", "content": message})
    return messages


def _normalize_decision(value: Any) -> dict[str, Any]:
    decision = value if isinstance(value, dict) else {}
    route = decision.get("route") if decision.get("route") in {"direct", "clarify", "delegate", "tool"} else "direct"
    answer = str(decision.get("answer", "")).strip() or "暂时没有可用回答。"
    normalized: dict[str, Any] = {"route": route, "answer": answer, "requestId": str(decision.get("requestId") or uuid.uuid4())}
    if route == "tool":
        intent = str(decision.get("toolIntent", "")).strip()
        tool = str(decision.get("preferredTool", "")).strip()
        if not intent or tool not in SUPPORTED_OPERATIONS:
            return _direct("无法生成有效的受控工具目标。")
        normalized["toolIntent"] = intent
        normalized["preferredTool"] = tool
        normalized["trace"] = decision.get("trace") or [{"stage": "tool", "label": "调用工具", "result": tool}]
    elif route == "delegate":
        delegate = decision.get("delegate") if decision.get("delegate") in {"planner", "diagnostics"} else "diagnostics"
        normalized["delegate"] = delegate
        normalized["trace"] = decision.get("trace") or [{"stage": "delegation", "label": "调用子 Agent", "result": delegate}]
    if isinstance(decision.get("pendingAction"), dict):
        normalized["pendingAction"] = decision["pendingAction"]
    return normalized


def _tool_decision(intent: str, tool: str, reason: str, answer: str = "正在调用受控工具。") -> dict[str, Any]:
    return {
        "route": "tool",
        "answer": answer,
        "toolIntent": intent,
        "preferredTool": tool,
        "requestId": str(uuid.uuid4()),
        "trace": [{"stage": "tool", "label": "调用工具", "result": tool, "reason": reason}],
    }


def _direct(answer: str) -> dict[str, Any]:
    return {"route": "direct", "answer": answer, "requestId": str(uuid.uuid4())}


def _response(answer: str, status: str) -> dict[str, Any]:
    return {"status": status, "answer": answer, "requestId": str(uuid.uuid4())}


def _completion_fallback(task_state: str, evidence: list[dict[str, Any]], intent: str) -> str:
    if evidence:
        summary = str(evidence[-1].get("summary", "")).strip()
        if summary:
            return summary
    if task_state == "SUCCEEDED":
        return "任务已完成并通过验收。"
    return f"任务未完成（{task_state or 'UNKNOWN'}）：{intent[:120]}"


def _thread_id(payload: dict[str, Any]) -> str:
    value = str(payload.get("threadId") or payload.get("sessionId") or "").strip()
    if value:
        return value[:160]
    instance = payload.get("instance") if isinstance(payload.get("instance"), dict) else {}
    return "anonymous:" + str(instance.get("id") or "default")[:120]


def _parse_json(value: str) -> Any:
    text = value.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def _capacity_error(error: Exception) -> bool:
    return bool(re.search(r"429|503|capacity|rate.?limit|overloaded|temporarily unavailable", str(error), re.I))


def _plugin_name_from_intent(intent: str) -> str | None:
    match = re.search(r"\b(essentialsx?|luckperms|viaversion|viabackwards|geyser|floodgate|spark|worldedit|worldguard|placeholderapi|vault)\b", intent, re.I)
    if not match:
        return None
    name = match.group(1).lower()
    return "EssentialsX" if name in {"essentials", "essentialsx"} else name
