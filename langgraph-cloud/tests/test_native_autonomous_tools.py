import asyncio
import json

import mcai_graph.graph as graph_module
from mcai_graph.graph import McaiGraph


TOOLS = [
    {
        "name": "logs.query",
        "description": "Read bounded logs.",
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"window_minutes": {"type": "integer"}},
            "required": ["window_minutes"],
        },
    },
    {
        "name": "instance.restart",
        "description": "Request a confirmed restart.",
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"target": {"type": "string"}},
            "required": ["target"],
        },
    },
]


class FakeNativeProvider:
    def __init__(self, message, route=None):
        self.messages = message if isinstance(message, list) else [message]
        first = self.messages[0] if self.messages else {}
        self.route = route or ("external_io" if first.get("tool_calls") else "self_contained")
        self.seen_tools = None
        self.seen_tool_sets = []
        self.seen_systems = []
        self.seen_messages = []
        self.prefer_fast_values = []
        self.max_tokens_values = []
        self.route_messages = []
        self.chat_calls = 0
        self.reviews = []
        self.review_calls = []
        self.generated_answers = []
        self.answer_calls = []
        self.structured_fast_values = []
        self.config = type("Config", (), {"model": "fake-native"})()

    async def io_route(self, messages):
        self.route_messages.append(messages)
        return {"route": self.route, "providerModel": "fake-router"}

    async def native_tool_turn(self, _system, messages, tools, max_tokens=None, prefer_fast=False):
        self.seen_systems.append(_system)
        self.seen_tools = tools
        self.seen_tool_sets.append(tools)
        self.seen_messages.append(messages)
        self.prefer_fast_values.append(prefer_fast)
        self.max_tokens_values.append(max_tokens)
        return {"message": self.messages.pop(0), "providerModel": "fake-native"}

    async def native_chat_turn(self, _system, messages):
        self.chat_calls += 1
        self.seen_messages.append(messages)
        return {"message": self.messages.pop(0), "providerModel": "fake-native"}

    async def plain_json(self, system, messages, max_tokens=None):
        self.review_calls.append({"system": system, "messages": messages})
        if self.reviews:
            return self.reviews.pop(0)
        return "COMPLETE"

    async def structured(self, system, messages, _schema, timeout_seconds=None, prefer_fast=False):
        self.answer_calls.append({"system": system, "messages": messages, "timeout_seconds": timeout_seconds})
        self.structured_fast_values.append(prefer_fast)
        answer = self.generated_answers.pop(0) if self.generated_answers else "已基于全部成功证据完成综合。"
        return {"answer": answer, "providerModel": "fake-fast"}


def payload(message: str):
    return {
        "message": message,
        "systemPrompt": "Help the user and use tools when needed.",
        "toolCatalog": TOOLS,
        "observations": [],
        "history": [],
        "limits": {"maxRounds": 8, "maxToolCalls": 19},
        "round": 1,
        "instance": {"id": "instance-1", "state": "running"},
    }


async def test_model_receives_complete_catalog_and_owns_tool_selection():
    provider = FakeNativeProvider({
        "tool_calls": [{
            "id": "call-native-1",
            "type": "function",
            "function": {"name": "logs.query", "arguments": '{"window_minutes":30}'},
        }],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("分析卡顿原因并自行选择下一步"))

    assert provider.seen_tools[: len(TOOLS)] == TOOLS
    assert [item["name"] for item in provider.seen_tools[len(TOOLS):]] == ["route_self_contained", "route_uncertain"]
    assert result["decision"] == {
        "action": "tool_call",
        "tool": "logs.query",
        "arguments": {"window_minutes": 30},
        "reason": "正在使用请求所需的受控工具。",
    }


async def test_natural_answer_requires_no_tool_call():
    provider = FakeNativeProvider({"content": "我是 MCAI，可以协助管理这个实例。", "tool_calls": []})
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("你是谁"))

    assert result["decision"] == {
        "action": "final",
        "answer": "我是 MCAI，可以协助管理这个实例。",
        "citations": [],
    }
    assert provider.seen_tools[: len(TOOLS)] == TOOLS
    assert [item["name"] for item in provider.seen_tools[len(TOOLS):]] == ["route_self_contained", "route_uncertain"]
    assert provider.chat_calls == 0


async def test_concept_explanation_route_never_exposes_console_tool():
    provider = FakeNativeProvider({"content": "TPS 是每秒游戏刻数，正常目标通常是 20。", "tool_calls": []})
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("请解释 TPS 是什么，不要查询当前服务器"))

    assert result["decision"]["action"] == "final"
    assert provider.route == "self_contained"
    assert provider.seen_tools is not None


async def test_explicit_user_prohibitions_are_forwarded_as_hard_native_constraints():
    provider = FakeNativeProvider({"content": "我会保持只读且不使用被禁止的能力。", "tool_calls": []})
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("核查现状，但禁止控制台、下载和实例启停"))

    assert result["decision"]["action"] == "final"
    assert len(provider.seen_systems) == 1
    assert "explicit user constraint or prohibition" in provider.seen_systems[0]
    assert "never select a registered function that the user explicitly forbids" in provider.seen_systems[0]


