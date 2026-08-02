from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from mcai_graph.graph import (
    MODEL_ANSWER_REQUEST_TIMEOUT_SECONDS,
    MODEL_REQUEST_TIMEOUT_SECONDS,
    McaiGraph,
    ModelProvider,
    ModelProviderError,
    ProviderConfig,
    _decision_schema,
    _deterministic_decision,
    _history,
    _infer_pending_action,
    _max_tokens_for_schema,
    _normalize_decision,
    _provider_content,
    _router_prompt,
    _thread_id,
)


class FakeProvider:
    config = ProviderConfig("test", "http://example.invalid/v1", "test")

    async def structured(self, system, messages, schema):
        if set(schema.get("properties", {})) == {"answer"}:
            return {"answer": "已根据真实任务证据完成。"}
        return {
            "route": "direct",
            "answer": "2",
            "toolIntent": None,
            "preferredTool": None,
            "delegate": None,
            "pendingAction": None,
        }


class FailingProvider(FakeProvider):
    async def structured(self, system, messages, schema):
        raise AssertionError("deterministic completion must not call the model")


class GraphTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "state.sqlite3")

    async def asyncTearDown(self):
        await self.graph.close()
        self.temp.cleanup()

    async def test_affirmative_follow_up_runs_pending_plugin_file_check(self):
        payload = {
            "threadId": "session-1",
            "message": "需要",
            "history": [{
                "role": "assistant",
                "content": "需要重新拉一次文件清单，确认 plugins/ 下是否出现 EssentialsX.jar。要我读一次吗？",
            }],
            "availableTools": ["files.list"],
        }
        decision = await self.graph.route(payload)
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["trace"][0]["result"], "files.list")
        self.assertIn("/plugins", decision["toolIntent"])

    async def test_plugin_claim_is_verified_with_files_tool(self):
        decision = await self.graph.route({
            "threadId": "session-2",
            "message": "你确定 Essentials 安装了吗",
            "history": [],
            "availableTools": ["files.list", "plugin.install"],
        })
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["trace"][0]["result"], "files.list")

    async def test_missing_plugin_evidence_continues_with_files_list(self):
        response = await self.graph.respond({
            "threadId": "session-3",
            "intent": "安装 EssentialsX",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "plugin.install"}]},
            "evidence": [{"kind": "state", "summary": "SUCCEEDED"}],
        })
        self.assertEqual(response["continuation"]["route"], "tool")
        self.assertEqual(response["continuation"]["trace"][0]["result"], "files.list")

    async def test_files_task_without_files_evidence_is_not_reported_as_success(self):
        response = await self.graph.respond({
            "threadId": "session-4",
            "intent": "读取插件目录",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "files.list"}]},
            "evidence": [{"kind": "state", "summary": "SUCCEEDED"}],
        })
        self.assertNotIn("已完成", response["answer"])

    async def test_plugin_file_evidence_reports_missing_plugin_explicitly(self):
        response = await self.graph.respond({
            "threadId": "session-5",
            "intent": "确认 EssentialsX 是否已经安装",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "files.list"}]},
            "evidence": [{"kind": "files", "summary": "实例目录 /plugins：共 1 项：spark"}],
        })
        self.assertIn("未在 /plugins 中发现 EssentialsX", response["answer"])
        self.assertIn("不能确认", response["answer"])

    async def test_plugin_file_evidence_does_not_accept_substring_match(self):
        response = await self.graph.respond({
            "threadId": "session-6",
            "intent": "确认 EssentialsX 是否已经安装",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "files.list"}]},
            "evidence": [{"kind": "files", "summary": "实例目录 /plugins：共 1 项：NotEssentials.jar"}],
        })
        self.assertIn("未在 /plugins 中发现 EssentialsX", response["answer"])

    async def test_lifecycle_success_uses_instance_evidence_without_model(self):
        response = await self.graph.respond({
            "threadId": "session-lifecycle-success",
            "intent": "启动服务器",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "instance.start"}]},
            "evidence": [{"kind": "instance", "summary": "实例已在运行，无需重复启动"}],
        })
        self.assertEqual(response["answer"], "实例已在运行，无需重复启动")

    async def test_lifecycle_failure_reports_real_tool_reason_without_model(self):
        response = await self.graph.respond({
            "threadId": "session-lifecycle-failure",
            "intent": "启动服务器",
            "taskState": "FAILED",
            "plan": {"steps": [{"tool": "instance.start"}]},
            "evidence": [{"kind": "diagnosis", "summary": "工具返回错误：panel returned HTTP 500"}],
        })
        self.assertEqual(response["answer"], "启动实例失败：panel returned HTTP 500")

    async def test_console_completion_uses_real_evidence_without_model(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "console.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-console-success",
                "intent": "在服务器控制台执行 mspt",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "console.command"}]},
                "evidence": [{"kind": "console", "summary": "控制台返回：Server tick times (avg/min/max): 0.1/0.0/0.2"}],
            })
            self.assertIn("Server tick times", response["answer"])
        finally:
            await graph.close()

    async def test_files_completion_uses_real_evidence_without_model(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "files.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-files-success",
                "intent": "列出根目录",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "files.list"}]},
                "evidence": [{"kind": "files", "summary": "实例目录 /：server.jar, plugins"}],
            })
            self.assertEqual(response["answer"], "实例目录 /：server.jar, plugins")
        finally:
            await graph.close()

    async def test_explicit_offline_diagnosis_runs_the_delegate_node(self):
        decision = await self.graph.route({
            "threadId": "session-offline-diagnosis",
            "message": "不读取当前服务器数据，仅根据以下证据诊断故障根因，并给出验证方案与验收标准。",
            "availableTools": ["logs.query", "console.command"],
        })
        self.assertEqual(decision["route"], "delegate")
        self.assertEqual(decision["delegate"], "diagnostics")
        self.assertEqual(decision["answer"], "已根据真实任务证据完成。")

    async def test_delegate_prompts_require_a_concise_complete_result_template(self):
        class CapturingProvider:
            config = ProviderConfig("test", "http://example.invalid/v1", "test")

            def __init__(self):
                self.systems = []

            async def structured(self, system, _messages, _schema):
                self.systems.append(system)
                return {"answer": "模板化回答"}

        provider = CapturingProvider()
        graph = McaiGraph(provider, Path(self.temp.name) / "delegate-template.sqlite3")
        try:
            planner = await graph.route({
                "threadId": "session-template-plan",
                "message": "不读取实时数据，为大型 Paper 服务器制定三阶段性能治理方案，包含风险、回滚和停止条件。",
                "availableTools": ["logs.query"],
            })
            diagnostics = await graph.route({
                "threadId": "session-template-diagnosis",
                "message": "不读取实时数据，仅根据以下证据诊断故障根因，并给出验证方案与验收标准。",
                "availableTools": ["logs.query"],
            })
            self.assertEqual(planner["route"], "delegate")
            self.assertEqual(diagnostics["route"], "delegate")
            self.assertIn("阶段、依赖、风险、验收、回滚、停止条件", provider.systems[0])
            self.assertIn("已知事实、推断、验证、风险、验收", provider.systems[1])
        finally:
            await graph.close()

    async def test_failed_delegate_is_reported_as_unavailable_not_as_a_successful_delegate(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "delegate-failure.sqlite3")
        try:
            decision = await graph.route({
                "threadId": "session-offline-delegate-failure",
                "message": "不读取当前服务器数据，仅根据以下证据诊断故障根因。",
                "availableTools": ["logs.query", "console.command"],
            })
            self.assertEqual(decision["route"], "direct")
            self.assertEqual(decision["providerStatus"], "unavailable")
            self.assertEqual(decision["providerError"], "INTERNAL_ERROR")
        finally:
            await graph.close()

    async def test_model_completion_failure_preserves_an_unavailable_status(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "completion-failure.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-completion-failure",
                "intent": "解释一个自定义任务结果",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "custom.operation"}]},
                "evidence": [],
            })
            self.assertEqual(response["status"], "unavailable")
            self.assertEqual(response["providerStatus"], "unavailable")
            self.assertEqual(response["providerError"], "INTERNAL_ERROR")
        finally:
            await graph.close()


class RoutingTests(unittest.TestCase):
    def test_router_prompt_requires_uncertain_facts_to_remain_explicit(self):
        prompt = _router_prompt({"instance": {}, "availableTools": []})
        self.assertIn("不得编造项目名、版本号、性能指标或工具能力", prompt)

    def test_anonymous_requests_do_not_share_checkpoint_state(self):
        first = _thread_id({"instance": {"id": "same-instance"}})
        second = _thread_id({"instance": {"id": "same-instance"}})
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("anonymous:"))

    def test_request_id_is_a_stable_thread_fallback(self):
        self.assertEqual(_thread_id({"request_id": "request-42"}), "request-42")

    def test_plugin_install_routes_to_controlled_tool(self):
        decision = _deterministic_decision("帮我安装 EssentialsX", [], {"plugin.install"})
        self.assertEqual(decision["trace"][0]["result"], "plugin.install")

    def test_server_install_routes_without_model(self):
        cases = (
            ("安装 Paper 1.21.4 服务端", "server.install"),
            ("下载 Fabric 1.20.1 并开服", "server.install"),
        )
        for message, expected_tool in cases:
            with self.subTest(message=message):
                decision = _deterministic_decision(message, [], {expected_tool})
                self.assertEqual(decision["preferredTool"], expected_tool)

    def test_config_patch_routes_without_model(self):
        decision = _deterministic_decision("把服务器 view-distance 修改为 8", [], {"config.patch"})
        self.assertEqual(decision["preferredTool"], "config.patch")

    def test_plugin_resolve_routes_without_installing(self):
        decision = _deterministic_decision("解析 EssentialsX 兼容版本和制品，但不要安装", [], {"plugin.resolve"})
        self.assertEqual(decision["preferredTool"], "plugin.resolve")

    def test_restart_routes_to_controlled_tool_without_model(self):
        decision = _deterministic_decision("重启实例", [], {"instance.restart"})
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["preferredTool"], "instance.restart")
        self.assertEqual(decision["answer"], "已生成重启计划，等待确认。")

    def test_instance_lifecycle_commands_target_current_instance(self):
        cases = (
            ("启动服务器", "instance.start"),
            ("停止当前实例", "instance.stop"),
            ("请重启一下", "instance.restart"),
        )
        for message, expected_tool in cases:
            with self.subTest(message=message):
                decision = _deterministic_decision(message, [], {expected_tool})
                self.assertEqual(decision["preferredTool"], expected_tool)

    def test_pending_restart_is_recovered_from_history(self):
        pending = _infer_pending_action(
            [{"role": "assistant", "content": "插件加载需要重启，是否继续重启？"}],
            {"instance.restart"},
        )
        self.assertEqual(pending["tool"], "instance.restart")

    def test_explicit_offline_diagnosis_delegates_without_model_routing(self):
        decision = _deterministic_decision(
            "不读取当前服务器数据，仅根据以下证据诊断故障根因，并给出验证方案与验收标准。",
            [],
            {"logs.query", "console.command"},
        )
        self.assertEqual(decision["route"], "delegate")
        self.assertEqual(decision["delegate"], "diagnostics")

    def test_explicit_offline_plan_delegates_without_model_routing(self):
        decision = _deterministic_decision(
            "不读取实时数据，为大型 Paper 服务器制定三阶段性能治理方案，包含风险、回滚和停止条件。",
            [],
            {"logs.query", "console.command"},
        )
        self.assertEqual(decision["route"], "delegate")
        self.assertEqual(decision["delegate"], "planner")

    def test_current_log_diagnosis_remains_a_controlled_tool_request(self):
        decision = _deterministic_decision(
            "读取当前实例最近一小时日志，结合错误与异常行诊断最可能故障原因。",
            [],
            {"logs.query", "console.command"},
        )
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["preferredTool"], "logs.query")

    def test_explicit_operation_is_not_swallowed_by_offline_delegate_keywords(self):
        decision = _deterministic_decision(
            "离线安装方案：下载 Paper 1.21.1 服务端。",
            [],
            {"server.install"},
        )
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["preferredTool"], "server.install")