async def test_first_turn_semantic_selection_uses_primary_model():
    provider = FakeNativeProvider({
        "tool_calls": [{
            "id": "call-first-turn-primary",
            "type": "function",
            "function": {"name": "logs.query", "arguments": '{"window_minutes":60}'},
        }],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("核查当前状态并自行选择所需能力"))

    assert result["decision"]["tool"] == "logs.query"
    assert provider.prefer_fast_values == [False], "the primary model must own first-turn semantic selection"


async def test_stopped_instance_catalog_excludes_only_state_unavailable_tools():
    empty_schema = {"type": "object", "additionalProperties": False, "properties": {}, "required": []}
    catalog = [
        {"name": "console.command", "description": "Read live runtime state.", "input_schema": empty_schema},
        {"name": "instance.metrics", "description": "Read live process metrics.", "input_schema": empty_schema},
        {"name": "players.inspect", "description": "Read one online player.", "input_schema": empty_schema},
        {"name": "instance.stop", "description": "Stop a running instance.", "input_schema": empty_schema},
        {"name": "instance.restart", "description": "Restart a running instance.", "input_schema": empty_schema},
        {"name": "instance.start", "description": "Start a stopped instance.", "input_schema": empty_schema},
        {"name": "files.list", "description": "List offline files.", "input_schema": empty_schema},
        {"name": "config.inspect", "description": "Read offline configuration.", "input_schema": empty_schema},
        TOOLS[0],
    ]
    provider = FakeNativeProvider({
        "tool_calls": [{
            "id": "call-offline-log", "type": "function",
            "function": {"name": "logs.query", "arguments": '{"window_minutes":60}'},
        }],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    request = payload("核查停止实例的离线事实")
    request["toolCatalog"] = catalog
    request["instance"]["state"] = "stopped"

    result = await graph.decide_agent_loop(request)

    exposed = {item["name"] for item in provider.seen_tools}
    unavailable = {"console.command", "instance.metrics", "players.inspect", "instance.stop", "instance.restart"}
    assert exposed.isdisjoint(unavailable), "stopped instances must not expose state-unavailable application tools"
    assert {"instance.start", "files.list", "config.inspect", "logs.query"}.issubset(exposed)
    assert result["decision"]["tool"] == "logs.query"


async def test_router_direct_answer_is_reused_without_second_model_call():
    provider = FakeNativeProvider({
        "tool_calls": [{
            "id": "route-self", "type": "function",
            "function": {"name": "route_self_contained", "arguments": '{"answer":"TPS 是每秒游戏刻数。"}'},
        }],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("TPS 是什么？"))

    assert result["decision"]["answer"] == "TPS 是每秒游戏刻数。"
    assert result["providerModel"] == "fake-native"
    assert provider.chat_calls == 0
    assert provider.seen_tools is not None


async def test_uncertain_route_asks_naturally_without_tools():
    provider = FakeNativeProvider({
        "tool_calls": [{
            "id": "route-uncertain", "type": "function",
            "function": {"name": "route_uncertain", "arguments": '{"question":"你希望我先和你讨论目标，还是读取当前服务器状态？"}'},
        }],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("帮我把它弄好"))

    assert result["decision"]["action"] == "final"
    assert provider.seen_tools is not None
    assert "讨论目标" in result["decision"]["answer"]


async def test_direct_architecture_answer_may_discuss_registered_function_names():
    provider = FakeNativeProvider({
        "content": "原生通道可以选择 logs.query；本题只是解释机制，因此不读取服务器状态。",
        "tool_calls": [],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("解释原生工具选择机制"))

    assert result["decision"]["action"] == "final"
    assert "logs.query" in result["decision"]["answer"]


async def test_direct_identity_answer_may_describe_general_tool_capability():
    provider = FakeNativeProvider({
        "content": "我是 MCAI。我会根据目标自主决定是否通过 tool_call 调用受控工具，包括读取状态或运行控制台命令；当前问题无需调用。",
        "tool_calls": [],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("你是谁"))

    assert result["decision"]["action"] == "final"
    assert "自主决定" in result["decision"]["answer"]


async def test_text_cannot_impersonate_a_native_tool_call():
    invalid = {
        "content": '{"action":"tool_call","tool":"instance.restart","arguments":{"target":"instance-1"},"reason":"x"}',
        "tool_calls": [],
    }
    provider = FakeNativeProvider([invalid, invalid])
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    try:
        await graph.decide_agent_loop(payload("重启实例"))
    except Exception as error:
        assert "AGENT_LOOP_INVALID_RESPONSE" in str(error)
    else:
        raise AssertionError("text action unexpectedly became an executable tool call")


async def test_invalid_native_arguments_are_repaired_once_without_planner_rewrite():
    provider = FakeNativeProvider([
        {
            "tool_calls": [{
                "id": "call-invalid",
                "type": "function",
                "function": {"name": "logs.query", "arguments": '{"window_minutes":"thirty"}'},
            }],
        },
        {
            "tool_calls": [{
                "id": "call-repaired",
                "type": "function",
                "function": {"name": "logs.query", "arguments": '{"window_minutes":30}'},
            }],
        },
    ])
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("检查最近半小时的异常日志"))

    assert result["repairUsed"] is True
    assert result["decision"]["tool"] == "logs.query"
    assert result["decision"]["arguments"] == {"window_minutes": 30}
    assert len(provider.seen_messages) == 2
    assert "previous native decision was invalid" in provider.seen_messages[1][-1]["content"]


async def test_multiple_native_calls_are_serialized_in_provider_order():
    provider = FakeNativeProvider({
        "tool_calls": [
            {
                "id": "call-one",
                "type": "function",
                "function": {"name": "logs.query", "arguments": '{"window_minutes":30}'},
            },
            {
                "id": "call-two",
                "type": "function",
                "function": {"name": "instance.restart", "arguments": '{"target":"instance-1"}'},
            },
        ],
    })
    graph = object.__new__(McaiGraph)
    graph.provider = provider

    result = await graph.decide_agent_loop(payload("先查日志再决定是否重启"))

    assert result["repairUsed"] is False
    assert result["decision"]["tool"] == "logs.query"
    assert result["decision"]["arguments"] == {"window_minutes": 30}






async def test_total_decision_deadline_caps_router_and_answer_chain():
    class SlowProvider(FakeNativeProvider):
        async def native_tool_turn(self, _system, _messages, _tools, max_tokens=None, prefer_fast=False):
            await asyncio.sleep(1)
            return {"message": {"content": "late", "tool_calls": []}, "providerModel": "slow"}

    provider = SlowProvider({"content": "late", "tool_calls": []})
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    previous = graph_module.AGENT_LOOP_TOTAL_SECONDS
    graph_module.AGENT_LOOP_TOTAL_SECONDS = 0.02
    started = asyncio.get_running_loop().time()
    try:
        try:
            await graph.decide_agent_loop(payload("你好"))
        except Exception as error:
            assert "TIMEOUT" in str(error)
        else:
            raise AssertionError("slow route unexpectedly exceeded the absolute deadline")
    finally:
        graph_module.AGENT_LOOP_TOTAL_SECONDS = previous
    assert asyncio.get_running_loop().time() - started < 0.2


async def test_terminal_review_projection_keeps_all_attempts_with_bounded_high_signal_results():
    observations = []
    for index, status in enumerate(["succeeded", "failed", "failed", "failed", "succeeded", "succeeded"]):
        observations.append({
            "tool_call_id": f"call-{index}",
            "tool": ["logs.query", "logs.query", "logs.query", "logs.query", "config.inspect", "files.list"][index],
            "status": status,
            "retryable": False,
            "side_effect": "none",
            "error": {"code": "TOO_MANY_FILTERS"} if status == "failed" else {},
            "data": {"result": ("evidence-" + str(index) + "-") * 400},
            "evidence": {"summaries": [("summary-" + str(index) + "-") * 80]},
        })

    projected = graph_module._terminal_review_observations(observations)

    assert len(projected) == len(observations)
    assert len(json.dumps(projected, ensure_ascii=False, separators=(",", ":"))) <= 5_000
    assert all(projected[index]["structured_result"] == "" for index in (1, 2, 3))
    assert all(projected[index]["structured_result"] for index in (0, 4, 5))
    assert [item["tool"] for item in projected] == [item["tool"] for item in observations]


async def test_evidence_routing_projection_folds_only_older_recovered_failures():
    observations = [
        {"tool_call_id": "new-config-success", "tool": "config.inspect", "status": "succeeded"},
        {"tool_call_id": "old-config-failure", "tool": "config.inspect", "status": "failed"},
        {"tool_call_id": "new-log-failure", "tool": "logs.query", "status": "failed"},
        {"tool_call_id": "old-log-success", "tool": "logs.query", "status": "succeeded"},
        {"tool_call_id": "unresolved-files-failure", "tool": "files.list", "status": "failed"},
    ]

    projected = graph_module._evidence_routing_observations(observations)
    ids = [item["tool_call_id"] for item in projected]

    assert "new-config-success" in ids
    assert "old-config-failure" not in ids
    assert "new-log-failure" in ids and "old-log-success" in ids
    assert "unresolved-files-failure" in ids


async def test_terminal_answer_projection_keeps_user_facts_and_removes_protocol_details():
    observations = [
        {
            "tool_call_id": "call-logs-internal", "tool": "logs.query", "status": "succeeded", "side_effect": "none",
            "evidence": {"summaries": [
                "Tool registry and policy checks passed",
                "Log query result: matches=0; window_minutes=60; scanned_lines=200; sample_count=0; query_digest=" + "a" * 64 + "; filters=error|out_of_memory\nMatched samples: <none>",
                "Executed successfully; not independently verified",
            ]},
        },
        {
            "tool_call_id": "call-files-internal", "tool": "files.list", "status": "succeeded", "side_effect": "none",
            "evidence": {"summaries": ["实例目录 plugins：EssentialsX-2.22.0.jar、LuckPerms-Bukkit-5.5.53.jar"]},
        },
        {
            "tool_call_id": "call-root-internal", "tool": "files.list", "status": "succeeded", "side_effect": "none",
            "evidence": {"summaries": ["实例目录 .：cache、logs、plugins、server.properties"]},
        },
        {
            "tool_call_id": "call-config-internal", "tool": "config.inspect", "status": "succeeded", "side_effect": "none",
            "evidence": {"summaries": [
                "Read /server.properties (1388 bytes, sha256:8f33b536f83542db)\nonline-mode=true\ndifficulty=easy\nmax-players=20\nview-distance=10",
            ]},
        },
        {
            "tool_call_id": "call-failed-internal", "tool": "config.inspect", "status": "failed", "side_effect": "none",
            "evidence": {"summaries": ["config.inspect failed: panel returned HTTP 500"]},
        },
    ]

    projected = graph_module._terminal_answer_observations(observations)
    encoded = json.dumps(projected, ensure_ascii=False, separators=(",", ":"))
    sanitized_draft = graph_module._sanitize_terminal_answer_text(
        "EssentialsX 与 difficulty=easy；logs.query 的 out_of_memory；query_digest=" + "b" * 64 + "; filters=error|warning"
    )

    assert "EssentialsX-2.22.0.jar" in encoded
    assert "cache、logs、plugins" not in encoded
    assert "online-mode=true" in encoded and "difficulty=easy" in encoded and "view-distance=10" in encoded
    assert "time window 60 minutes" in encoded and "lines examined 200" in encoded and "matches 0" in encoded
    for forbidden in (
        "logs.query", "config.inspect", "call-", "sha256", "query_digest", "filters=", "out_of_memory",
        "Tool registry", "not independently verified", "HTTP 500",
    ):
        assert forbidden not in encoded
    assert "EssentialsX" in sanitized_draft and "difficulty=easy" in sanitized_draft
    assert "logs.query" not in sanitized_draft and "out_of_memory" not in sanitized_draft
    assert "query_digest" not in sanitized_draft and "filters=" not in sanitized_draft
    assert graph_module._max_tokens_for_schema({
        "properties": {"answer": {"type": "string", "maxLength": 650}}, "required": ["answer"],
    }) == 320
    assert graph_module._max_tokens_for_schema({
        "properties": {"answer": {"type": "string", "maxLength": 800}}, "required": ["answer"],
    }) == 400
    assert graph_module._max_tokens_for_schema({
        "properties": {"answer": {"type": "string", "maxLength": 12_000}}, "required": ["answer"],
    }) == graph_module.MODEL_ANSWER_MAX_TOKENS

    positive = graph_module._terminal_answer_observations([{
        "tool_call_id": "call-positive", "tool": "logs.query", "status": "succeeded", "side_effect": "none",
        "evidence": {"summaries": [
            "Log query result: matches=197; window_minutes=60; scanned_lines=200; sample_count=2; query_digest=" + "c" * 64 + "; filters=error|server_lag\n"
            "Matched samples:\n[08:56:51] [INFO]: Saved world_the_end\n[08:56:52] [INFO]: All chunks are saved",
        ]},
    }])
    positive_text = json.dumps(positive, ensure_ascii=False)
    assert "matches 197" in positive_text and "samples 2" in positive_text
    assert "2 shown sample lines are all INFO-level save records" in positive_text
    assert "other 195 matches were not shown or reviewed" in positive_text
    assert "world the end" not in positive_text and "not support a claim" in positive_text
    assert "query_digest" not in positive_text and "server_lag" not in positive_text

    duplicate_summary = (
        "Log query result: matches=18; window_minutes=60; scanned_lines=50; sample_count=1; "
        "query_digest=" + "d" * 64 + "; filters=error\n"
        "Matched samples:\n[08:56:37] [Paper Watchdog Thread/ERROR]: ForkJoinPool.awaitWork"
    )
    duplicated = graph_module._terminal_answer_observations([
        {
            "tool_call_id": "call-log-first", "tool": "logs.query", "status": "succeeded",
            "evidence": {"summaries": [duplicate_summary]},
        },
        {
            "tool_call_id": "call-log-repeated", "tool": "logs.query", "status": "succeeded",
            "evidence": {"summaries": [duplicate_summary]},
        },
    ])
    assert len(duplicated) == 1, "identical successful facts must not overload terminal synthesis"
    duplicate_text = json.dumps(duplicated, ensure_ascii=False)
    assert "1 shown sample lines are all ERROR-level records" in duplicate_text
    assert "First shown sample" in duplicate_text and "ForkJoinPool.awaitWork" in duplicate_text

    semantic_observations = [
        {
            "tool_call_id": "call-root", "tool": "files.list", "status": "succeeded",
            "evidence": {"summaries": ["实例目录 .： 共 3 项：plugins、logs、server.properties"]},
        },
        {
            "tool_call_id": "call-list", "tool": "files.list", "status": "succeeded",
            "evidence": {"summaries": ["实例目录 plugins： 共 2 项：Alpha.jar、Beta"]},
        },
        {
            "tool_call_id": "call-config", "tool": "config.inspect", "status": "succeeded",
            "evidence": {"summaries": ["Read /server.properties\nmode=true"]},
        },
        {
            "tool_call_id": "call-log", "tool": "logs.query", "status": "succeeded",
            "evidence": {"summaries": [duplicate_summary]},
        },
    ]
    safe_review = (
        "1. 清单共2项：Alpha.jar、Beta，条目未作解读。"
        "2. 配置为mode=true，按原值记录。"
        "3. 查询匹配18条，展示1条样本为ERROR记录，剩余17条未审阅，不能外推整体。"
    )
    assert graph_module._terminal_review_semantic_error(safe_review, semantic_observations) is None
    assert graph_module._terminal_review_semantic_error(
        safe_review + "展示的1条样本中未发现内存故障字样，不能外推其余匹配。",
        semantic_observations,
    ) is None
    second_log_summary = (
        "Log query result: matches=10; window_minutes=60; scanned_lines=10; sample_count=1; "
        "query_digest=" + "e" * 64 + "; filters=warning\n"
        "Matched samples:\n[08:57:00] [Server thread/ERROR]: Other"
    )
    multiple_log_observations = [
        *semantic_observations,
        {
            "tool_call_id": "call-log-second", "tool": "logs.query", "status": "succeeded",
            "evidence": {"summaries": [second_log_summary]},
        },
    ]
    safe_multiple_review = (
        safe_review
        + "另一查询匹配10条，展示1条样本为ERROR记录，剩余9条未审阅，不能外推整体。"
    )
    assert graph_module._terminal_review_semantic_error(
        safe_multiple_review, multiple_log_observations,
    ) is None
    adjacent_remainder_review = safe_review.replace(
        "展示1条样本为ERROR记录，剩余17条",
        "展示1条ERROR级样本，剩余17条",
    )
    assert graph_module._terminal_review_semantic_error(
        adjacent_remainder_review, semantic_observations,
    ) is None
    assert graph_module._terminal_review_semantic_error(
        safe_multiple_review + "合计28条匹配。", multiple_log_observations,
    ) == "LOG_DERIVED_COUNT_INFERENCE"
    assert graph_module._terminal_review_semantic_error(
        safe_multiple_review + "合计2条样本。", multiple_log_observations,
    ) == "LOG_DERIVED_COUNT_INFERENCE"
    ten_entries = [f"Entry-{index}.jar" for index in range(1, 11)]
    assert graph_module._terminal_review_semantic_error(
        "plugins目录共10项：" + "、".join(ten_entries),
        [{
            "tool_call_id": "call-ten", "tool": "files.list", "status": "succeeded",
            "evidence": {"summaries": ["实例目录 plugins： 共 10 项：" + "、".join(ten_entries)]},
        }],
    ) is None
    assert graph_module._terminal_review_semantic_error(
        "plugins目录共2项：LuckPerms-Bukkit-5.5.53.jar",
        [{
            "tool_call_id": "call-prefix", "tool": "files.list", "status": "succeeded",
            "evidence": {"summaries": [
                "实例目录 plugins： 共 2 项：LuckPerms、LuckPerms-Bukkit-5.5.53.jar",
            ]},
        }],
    ) == "LISTING_ENTRY_OMITTED"
    for equivalent_scope in ("未审查", "未查看", "未查阅", "未检视"):
        assert graph_module._terminal_review_semantic_error(
            safe_review.replace("未审阅", equivalent_scope), semantic_observations,
        ) is None
    assert graph_module._terminal_review_semantic_error(
        safe_review.replace("Alpha.jar、Beta", "Alpha.jar为插件、Beta"), semantic_observations,
    ) == "LISTING_ENTRY_INFERENCE"
    assert graph_module._terminal_review_semantic_error(
        safe_review.replace("Alpha.jar、Beta", "Alpha.jar"), semantic_observations,
    ) == "LISTING_ENTRY_OMITTED"
    assert graph_module._terminal_review_semantic_error(
        safe_review + "其余1项插件清单未解释。", semantic_observations,
    ) == "LISTING_COUNT_INFERENCE"
    assert graph_module._terminal_review_semantic_error(
        safe_review.replace("mode=true", "mode已读取"), semantic_observations,
    ) == "CONFIG_VALUE_OMITTED"
    assert graph_module._terminal_review_semantic_error(
        safe_review + "内存故障应优先关注。", semantic_observations,
    ) == "UNSUPPORTED_RISK_INFERENCE"
    assert graph_module._terminal_review_semantic_error(
        safe_review.replace("查询匹配18条，展示1条样本为ERROR记录", "ERROR类共18条匹配，展示1条样本"),
        semantic_observations,
    ) == "LOG_SAMPLE_SCOPE_INFERENCE"
    assert graph_module._terminal_review_semantic_error(
        safe_review.replace("剩余17条未审阅", "剩余17条ERROR记录未审阅"),
        semantic_observations,
    ) == "LOG_SAMPLE_SCOPE_INFERENCE"




async def test_evidence_routing_uses_primary_model():
    provider = FakeNativeProvider({"content": "日志事实已核查。", "tool_calls": []})
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    graph.planner_provider = provider
    request = payload("总结已取得的日志事实")
    request["round"] = 2
    request["observations"] = [{
        "tool_call_id": "call-logs", "tool": "logs.query", "status": "succeeded",
        "data": {"result": {"matches": 1}},
        "evidence": {"summaries": ["日志命中1条"]},
    }]

    await graph.decide_agent_loop(request)

    assert provider.prefer_fast_values == [False], "evidence sufficiency routing must use the configured primary model"
    assert provider.max_tokens_values == [graph_module.AGENT_LOOP_MAX_PROVIDER_TOKENS]


async def test_native_provider_falls_back_after_model_specific_http_400():
    requested_models = []

    class Response:
        def __init__(self, status_code, body):
            self.status_code = status_code
            self._body = body

        def json(self):
            return self._body

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _endpoint, *, headers, json):
            assert headers["authorization"] == "Bearer test-key"
            requested_models.append(json["model"])
            if json["model"] == "fast-model-highspeed":
                return Response(400, {"error": {"message": "model-specific request rejection"}})
            return Response(200, {"choices": [{"message": {"content": "已完成综合。", "tool_calls": []}}]})

    original_client = graph_module.httpx.AsyncClient
    graph_module.httpx.AsyncClient = Client
    try:
        provider = graph_module.ModelProvider(graph_module.ProviderConfig(
            api_key="test-key", base_url="https://provider.invalid/v1",
            model="primary-model", fallback_models=("fast-model-highspeed",),
        ))
        turn = await provider.native_tool_turn("system", [{"role": "user", "content": "context"}], TOOLS, prefer_fast=True)
    finally:
        graph_module.httpx.AsyncClient = original_client

    assert requested_models == ["fast-model-highspeed", "primary-model"]
    assert turn["providerModel"] == "primary-model"
    assert turn["message"]["content"] == "已完成综合。"


async def test_native_provider_falls_back_after_empty_public_message():
    requested_models = []

    class Response:
        status_code = 200

        def __init__(self, body):
            self._body = body

        def json(self):
            return self._body

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _endpoint, *, headers, json):
            assert headers["authorization"] == "Bearer test-key"
            requested_models.append(json["model"])
            if json["model"] == "fast-model-highspeed":
                return Response({"choices": [{"message": {
                    "content": None, "tool_calls": [], "reasoning_content": "private reasoning only",
                }}]})
            return Response({"choices": [{"message": {
                "content": None,
                "tool_calls": [{
                    "id": "call-final", "type": "function",
                    "function": {"name": "route_evidence_final", "arguments": '{"answer":"已完成综合。"}'},
                }],
            }}]})

    original_client = graph_module.httpx.AsyncClient
    graph_module.httpx.AsyncClient = Client
    try:
        provider = graph_module.ModelProvider(graph_module.ProviderConfig(
            api_key="test-key", base_url="https://provider.invalid/v1",
            model="primary-model", fallback_models=("fast-model-highspeed",),
        ))
        turn = await provider.native_tool_turn(
            "system", [{"role": "user", "content": "context"}],
            TOOLS, prefer_fast=True,
        )
    finally:
        graph_module.httpx.AsyncClient = original_client

    assert requested_models == ["fast-model-highspeed", "primary-model"], (
        "empty public provider messages must fall back within the native turn")
    assert turn["providerModel"] == "primary-model"
    assert turn["message"]["tool_calls"][0]["function"]["name"] == "route_evidence_final"
















async def test_answer_coverage_omission_is_corrected_without_reopening_tools():
    provider = FakeNativeProvider({
        "content": None,
        "tool_calls": [{
            "id": "call-complete", "type": "function",
            "function": {"name": "route_evidence_complete", "arguments": "{}"},
        }],
    })
    provider.generated_answers = [
        "插件和日志已经核查；out_of_memory 零命中；query_digest=" + "a" * 64 + "; filters=error|warning；online-mode=true，max-players=20。",
        "插件和日志已经核查；online-mode=true、difficulty=easy、max-players=20，并已给出风险优先级。",
    ]
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    request = payload("汇总插件、difficulty 和日志，并给出风险优先级")
    request["round"] = 4
    request["observations"] = [
        {"tool_call_id": "call-files", "tool": "files.list", "status": "succeeded", "side_effect": "none", "evidence": {"summaries": ["插件已读取"]}},
        {"tool_call_id": "call-config", "tool": "config.inspect", "status": "succeeded", "side_effect": "none", "evidence": {"summaries": ["difficulty=easy (1388 bytes, sha256:8f33b536f83542db)"]}},
        {"tool_call_id": "call-logs", "tool": "logs.query", "status": "succeeded", "side_effect": "none", "evidence": {"summaries": ["Log query result: matches=0; window_minutes=60; scanned_lines=200; sample_count=0; query_digest=" + "a" * 64 + "; filters=error|out_of_memory"]}},
    ]

    result = await graph.decide_agent_loop(request)

    assert len(provider.seen_tool_sets) == 1, "answer correction must never reopen application tools"
    assert provider.structured_fast_values == [False, False]
    assert len(provider.answer_calls) == 2
    assert result["repairUsed"] is True
    assert "difficulty=easy" in result["decision"]["answer"]
    review_context = json.loads(provider.answer_calls[0]["messages"][0]["content"])
    assert set(review_context) == {"request", "facts", "constraints"}
    assert "isolated scalar values as opaque facts" in provider.answer_calls[0]["system"]
    assert "never an overall stability claim" in provider.answer_calls[0]["system"]
    assert "Never infer duplicates, version relationships, grouping, or coexistence" in provider.answer_calls[0]["system"]
    assert "A positive match count must never be called zero" in provider.answer_calls[0]["system"]
    assert "remaining count not shown or reviewed" in provider.answer_calls[0]["system"]
    assert "never add a separate conclusion, priority, compliance heading, or trailing text" in provider.answer_calls[0]["system"]
    assert "instead of enumerating lines" in provider.answer_calls[0]["system"]
    assert "at most four sentences" in provider.answer_calls[0]["system"]
    assert "Any absence statement must be explicitly limited to the shown sample lines" in provider.answer_calls[0]["system"]
    assert "Start immediately with the highest-priority numbered requested subject" in provider.answer_calls[0]["system"]
    assert "relevance to the user's requested conclusion" in provider.answer_calls[0]["system"]
    assert "literal operational observations precede uninterpreted static values" in provider.answer_calls[0]["system"]
    assert "multiple queries for the same subject remain compact clauses" in provider.answer_calls[0]["system"]
    assert "never add a parenthetical or colon explanation" in provider.answer_calls[0]["system"]
    assert "never translate, normalize, or infer aliases" in provider.answer_calls[0]["system"]
    correction_context = json.loads(provider.answer_calls[1]["messages"][0]["content"])
    assert set(correction_context) == {"request", "facts", "constraints", "deterministic_audit_error"}
    assert correction_context["deterministic_audit_error"] == "$.answer:INTERNAL_DETAIL_LEAK"
    assert "rejected_answer" not in correction_context
    assert "no longer than 650 characters" in provider.answer_calls[1]["system"]
    assert "Express priority only by that order" in provider.answer_calls[1]["system"]
    assert "the first sentence must start with those runtime log observations" in provider.answer_calls[1]["system"]
    assert "must not start with configuration or a listing" in provider.answer_calls[1]["system"]
    assert "precise opaque static values are not automatically more relevant" in provider.answer_calls[1]["system"]
    assert "never as separately numbered subjects" in provider.answer_calls[1]["system"]
    assert "never derive a remaining subgroup count" in provider.answer_calls[1]["system"]
    assert "copy every supplied opaque raw entry exactly" in provider.answer_calls[1]["system"]
    assert "copy every supplied raw key=value pair exactly" in provider.answer_calls[1]["system"]
    assert "Never attach a shown sample's level" in provider.answer_calls[1]["system"]
    assert "该查询匹配N条，展示S条样本，剩余R条匹配未展示或未审阅" in provider.answer_calls[1]["system"]
    assert "never mix languages" in provider.answer_calls[1]["system"]
    assert "Never call remaining matches samples" in provider.answer_calls[1]["system"]
    assert "remove every sum or derived match/sample count" in provider.answer_calls[1]["system"]
    assert "final evidence correction editor" in provider.answer_calls[1]["system"]
    assert "independent final answer editor" not in provider.answer_calls[1]["system"]
    encoded_context = json.dumps(review_context, ensure_ascii=False, separators=(",", ":"))
    for forbidden in ("logs.query", "call-logs", "sha256", "query_digest", "filters=", "out_of_memory", "max-players=20"):
        assert forbidden not in encoded_context


async def test_invalid_terminal_revision_fails_closed_without_reopening_tools():
    provider = FakeNativeProvider({
        "content": None,
        "tool_calls": [{
            "id": "call-complete", "type": "function",
            "function": {"name": "route_evidence_complete", "arguments": "{}"},
        }],
    })
    provider.generated_answers = [
        "插件、配置和日志均已核查，原始 out_of_memory 标签为零命中。",
        "插件、配置和日志均已核查，原始 out_of_memory 标签仍为零命中。",
    ]
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    request = payload("汇总插件、配置和日志")
    request["round"] = 4
    request["observations"] = [{
        "tool_call_id": "call-logs", "tool": "logs.query", "status": "succeeded", "side_effect": "none",
        "evidence": {"summaries": ["过去一小时日志没有匹配故障"]},
    }]

    try:
        await graph.decide_agent_loop(request)
        raise AssertionError("invalid terminal revision must fail closed")
    except graph_module.ModelProviderError as error:
        assert error.code == "AGENT_TERMINAL_REVIEW_INVALID"

    assert len(provider.seen_tool_sets) == 1, "terminal validation failure must never reopen application tools"
    assert len(provider.answer_calls) == 2


async def test_listing_transcription_error_gets_one_fact_only_repair_without_reopening_tools():
    provider = FakeNativeProvider({
        "content": None,
        "tool_calls": [{
            "id": "call-complete", "type": "function",
            "function": {"name": "route_evidence_complete", "arguments": "{}"},
        }],
    })
    provider.generated_answers = [
        "plugins清单共2项：Alpha.jar。",
        "plugins清单共2项：Alpha.jar、Beto。",
        "plugins清单共2项：Alpha.jar、Beta。",
    ]
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    request = payload("只读汇总plugins清单")
    request["round"] = 4
    request["observations"] = [{
        "tool_call_id": "call-files", "tool": "files.list", "status": "succeeded", "side_effect": "none",
        "evidence": {"summaries": ["实例目录 plugins： 共 2 项：Alpha.jar、Beta"]},
    }]

    result = await graph.decide_agent_loop(request)

    assert len(provider.seen_tool_sets) == 1, "fact transcription repair must never reopen application tools"
    assert len(provider.answer_calls) == 3
    assert result["decision"]["answer"] == "plugins清单共2项：Alpha.jar、Beta。"
    repair_context = json.loads(provider.answer_calls[2]["messages"][0]["content"])
    assert set(repair_context) == {
        "request", "facts", "constraints", "answer_to_repair", "deterministic_audit_error",
    }
    assert repair_context["deterministic_audit_error"] == "LISTING_ENTRY_OMITTED"
    assert repair_context["answer_to_repair"] == "plugins清单共2项：Alpha.jar、Beto。"
    assert "final exact-fact transcription repair" in provider.answer_calls[2]["system"]
    assert "Never choose or reopen tools" in provider.answer_calls[2]["system"]


async def test_native_final_with_uncovered_evidence_uses_bounded_editor():
    provider = FakeNativeProvider({
        "content": None,
        "tool_calls": [{"id": "call-final", "type": "function", "function": {
            "name": "route_evidence_final",
            "arguments": json.dumps({"answer": "插件和日志已核查。"}),
        }}],
    })
    provider.generated_answers = ["插件和日志已核查；difficulty=easy；最近一小时日志查询零命中。"]
    graph = object.__new__(McaiGraph)
    graph.provider = provider
    request = payload("汇总插件、difficulty 和日志")
    request["round"] = 4
    request["observations"] = [
        {"tool_call_id": "call-files", "tool": "files.list", "status": "succeeded", "side_effect": "none", "evidence": {"summaries": ["插件已读取"]}},
        {"tool_call_id": "call-config", "tool": "config.inspect", "status": "succeeded", "side_effect": "none", "evidence": {"summaries": ["difficulty=easy"]}},
        {"tool_call_id": "call-logs", "tool": "logs.query", "status": "succeeded", "side_effect": "none", "evidence": {"summaries": ["Log query result: matches=0; window_minutes=60; scanned_lines=200; sample_count=0; query_digest=" + "a" * 64]}},
    ]

    result = await graph.decide_agent_loop(request)

    assert result["decision"]["action"] == "final"
    assert "difficulty=easy" in result["decision"]["answer"]
    assert result["decision"]["citations"] == ["call-files", "call-config", "call-logs"]
    assert result["repairUsed"] is True
    assert len(provider.seen_tool_sets) == 1
    assert len(provider.answer_calls) == 1


async def main():
    tests = [
        test_model_receives_complete_catalog_and_owns_tool_selection,
        test_natural_answer_requires_no_tool_call,
        test_concept_explanation_route_never_exposes_console_tool,
        test_explicit_user_prohibitions_are_forwarded_as_hard_native_constraints,
        test_first_turn_semantic_selection_uses_primary_model,
        test_stopped_instance_catalog_excludes_only_state_unavailable_tools,
        test_router_direct_answer_is_reused_without_second_model_call,
        test_uncertain_route_asks_naturally_without_tools,
        test_direct_architecture_answer_may_discuss_registered_function_names,
        test_direct_identity_answer_may_describe_general_tool_capability,
        test_text_cannot_impersonate_a_native_tool_call,
        test_invalid_native_arguments_are_repaired_once_without_planner_rewrite,
        test_multiple_native_calls_are_serialized_in_provider_order,
        test_total_decision_deadline_caps_router_and_answer_chain,
        test_terminal_review_projection_keeps_all_attempts_with_bounded_high_signal_results,
        test_evidence_routing_projection_folds_only_older_recovered_failures,
        test_terminal_answer_projection_keeps_user_facts_and_removes_protocol_details,
        test_evidence_routing_uses_primary_model,
        test_native_provider_falls_back_after_model_specific_http_400,
        test_native_provider_falls_back_after_empty_public_message,
        test_answer_coverage_omission_is_corrected_without_reopening_tools,
        test_invalid_terminal_revision_fails_closed_without_reopening_tools,
        test_listing_transcription_error_gets_one_fact_only_repair_without_reopening_tools,
        test_native_final_with_uncovered_evidence_uses_bounded_editor,
    ]
    for test in tests:
        await test()
        print(f"PASS {test.__name__}")
    print(f"PASS {len(tests)} native autonomous tool tests")


if __name__ == "__main__":
    asyncio.run(main())