class ModelAdapterTests(unittest.IsolatedAsyncioTestCase):
    def test_output_budgets_keep_routing_and_answers_concise(self):
        answer_schema = {"required": ["answer"]}
        self.assertEqual(_max_tokens_for_schema(answer_schema), 256)
        self.assertEqual(_max_tokens_for_schema(_decision_schema()), 384)
        self.assertGreater(MODEL_ANSWER_REQUEST_TIMEOUT_SECONDS, MODEL_REQUEST_TIMEOUT_SECONDS)

    async def test_plain_model_text_is_a_safe_direct_answer(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        modes = []

        async def request(_model, _system, _messages, _schema, mode):
            modes.append(mode)
            return "2" if mode == "json_schema" else '{"answer":"2"}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "1+1"}], _decision_schema())
        self.assertEqual(decision["route"], "direct")
        self.assertEqual(decision["answer"], "2")
        self.assertEqual(modes, ["json_schema"])

    async def test_truncated_routing_json_recovers_the_public_answer_only(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            return '{"route":"direct","answer":"Paper uses plugins\\nFabric uses a mod loader'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "compare"}], _decision_schema())
        self.assertEqual(decision["route"], "direct")
        self.assertFalse(decision["answer"].startswith("{"))
        self.assertIn("Paper uses plugins", decision["answer"])
        self.assertIn("Fabric uses a mod loader", decision["answer"])

    async def test_truncated_double_wrapped_json_recovers_the_nested_answer(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            return '{"answer":"{\\"route\\":\\"direct\\",\\"answer\\":\\"Paper uses plugins'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "compare"}], _decision_schema())
        self.assertEqual(decision["route"], "direct")
        self.assertEqual(decision["answer"], "Paper uses plugins")

    async def test_content_compatibility_field_is_not_lost(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            return '{"content":"Paper 更适合插件生态，Fabric 更适合模组。"}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "Paper 和 Fabric 的区别"}], _decision_schema())
        self.assertEqual(decision["route"], "direct")
        self.assertIn("Paper", decision["answer"])

    async def test_nested_content_compatibility_field_is_not_lost(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            return '{"content":{"text":"Paper is a server implementation; Fabric is a mod loader."}}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "compare"}], _decision_schema())
        self.assertEqual(decision["route"], "direct")
        self.assertIn("Fabric", decision["answer"])

    async def test_provider_authentication_failure_is_reported(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            raise RuntimeError("provider HTTP 401")

        provider._request = request  # type: ignore[method-assign]
        with self.assertRaises(ModelProviderError) as caught:
            await provider.structured("route", [{"role": "user", "content": "hello"}], _decision_schema())
        self.assertEqual(caught.exception.code, "AUTHENTICATION")

    async def test_request_timeout_moves_to_the_configured_fallback_model(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", ("fallback",)))
        seen = []

        async def request(model, _system, _messages, _schema, _mode):
            seen.append(model)
            if model == "primary":
                raise TimeoutError()
            return '{"route":"direct","answer":"fallback answered","toolIntent":null,"preferredTool":null,"delegate":null,"pendingAction":null}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "hello"}], _decision_schema())
        self.assertEqual(seen, ["primary", "fallback"])
        self.assertEqual(decision["answer"], "fallback answered")
        self.assertEqual(decision["providerModel"], "fallback")

    async def test_response_format_failure_uses_the_next_compatible_mode(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        modes = []

        async def request(_model, _system, _messages, _schema, mode):
            modes.append(mode)
            if mode == "json_schema":
                raise RuntimeError("provider HTTP 400: response_format is unsupported")
            return '{"content":"compatible answer"}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("route", [{"role": "user", "content": "hello"}], _decision_schema())
        self.assertEqual(modes, ["json_schema", "json_object"])
        self.assertEqual(decision["answer"], "compatible answer")

    async def test_answer_only_schema_prefers_the_compatibility_prompt_mode(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        modes = []
        answer_schema = {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }

        async def request(_model, _system, _messages, _schema, mode):
            modes.append(mode)
            return "concise answer"

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("answer", [{"role": "user", "content": "hello"}], answer_schema)
        self.assertEqual(modes, ["prompt"])
        self.assertEqual(decision["answer"], "concise answer")

    async def test_answer_only_empty_primary_moves_directly_to_fallback(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", ("fallback",)))
        seen = []
        answer_schema = {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }

        async def request(model, _system, _messages, _schema, mode):
            seen.append((model, mode))
            return "" if model == "primary" else "fallback answer"

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("answer", [{"role": "user", "content": "hello"}], answer_schema)
        self.assertEqual(seen, [("primary", "prompt"), ("fallback", "prompt")])
        self.assertEqual(decision["answer"], "fallback answer")

    async def test_answer_only_structured_sections_are_preserved(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        answer_schema = {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }

        async def request(_model, _system, _messages, _schema, _mode):
            return '{"facts":"MSPT is elevated","verification":"sample GC pauses"}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("answer", [{"role": "user", "content": "diagnose"}], answer_schema)
        self.assertIn("事实", decision["answer"])
        self.assertIn("验证", decision["answer"])

    async def test_answer_only_double_wrapped_json_is_unwrapped_for_the_ui(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        answer_schema = {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }

        async def request(_model, _system, _messages, _schema, _mode):
            return '{"answer":"{\\"answer\\":\\"clean answer\\"}"}'

        provider._request = request  # type: ignore[method-assign]
        decision = await provider.structured("answer", [{"role": "user", "content": "hello"}], answer_schema)
        self.assertEqual(decision["answer"], "clean answer")

    def test_provider_content_handles_compatible_envelopes_without_reasoning(self):
        self.assertEqual(
            _provider_content({"choices": [{"message": {"content": {"content": "compatible"}}}]}),
            "compatible",
        )
        self.assertEqual(_provider_content({"answer": "top-level compatible"}), "top-level compatible")
        self.assertEqual(_provider_content({"choices": [{"message": {"reasoning_content": "private"}}]}), "")

    def test_history_is_bounded_but_keeps_recent_context(self):
        history = [{"role": "assistant", "content": "a" * 8_000}, {"role": "user", "content": "recent context"}]
        messages = _history({"history": history, "message": "current request"})
        self.assertLessEqual(sum(len(message["content"]) for message in messages[:-1]), 6_000)
        self.assertEqual(messages[-2]["content"], "recent context")
        self.assertEqual(messages[-1]["content"], "current request")

    async def test_empty_content_is_not_treated_as_a_model_answer(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            return ""

        provider._request = request  # type: ignore[method-assign]
        with self.assertRaises(ModelProviderError) as caught:
            await provider.structured("route", [{"role": "user", "content": "hello"}], _decision_schema())
        self.assertEqual(caught.exception.code, "EMPTY_RESPONSE")

    async def test_provider_total_timeout_is_reported_before_graph_timeout(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))

        async def request(_model, _system, _messages, _schema, _mode):
            await asyncio.sleep(0.1)
            return "late answer"

        provider._request = request  # type: ignore[method-assign]
        with self.assertRaises(ModelProviderError) as caught:
            await provider.structured("route", [{"role": "user", "content": "hello"}], _decision_schema(), timeout_seconds=0.01)
        self.assertEqual(caught.exception.code, "TIMEOUT")

    async def test_probe_rejects_an_answer_that_does_not_echo_the_readiness_nonce(self):
        class NonceIgnoringProvider:
            config = ProviderConfig("test", "http://example.invalid/v1", "primary")

            async def structured(self, *_args, **_kwargs):
                return {"answer": "ready", "providerModel": "primary"}

        graph = McaiGraph(NonceIgnoringProvider(), Path(tempfile.mkdtemp()) / "probe.sqlite")
        with self.assertRaises(ModelProviderError) as caught:
            await graph.probe()
        self.assertEqual(caught.exception.code, "INVALID_RESPONSE")

    async def test_route_timeout_is_not_reported_as_an_internal_error(self):
        class TimeoutProvider:
            async def structured(self, *_args, **_kwargs):
                raise TimeoutError()

        graph = McaiGraph(TimeoutProvider(), Path(tempfile.mkdtemp()) / "timeout.sqlite")
        result = await graph._model_route({"request": {"message": "compare Paper and Fabric", "availableTools": []}})
        self.assertEqual(result["decision"]["providerError"], "TIMEOUT")
        self.assertEqual(result["decision"]["providerStatus"], "unavailable")

    def test_disallowed_model_tool_is_downgraded_without_execution(self):
        decision = _normalize_decision({
            "route": "tool",
            "answer": "正在执行",
            "toolIntent": "停止实例",
            "preferredTool": "instance.stop",
        }, set())
        self.assertEqual(decision["route"], "direct")
        self.assertIn("未执行", decision["answer"])


if __name__ == "__main__":
    unittest.main()
