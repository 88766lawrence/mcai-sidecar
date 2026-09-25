from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mcai_graph.graph import (
    INTENT_CANDIDATE_OUTPUT_MAX_CHARS,
    INTENT_COMPILER_PROMPT_MAX_CHARS,
    ProviderCapabilityProfile,
    MODEL_ANSWER_REQUEST_TIMEOUT_SECONDS,
    MODEL_REQUEST_TIMEOUT_SECONDS,
    McaiGraph,
    ModelProvider,
    ModelProviderError,
    ProviderConfig,
    _decision_schema,
    _deterministic_decision,
    _history,
    _has_invalid_tps_claim,
    _infer_pending_action,
    _intent_ir_schema,
    _intent_candidate_schema,
    _intent_semantic_frame_schema,
    _confirmed_write_proposal_schema,
    _max_tokens_for_schema,
    _normalize_decision,
    _provider_content,
    _strict_json_object,
    _validate_agent_loop_decision,
    _unique_json_object,
    _planner_prompt,
    _paper_fabric_comparison_answer,
    _enforce_log_time_scope,
    _readonly_health_skill_intent,
    _router_prompt,
    _should_plan_request,
    _thread_id,
    _unavailable_instance_action_answer,
)


class LogWindowScopeTests(unittest.TestCase):
    def test_unverified_wall_clock_scope_is_visible_in_final_answer(self):
        decision = {"action": "final", "answer": "日志匹配 8 条错误或警告。", "citations": ["call-log"]}
        observations = [{"tool": "logs.query", "status": "succeeded", "tool_call_id": "call-log",
                         "evidence": {"summaries": ["Log query result: matches=8; window_minutes=60\n"
                            "Time window is relative to the latest timestamp in the available log; "
                            "absolute wall-clock recency is unverified."]}}]
        result = _enforce_log_time_scope(decision, observations)
        self.assertIn("无法确认对应绝对最近一小时", result["answer"])
        self.assertEqual(result["citations"], ["call-log"])

SOURCE_CATALOG = {
    "schema_version": "intent-source-catalog/v1",
    "source_digest": "a" * 64,
    "digest": "b" * 64,
    "refs": [{"id": "src-0001", "source_start": 0, "source_end": 13, "text": "Inspect build", "order": 0}],
}

FRAME_PLAN = {
    "schema_version": "intent-semantic-frame-plan/v1", "complexity": "simple",
    "total_deadline_ms": 28000, "max_concurrency": 3, "max_provider_calls": 4,
    "shards": [{"id": "frame-shard-01", "assigned_source_refs": ["src-0001"],
        "context_source_refs": ["src-0001"], "estimated_output_chars": 1100, "max_output_tokens": 275}],
}


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
        # Windows can release SQLite sidecar files a few milliseconds after
        # the async connection closes. Test assertions must not become flaky
        # because rmtree races that delayed handle release.
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "state.sqlite3")

    async def asyncTearDown(self):
        await self.graph.close()
        self.temp.cleanup()

    def test_stopped_instance_does_not_substitute_lifecycle_or_plugin_tools(self):
        instance = {"name": "测试", "state": "stopped"}
        restart = _unavailable_instance_action_answer("重启这个测试实例", instance)
        self.assertIn("无法执行重启", restart)
        self.assertIn("没有替换为启动", restart)
        inventory = _unavailable_instance_action_answer("查看服务器插件有哪些", instance)
        self.assertIn("无法从控制台查询已加载的插件", inventory)
        self.assertIsNone(_unavailable_instance_action_answer("查看插件目录里有哪些文件", instance))
        self.assertIsNone(_unavailable_instance_action_answer("不要重启，查看日志", instance))

    def test_paper_fabric_comparison_keeps_client_requirement_conditional(self):
        answer = _paper_fabric_comparison_answer("Paper 和 Fabric 有什么区别？")
        self.assertIn("原版客户端", answer)
        self.assertIn("取决于具体模组", answer)
        self.assertIn("纯服务端模组可以不要求", answer)
        self.assertIsNone(_paper_fabric_comparison_answer("安装 Paper 1.21.1"))

    def test_direct_answers_reject_internal_reasoning_and_instance_identifiers(self):
        examples = (
            ("用户问的是 Paper 和 Fabric 的区别，不需要任何外部工具调用。\nPaper 支持插件。", "$.answer:INTERNAL_REASONING_LEAK"),
            ("当前选中的实例是测试。来源：运行时上下文 `instance.name`。", "$.answer:INTERNAL_DETAIL_LEAK"),
            ("实例测试（id: aabbccddeeff00112233445566778899）已停止。", "$.answer:INTERNAL_DETAIL_LEAK"),
            ("当前实例的 state 为 `stopped`。", "$.answer:INTERNAL_DETAIL_LEAK"),
        )
        for answer, expected in examples:
            with self.subTest(answer=answer):
                decision = {"action": "final", "answer": answer, "citations": []}
                self.assertEqual(_validate_agent_loop_decision(decision, [], [], {"maxToolCalls": 19}), expected)

    def test_web_search_final_allows_only_observed_source_urls(self):
        source = "https://docs.papermc.io/paper/getting-started/"
        web = {
            "tool_call_id": "call-web", "tool": "web.search", "status": "succeeded",
            "data": {"qa0144_read_result": {
                "output_schema_id": "web-search-result/v1",
                "value": {"schema_version": "web-search-result/v1", "results": [{"url": source}]},
            }},
        }
        config = {"tool_call_id": "call-config", "tool": "config.inspect", "status": "succeeded"}
        observations = [web, config]
        decision = {"action": "final", "answer": f"Paper 官方文档：{source}", "citations": ["call-web", "call-config"]}
        self.assertIsNone(_validate_agent_loop_decision(decision, [], observations, {"maxToolCalls": 19}))
        self.assertEqual(_validate_agent_loop_decision(
            {**decision, "answer": "Paper 文档：https://example.invalid/claim"}, [], observations, {"maxToolCalls": 19},
        ), "$.answer:UNSUPPORTED_SOURCE_URL")
        self.assertEqual(_validate_agent_loop_decision(
            {**decision, "citations": ["call-config"]}, [], [config], {"maxToolCalls": 19},
        ), "$.answer:UNSUPPORTED_SOURCE_URL")

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

    async def test_native_terminal_coverage_is_repaired_without_reopening_tools(self):
        from test_native_autonomous_tools import test_answer_coverage_omission_is_corrected_without_reopening_tools

        await test_answer_coverage_omission_is_corrected_without_reopening_tools()

    async def test_native_invalid_terminal_revision_fails_closed(self):
        from test_native_autonomous_tools import test_invalid_terminal_revision_fails_closed_without_reopening_tools

        await test_invalid_terminal_revision_fails_closed_without_reopening_tools()

    async def test_native_listing_transcription_is_repaired_without_reopening_tools(self):
        from test_native_autonomous_tools import test_listing_transcription_error_gets_one_fact_only_repair_without_reopening_tools

        await test_listing_transcription_error_gets_one_fact_only_repair_without_reopening_tools()

    async def test_native_direct_final_repairs_uncovered_evidence(self):
        from test_native_autonomous_tools import test_native_final_with_uncovered_evidence_uses_bounded_editor

        await test_native_final_with_uncovered_evidence_uses_bounded_editor()

    async def test_plugin_installation_check_uses_plugins_directory(self):
        from test_native_autonomous_tools import test_named_plugin_check_repairs_root_listing_to_plugins_directory

        await test_named_plugin_check_repairs_root_listing_to_plugins_directory()

    async def test_bound_instance_metadata_does_not_leak_internal_ids(self):
        from test_native_autonomous_tools import test_bound_instance_metadata_answers_without_model_or_internal_ids

        await test_bound_instance_metadata_answers_without_model_or_internal_ids()

    def test_agent_loop_unique_json_extractor_accepts_one_object_and_rejects_multiple(self):
        self.assertEqual(_unique_json_object('short preface {"action":"cannot_proceed","answer":"Need a target"}'), {"action": "cannot_proceed", "answer": "Need a target"})
        with self.assertRaises(ValueError):
            _unique_json_object('{"action":"final"} {"action":"final"}')

    async def test_typed_intent_compiler_uses_bounded_semantic_frame_and_registered_capabilities(self):
        class CompilerProvider(FakeProvider):
            def __init__(self):
                self.calls = []

            async def compact_json(self, system, messages, schema, budget):
                self.calls.append((system, messages, schema, budget))
                return {
                    "schema_version": "intent-semantic-frame/v1", "assigned_source_refs": ["src-0001"],
                    "frames": [{"owner_source_ref": "src-0001", "roles": [{"role": "discourse", "polarity": "neutral", "status": "mapped", "reason": "context", "goals": [], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}]}],
                    "providerModel": "compiler-fixture", "compilerMetrics": {"mode": "json_only"},
                }

        compiler = CompilerProvider()
        graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "typed-compiler.sqlite3", compiler)
        try:
            result = await graph.compile_intent({
                "sourceCatalog": SOURCE_CATALOG, "framePlan": FRAME_PLAN, "attempt": 1,
                "capabilities": [{"id": "server.version", "domain": "server", "resultKinds": ["fact"]}],
            })
            self.assertEqual(result["semanticFrames"][0]["schema_version"], "intent-semantic-frame/v1")
            self.assertEqual(len(compiler.calls), 1)
            self.assertIn("bounded semantic-frame", compiler.calls[0][0])
            self.assertIn("src-0001", compiler.calls[0][1][0]["content"])
            self.assertEqual(set(compiler.calls[0][2]["required"]), {"schema_version", "assigned_source_refs", "frames"})
            self.assertLess(len(compiler.calls[0][1][0]["content"]), INTENT_COMPILER_PROMPT_MAX_CHARS)
            schema_text = str(compiler.calls[0][2])
            for forbidden in ("quote", "occurrence", "source_start", "source_end", "digest", "approval", "steps", "terminal_state"):
                self.assertNotIn(forbidden, schema_text)
        finally:
            await graph.close()

    async def test_confirmed_write_proposal_uses_small_schema_and_one_provider_call(self):
        class ProposalProvider(FakeProvider):
            def __init__(self): self.calls = []
            async def compact_json(self, system, messages, schema, budget):
                self.calls.append((system, messages, schema, budget))
                return {"schema_version": "confirmed-write-proposal/v1", "decision": "propose", "tool": "console.command", "parameters": {"command": "weather clear"}, "summary": "pending confirmation", "providerModel": "fixture", "compilerMetrics": {"mode": "json_only", "schema_chars": len(str(schema))}}

        provider = ProposalProvider()
        graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "proposal.sqlite3", provider)
        try:
            result = await graph.propose_confirmed_write({"intent": "make the weather clear", "allowedTools": ["console.command"], "instanceContext": {"name": "Realm"}})
            self.assertEqual(result["proposal"]["parameters"]["command"], "weather clear")
            self.assertEqual(result["proposalMetrics"]["terminal_code"], "WRITE_PROPOSAL_OK")
            self.assertEqual(len(provider.calls), 1)
            schema = provider.calls[0][2]
            self.assertIn("oneOf", schema)
            self.assertNotIn("target", str(schema))
            self.assertNotIn("sourceCatalog", provider.calls[0][1][0]["content"])
            for forbidden in ("risk", "approval", "digest", "steps", "evidence", "terminal"):
                self.assertNotIn(forbidden, str(schema).lower())
        finally:
            await graph.close()

    async def test_confirmed_write_timeout_does_not_repair_and_parse_failure_repairs_once(self):
        class TimeoutProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, *_args, **_kwargs):
                self.calls += 1
                raise ModelProviderError("INTENT_COMPILER_PROVIDER_TIMEOUT", [], {"mode": "json_only"})
        timeout_provider = TimeoutProvider()
        timeout_graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "proposal-timeout.sqlite3", timeout_provider)
        try:
            with self.assertRaises(ModelProviderError) as caught:
                await timeout_graph.propose_confirmed_write({"intent": "set daylight", "allowedTools": ["console.command"]})
            self.assertEqual(caught.exception.code, "WRITE_PROPOSAL_PROVIDER_TIMEOUT")
            self.assertEqual(caught.exception.metrics["terminal_code"], "WRITE_PROPOSAL_PROVIDER_TIMEOUT")
            self.assertEqual(timeout_provider.calls, 1)
        finally:
            await timeout_graph.close()

        class RepairProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, *_args, **_kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise ModelProviderError("INTENT_COMPILER_PARSE_ERROR", [], {"mode": "json_only"})
                return {"schema_version": "confirmed-write-proposal/v1", "decision": "clarify", "summary": "Which time?", "providerModel": "fixture", "compilerMetrics": {"mode": "json_only"}}
        repair_provider = RepairProvider()
        repair_graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "proposal-repair.sqlite3", repair_provider)
        try:
            result = await repair_graph.propose_confirmed_write({"intent": "adjust time", "allowedTools": ["console.command"]})
            self.assertEqual(result["proposal"]["decision"], "clarify")
            self.assertTrue(result["repairUsed"])
            self.assertEqual(result["proposalMetrics"]["terminal_code"], "WRITE_PROPOSAL_OK")
            self.assertEqual(repair_provider.calls, 2)
        finally:
            await repair_graph.close()

    def test_confirmed_write_schema_is_materially_smaller_than_semantic_frame_schema(self):
        import json
        proposal = len(json.dumps(_confirmed_write_proposal_schema(["console.command"]), separators=(",", ":")))
        semantic = len(json.dumps(_intent_semantic_frame_schema(["src-0001"]), separators=(",", ":")))
        self.assertLess(proposal, semantic // 3)

    async def test_semantic_frame_compiler_runs_three_initial_shards_concurrently(self):
        class RepairProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, _system, messages, _schema, budget):
                self.calls += 1
                await asyncio.sleep(0.03)
                payload = __import__("json").loads(messages[0]["content"])
                refs = payload["assignedSourceRefs"]
                roles = [{"role": "discourse", "polarity": "neutral", "status": "mapped", "reason": "context", "goals": [], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}]
                return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": refs, "frames": [{"owner_source_ref": ref, "roles": roles} for ref in refs], "providerModel": "fixture", "compilerMetrics": {"mode": "json_only", "provider_ms": 30, "shard_id": budget["shard_id"]}}

        compiler = RepairProvider()
        graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "typed-repair.sqlite3", compiler)
        try:
            catalog = {**SOURCE_CATALOG, "refs": [{"id": f"src-{index:04d}", "source_start": index, "source_end": index + 1, "text": "x", "order": index - 1} for index in range(1, 7)]}
            shards = [{"id": f"frame-shard-{index:02d}", "assigned_source_refs": [f"src-{2*index-1:04d}", f"src-{2*index:04d}"], "context_source_refs": [f"src-{item:04d}" for item in range(1, 7)], "estimated_output_chars": 2200, "max_output_tokens": 550} for index in range(1, 4)]
            started = asyncio.get_running_loop().time()
            result = await graph.compile_intent({"sourceCatalog": catalog, "attempt": 1, "capabilities": [], "framePlan": {**FRAME_PLAN, "complexity": "complex", "shards": shards}})
            self.assertEqual(compiler.calls, 3)
            self.assertLess(asyncio.get_running_loop().time() - started, 0.08)
            self.assertEqual(result["compilerMetrics"]["provider_call_count"], 3)
        finally:
            await graph.close()

    def test_semantic_frame_wire_schema_is_smaller_than_monolithic_candidate(self):
        frame_size = len(__import__("json").dumps(_intent_semantic_frame_schema(["src-0001"]), separators=(",", ":")))
        candidate_size = len(__import__("json").dumps(_intent_candidate_schema(), separators=(",", ":")))
        self.assertLess(frame_size, candidate_size)

    async def test_plugin_claim_is_verified_with_files_tool(self):
        decision = await self.graph.route({
            "threadId": "session-2",
            "message": "你确定 Essentials 安装了吗",
            "history": [],
            "availableTools": ["files.list", "plugin.install"],
        })
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["trace"][0]["result"], "files.list")

    async def test_short_health_goal_uses_planner_model_before_executor_model(self):
        class PlannerProvider(FakeProvider):
            def __init__(self):
                self.calls = 0

            async def structured(self, system, messages, schema):
                self.calls += 1
                self.assertions = (system, messages, schema)
                return {
                    "plannedMessage": "对当前实例完成只读健康检查：执行 version、plugins，读取最近日志并等待真实回调后总结。",
                    "summary": "补全版本、插件和日志三项只读检查",
                }

        class ExecutorProvider(FakeProvider):
            def __init__(self):
                self.calls = 0

            async def structured(self, system, messages, schema):
                self.calls += 1
                return {
                    "route": "tool",
                    "answer": "正在执行只读健康检查。",
                    "toolIntent": messages[-1]["content"],
                    "preferredTool": "logs.query",
                    "delegate": None,
                    "pendingAction": None,
                }

        planner = PlannerProvider()
        executor = ExecutorProvider()
        graph = McaiGraph(executor, Path(self.temp.name) / "two-model.sqlite3", planner)
        try:
            decision = await graph.route({
                "threadId": "session-two-model-health",
                "message": "看看服务器有没有问题",
                "history": [],
                "availableTools": ["console.command", "logs.query"],
            })
            self.assertEqual(planner.calls, 1)
            self.assertEqual(executor.calls, 1)
            self.assertEqual(decision["route"], "tool")
            self.assertIn("version", decision["toolIntent"])
            self.assertEqual(decision["trace"][0]["stage"], "planning")
            self.assertEqual(decision["trace"][1]["result"], "logs.query")
        finally:
            await graph.close()

    async def test_complex_deterministic_install_is_refined_without_losing_its_tool(self):
        class RefinerProvider(FakeProvider):
            def __init__(self):
                self.calls = 0

            async def structured(self, _system, _messages, _schema):
                self.calls += 1
                return {
                    "plannedMessage": (
                        "在当前实例安装 EssentialsX：先根据 Paper 与 Minecraft 版本解析兼容制品，"
                        "执行受控安装，等待真实回调，再读取 /plugins 验证 JAR；未经批准不得重启。"
                    ),
                    "summary": "已补全兼容解析、安装验证和禁止自动重启边界",
                }

        refiner = RefinerProvider()
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "refined-install.sqlite3", refiner)
        try:
            decision = await graph.route({
                "threadId": "session-refined-install",
                "message": "帮我安装 EssentialsX",
                "history": [],
                "availableTools": ["plugin.install", "files.list", "instance.restart"],
            })
            self.assertEqual(refiner.calls, 1)
            self.assertEqual(decision["route"], "tool")
            self.assertEqual(decision["preferredTool"], "plugin.install")
            self.assertIn("/plugins", decision["toolIntent"])
            self.assertIn("未经批准不得重启", decision["toolIntent"])
            self.assertEqual(decision["trace"][0]["stage"], "planning")
        finally:
            await graph.close()

    async def test_simple_plugin_inventory_bypasses_the_refiner(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "simple-tool.sqlite3", FailingProvider())
        try:
            decision = await graph.route({
                "threadId": "session-simple-plugin-list",
                "message": "查看服务器插件有哪些",
                "history": [],
                "availableTools": ["console.command", "files.list"],
            })
            self.assertEqual(decision["route"], "tool")
            self.assertEqual(decision["preferredTool"], "console.command")
            self.assertEqual(decision["trace"][0]["result"], "console.command")
            self.assertFalse(any(item.get("stage") == "planning" for item in decision["trace"]))
        finally:
            await graph.close()

    async def test_nontrivial_knowledge_answer_is_refined_before_execution(self):
        class RefinerProvider(FakeProvider):
            def __init__(self):
                self.calls = 0

            async def structured(self, _system, _messages, _schema):
                self.calls += 1
                return {
                    "plannedMessage": "比较 Paper 与 Fabric 的定位、生态和适用场景；只用通用知识，不读取实例数据。",
                    "summary": "已补全比较维度和只使用通用知识的边界",
                }

        refiner = RefinerProvider()
        graph = McaiGraph(FakeProvider(), Path(self.temp.name) / "refined-knowledge.sqlite3", refiner)
        try:
            decision = await graph.route({
                "threadId": "session-refined-knowledge",
                "message": "Paper 和 Fabric 有什么区别？",
                "history": [],
                "availableTools": ["console.command", "logs.query"],
            })
            self.assertEqual(refiner.calls, 1)
            self.assertEqual(decision["route"], "direct")
            self.assertEqual(decision["trace"][0]["stage"], "planning")
        finally:
            await graph.close()

    async def test_natural_plugin_inventory_query_uses_console(self):
        decision = await self.graph.route({
            "threadId": "session-plugin-inventory",
            "message": "查看服务器插件有哪些",
            "history": [],
            "availableTools": ["console.command", "files.list"],
        })
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["trace"][0]["result"], "console.command")
        self.assertIn("plugins", decision["toolIntent"])

    async def test_explicit_plugin_directory_correction_uses_files_list(self):
        decision = await self.graph.route({
            "threadId": "session-plugin-directory",
            "message": "我说插件目录",
            "history": [],
            "availableTools": ["console.command", "files.list"],
        })
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["trace"][0]["result"], "files.list")
        self.assertIn("/plugins", decision["toolIntent"])

    async def test_wrong_root_directory_evidence_continues_to_plugins(self):
        response = await self.graph.respond({
            "threadId": "session-wrong-plugin-directory",
            "intent": "查看服务器插件有哪些\n\nAgent operation: 列出目录文件",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "files.list"}]},
            "evidence": [{"kind": "files", "summary": "实例目录 /：共 2 项：plugins、server.jar"}],
        })
        self.assertIn("不是插件目录", response["answer"])
        self.assertEqual(response["continuation"]["trace"][0]["result"], "files.list")
        self.assertIn("/plugins", response["continuation"]["toolIntent"])

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

    async def test_plugin_install_success_uses_only_real_file_evidence(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "plugin-install-success.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-plugin-install-success",
                "intent": "安装 LuckPerms，不要重启服务器",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "plugin.resolve"}, {"tool": "plugin.install"}]},
                "evidence": [
                    {"kind": "plugin", "summary": "已解析 Modrinth 插件 luckperms v5.5.53-bukkit；来源 SHA-512 已验证"},
                    {"kind": "files", "summary": "插件已落盘到 /plugins/LuckPerms-Bukkit-5.5.53.jar（SHA-256：" + "a" * 64 + "）"},
                ],
            })
            self.assertIn("/plugins/LuckPerms-Bukkit-5.5.53.jar", response["answer"])
            self.assertIn("v5.5.53-bukkit", response["answer"])
            self.assertIn("本次计划未执行重启", response["answer"])
            self.assertNotIn("触发", response["answer"])
        finally:
            await graph.close()

    async def test_explicit_post_install_restart_becomes_a_separate_confirmed_task(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "plugin-restart-continuation.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-plugin-restart-continuation",
                "intent": "安装 BlueMap，安装完成后重启服务器",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "plugin.resolve"}, {"tool": "plugin.install"}, {"tool": "files.list", "purpose": "verify"}]},
                "evidence": [
                    {"kind": "plugin", "summary": "已解析插件 BlueMap 5.5"},
                    {"kind": "files", "summary": "插件已落盘到 /plugins/BlueMap.jar（SHA-256：" + "b" * 64 + "）"},
                    {"kind": "verification.files", "summary": "实例目录 /plugins：BlueMap.jar"},
                ],
            })
            self.assertEqual(response["continuation"]["preferredTool"], "instance.restart")
            self.assertIn("独立高风险任务", response["answer"])
            self.assertNotIn("instance.restart", [step["tool"] for step in response.get("plan", {}).get("steps", [])])
        finally:
            await graph.close()

    async def test_plugin_install_failure_reports_resolver_error_without_inventing_restart(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "plugin-install-failure.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-plugin-install-failure",
                "intent": "安装 EssentialsX，不要重启服务器",
                "taskState": "FAILED",
                "plan": {"steps": [{"tool": "plugin.resolve"}, {"tool": "plugin.install"}]},
                "evidence": [{"kind": "diagnosis", "summary": "工具返回错误：Modrinth 没有兼容制品"}],
            })
            self.assertEqual(response["answer"], "EssentialsX 安装失败：Modrinth 没有兼容制品")
            self.assertNotIn("重启", response["answer"])
        finally:
            await graph.close()

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

    async def test_lifecycle_terminal_state_without_instance_evidence_is_not_success(self):
        response = await self.graph.respond({
            "threadId": "session-lifecycle-missing-evidence",
            "intent": "启动服务器",
            "taskState": "SUCCEEDED",
            "plan": {"steps": [{"tool": "instance.start"}]},
            "evidence": [],
        })
        self.assertIn("缺少实例状态证据", response["answer"])
        self.assertIn("无法确认完成", response["answer"])

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

    async def test_empty_plugin_inventory_is_explained_without_raw_console_noise(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "plugins-empty.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-plugins-empty",
                "intent": "查看现在有哪些插件\n\nAgent operation: 在当前实例 Minecraft 控制台执行 plugins",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "console.command"}]},
                "evidence": [{"kind": "console", "summary": "控制台返回：\n[20:03:30] [Server thread/INFO]: Server Plugins (0):"}],
            })
            self.assertEqual(response["answer"], "当前服务器没有已加载的插件，插件数量为 0。")
            self.assertNotIn("20:03:30", response["answer"])
        finally:
            await graph.close()

    async def test_loaded_plugin_inventory_reports_count_and_names(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "plugins-loaded.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-plugins-loaded",
                "intent": "查询服务器插件列表",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "console.command"}]},
                "evidence": [{"kind": "console", "summary": "控制台返回： Server Plugins (2): §aEssentials, §bLuckPerms"}],
            })
            self.assertEqual(response["answer"], "当前服务器已加载 2 个插件：Essentials, LuckPerms。")
        finally:
            await graph.close()

    async def test_readonly_health_inspection_summarizes_all_three_tool_receipts(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "health-inspection.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-health-inspection",
                "intent": "完成只读健康检查：version、plugins、日志；不要停止服务器",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [
                    {"tool": "console.command"},
                    {"tool": "console.command"},
                    {"tool": "logs.query"},
                ]},
                "evidence": [
                    {"kind": "console", "summary": "控制台返回：This server is running Paper version 1.21.1-133"},
                    {"kind": "console", "summary": "控制台返回：Server Plugins (0):"},
                    {"kind": "logs", "summary": "Recent log excerpt: Server started normally. Done (2.1s)!"},
                ],
            })
            self.assertIn("Paper version 1.21.1-133", response["answer"])
            self.assertIn("插件数量为 0", response["answer"])
            self.assertIn("未匹配到 ERROR、WARN", response["answer"])
            self.assertIn("暂未发现明显异常", response["answer"])
        finally:
            await graph.close()

    async def test_health_completion_uses_the_tool_sequence_even_when_the_planner_rephrases_the_goal(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "health-rephrased.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-health-rephrased",
                "intent": "依次确认运行版本、已加载扩展和近期异常，等待每一步返回后综合判断",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [
                    {"tool": "console.command"}, {"tool": "console.command"}, {"tool": "logs.query"},
                ]},
                "evidence": [
                    {"kind": "console", "summary": "This server is running Paper version 1.21.1-133"},
                    {"kind": "console", "summary": "Server Plugins (0):"},
                    {"kind": "logs", "summary": "Done (2.1s)!"},
                ],
            })
            self.assertIn("只读健康检查已完成", response["answer"])
            self.assertIn("Paper version 1.21.1-133", response["answer"])
        finally:
            await graph.close()

    async def test_log_diagnosis_distinguishes_version_404_from_network_failure(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "log-version-404.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-log-version-404",
                "intent": "读取最近一小时日志并诊断异常原因",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "logs.query"}]},
                "evidence": [{
                    "kind": "logs",
                    "summary": (
                        "[Thread-8/ERROR]: [PaperVersionFetcher] Error while parsing version\n"
                        "java.io.FileNotFoundException: https://api.papermc.io/v2/projects/paper/versions/1.21.1\n"
                        "Error obtaining version information\n"
                        "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"
                    ),
                }],
            })
            self.assertIn("HTTP 404", response["answer"])
            self.assertIn("未发现崩溃", response["answer"])
            self.assertIn("不足以支持 DNS", response["answer"])
            self.assertNotIn("最可能的故障原因是网络", response["answer"])
        finally:
            await graph.close()

    async def test_log_diagnosis_prioritizes_real_watchdog_and_lag_evidence(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "log-watchdog.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-log-watchdog",
                "intent": "检查日志并诊断卡服原因",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "logs.query"}]},
                "evidence": [{
                    "kind": "logs",
                    "summary": (
                        "[Paper Watchdog Thread/ERROR]: The server has not responded for 10 seconds\n"
                        "Can't keep up! Is the server overloaded? Running 8014ms or 160 ticks behind"
                    ),
                }],
            })
            self.assertIn("超过 10 秒未响应", response["answer"])
            self.assertIn("落后 8014ms（160 ticks）", response["answer"])
            self.assertIn("不能判定为完全健康", response["answer"])
        finally:
            await graph.close()

    async def test_readonly_health_inspection_prefers_real_version_line_and_named_log_signals(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "health-signals.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-health-signals",
                "intent": "完成只读健康检查：version、plugins、日志；不要停止服务器",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [
                    {"tool": "console.command"}, {"tool": "console.command"}, {"tool": "logs.query"},
                ]},
                "evidence": [
                    {"kind": "console", "summary": "PaperVersionFetcher https://api.papermc.io/v2/projects/paper/versions/1.21.1\nThis server is running Paper version 1.21.1-133"},
                    {"kind": "console", "summary": "Server Plugins (0):"},
                    {"kind": "logs", "summary": "Paper Watchdog: The server has not responded for 15 seconds\nCan't keep up! Running 18436ms or 368 ticks behind\nPaperVersionFetcher Error while parsing version"},
                ],
            })
            self.assertIn("This server is running Paper version 1.21.1-133", response["answer"])
            self.assertIn("主线程超过 15 秒未响应", response["answer"])
            self.assertIn("落后 18436ms（368 ticks）", response["answer"])
            self.assertIn("版本检查访问远端 API 失败", response["answer"])
            self.assertNotIn("papermc.io/v2", response["answer"])
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

    async def test_composite_completion_uses_all_source_goal_results_without_model(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "composite.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-composite-facts",
                "intent": "报告核心版本、活跃成员和告警数，再给出扩容结论",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "console.command"}], "sourceGoals": [
                    {"id": "sg-core", "source_text": "核心版本"},
                    {"id": "sg-members", "source_text": "活跃成员"},
                    {"id": "sg-alerts", "source_text": "告警数"},
                    {"id": "sg-capacity", "source_text": "扩容结论"},
                ]},
                "goalResults": [
                    {"source_goal_ids": ["sg-core"], "status": "satisfied", "summary": "核心版本：Lumen 4.8"},
                    {"source_goal_ids": ["sg-members"], "status": "satisfied", "summary": "活跃成员：Aster、Beacon"},
                    {"source_goal_ids": ["sg-alerts"], "status": "satisfied", "summary": "告警数：1"},
                    {"source_goal_ids": ["sg-capacity"], "status": "satisfied", "summary": "综合判断：先处理告警再扩容"},
                ],
                "evidence": [{"kind": "console", "summary": "last callback only"}],
            })
            self.assertIn("Lumen 4.8", response["answer"])
            self.assertIn("Aster、Beacon", response["answer"])
            self.assertIn("告警数：1", response["answer"])
            self.assertIn("先处理告警再扩容", response["answer"])
            self.assertNotEqual(response["answer"], "last callback only")
        finally:
            await graph.close()

    async def test_config_inspection_returns_requested_key_not_the_whole_file(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "config-inspect.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-config-inspect",
                "intent": "读取 server.properties，告诉我 view-distance 当前值，不要修改配置",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "config.inspect"}]},
                "evidence": [{"kind": "config", "summary": (
                    "Read /server.properties (1388 bytes, sha256:9cdc981c7b07c929)\n"
                    "motd=A Minecraft Server\n"
                    "rcon.password= [REDACTED]\n"
                    "view-distance=10\n"
                )}],
            })
            self.assertIn("view-distance=10", response["answer"])
            self.assertIn("未修改配置", response["answer"])
            self.assertNotIn("rcon.password", response["answer"])
        finally:
            await graph.close()

    async def test_config_inspection_returns_all_requested_keys_and_marks_missing(self):
        graph = McaiGraph(FailingProvider(), Path(self.temp.name) / "config-inspect-multi.sqlite3")
        try:
            response = await graph.respond({
                "threadId": "session-config-inspect-multi",
                "intent": "Show alpha-mode, cache.limit, and absent-key from config/engine.properties without changing anything.",
                "taskState": "SUCCEEDED",
                "plan": {"steps": [{"tool": "config.inspect"}]},
                "evidence": [{"kind": "config", "summary": (
                    "Read config/engine.properties (244 bytes, sha256:8ed52d53a0a2)\n"
                    "alpha-mode=true\n"
                    "cache.limit=128\n"
                    "absent-key=<MISSING>\n"
                    "api-token=[REDACTED]\n"
                )}],
            })
            self.assertIn("alpha-mode=true", response["answer"])
            self.assertIn("cache.limit=128", response["answer"])
            self.assertIn("absent-key", response["answer"])
            self.assertNotIn("<MISSING>", response["answer"])
            self.assertNotIn("api-token", response["answer"])
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
                "message": "不读取实时数据，为大型 Paper 服务器制定容量治理方案，包含风险、回滚和停止条件。",
                "availableTools": ["logs.query"],
            })
            diagnostics = await graph.route({
                "threadId": "session-template-diagnosis",
                "message": "不读取实时数据，仅根据以下证据诊断故障根因，并给出验证方案与验收标准。",
                "availableTools": ["logs.query"],
            })
            self.assertEqual(planner["route"], "delegate")
            self.assertEqual(diagnostics["route"], "delegate")
            self.assertIn("任务润色 Agent", provider.systems[0])
            self.assertIn("阶段、依赖、风险、验收、回滚、停止条件", provider.systems[1])
            self.assertIn("任务润色 Agent", provider.systems[2])
            self.assertIn("已知事实、推断、验证、风险、验收", provider.systems[3])
            self.assertIn("正常满速是 20 TPS", provider.systems[3])
            self.assertIn("不得写 TPS≥30", provider.systems[3])
            self.assertIn("禁止假设 spark、timings、JFR", provider.systems[3])
            self.assertIn('["logs.query"]', provider.systems[3])
        finally:
            await graph.close()

    async def test_invalid_minecraft_tps_diagnosis_is_replaced_with_a_safe_answer(self):
        class InvalidTpsProvider(FakeProvider):
            async def structured(self, _system, _messages, schema):
                if set(schema.get("properties", {})) == {"answer"}:
                    return {"answer": "已知事实：TPS=20 偏低。验证：运行 spark profiler。验收：TPS≥30。"}
                return await super().structured(_system, _messages, schema)

        graph = McaiGraph(InvalidTpsProvider(), Path(self.temp.name) / "invalid-tps.sqlite3")
        try:
            decision = await graph.route({
                "threadId": "session-invalid-tps",
                "message": (
                    "不读取任何真实服务器数据。这是虚构案例：TPS 近 15 分钟稳定为 20，MSPT p95 为 48ms，"
                    "内存每 40 秒出现一次 180ms GC，只有探索新区域时出现卡顿。"
                    "请诊断根因，区分事实、推断、验证、风险和验收。"
                ),
                "availableTools": ["logs.query", "console.command"],
            })
            self.assertEqual(decision["route"], "delegate")
            self.assertIn("属于正常满速而非低 TPS", decision["answer"])
            self.assertIn("MSPT 48ms", decision["answer"])
            self.assertIn("区块生成", decision["answer"])
            self.assertNotIn("TPS≥30", decision["answer"])
            self.assertNotIn("spark", decision["answer"].lower())
        finally:
            await graph.close()

    async def test_structured_performance_plan_keeps_all_user_constraints_when_model_is_truncated(self):
        class TruncatedPlannerProvider(FakeProvider):
            async def structured(self, _system, _messages, schema):
                if set(schema.get("properties", {})) == {"answer"}:
                    return {"answer": "阶段1：先优化配置；阶段2：再精简插件；阶段3："}
                return await super().structured(_system, _messages, schema)

        graph = McaiGraph(TruncatedPlannerProvider(), Path(self.temp.name) / "truncated-plan.sqlite3")
        try:
            decision = await graph.route({
                "threadId": "session-truncated-plan",
                "message": (
                    "不读取实时数据，为一个 150 人在线、20 个插件的大型 Paper 生存服制定三阶段性能治理方案。"
                    "约束：维护窗口每周只有 20 分钟，不能丢失玩家数据，必须支持回滚；给出依赖、风险、量化验收和停止条件。"
                ),
                "availableTools": ["logs.query", "console.command", "config.patch"],
            })
            self.assertEqual(decision["route"], "delegate")
            for expected in ("150 人负载", "20 个插件", "不超过 20 分钟", "依赖：", "风险：", "验收：", "回滚：", "停止条件："):
                self.assertIn(expected, decision["answer"])
            self.assertIn("TPS 接近 20", decision["answer"])
            self.assertIn("MSPT 低于 50ms", decision["answer"])
        finally:
            await graph.close()

    async def test_constrained_complex_answers_survive_provider_timeout(self):
        class TimeoutDelegateProvider(FakeProvider):
            async def structured(self, *_args, **_kwargs):
                raise TimeoutError()

        graph = McaiGraph(TimeoutDelegateProvider(), Path(self.temp.name) / "constrained-timeout.sqlite3")
        try:
            diagnosis = await graph.route({
                "threadId": "session-diagnosis-timeout",
                "message": "不读取实时数据：TPS 20，MSPT 48ms，每 40 秒有 180ms GC，探索新区块时卡顿；请诊断并给出验证和验收。",
                "availableTools": ["logs.query", "console.command"],
            })
            planning = await graph.route({
                "threadId": "session-plan-timeout",
                "message": "不读取实时数据，为 150 人、20 个插件的 Paper 服制定三阶段性能治理方案，维护窗口 20 分钟，必须回滚并给出停止条件。",
                "availableTools": ["logs.query", "console.command", "config.patch"],
            })
            self.assertEqual(diagnosis["route"], "delegate")
            self.assertIn("TPS 20", diagnosis["answer"])
            self.assertNotIn("模型服务", diagnosis["answer"])
            self.assertEqual(planning["route"], "delegate")
            self.assertIn("回滚：", planning["answer"])
            self.assertIn("停止条件：", planning["answer"])
            self.assertNotIn("模型服务", planning["answer"])
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
            self.assertIn("无法确认完成", response["answer"])
            self.assertNotIn("已完成并通过", response["answer"])
        finally:
            await graph.close()


class RoutingTests(unittest.TestCase):
    def test_tps_validator_distinguishes_correction_from_an_invalid_claim(self):
        self.assertFalse(_has_invalid_tps_claim("TPS 20，属于正常满速而非低 TPS；验收保持接近 20。"))
        self.assertTrue(_has_invalid_tps_claim("TPS=20 偏低，验收要求 TPS≥30。"))

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

    def test_unlisted_plugin_name_routes_to_generic_install_workflow(self):
        decision = _deterministic_decision("安装 CoreProtect", [], {"plugin.install", "plugin.resolve"})
        self.assertEqual(decision["preferredTool"], "plugin.install")

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

    def test_config_inspection_routes_to_readonly_tool(self):
        decision = _deterministic_decision(
            "读取 plugins/Lobby/config.yml 配置文件", [], {"config.inspect", "config.patch"}
        )
        self.assertEqual(decision["preferredTool"], "config.inspect")

    def test_structured_plugin_config_routes_to_patch(self):
        decision = _deterministic_decision(
            '修改插件配置\nMCAI_CONFIG path=plugins/Lobby/config.yml key=welcome.message value_json="欢迎"',
            [],
            {"config.inspect", "config.patch"},
        )
        self.assertEqual(decision["preferredTool"], "config.patch")

    def test_plugin_resolve_routes_without_installing(self):
        decision = _deterministic_decision("解析 EssentialsX 兼容版本和制品，但不要安装", [], {"plugin.resolve"})
        self.assertEqual(decision["preferredTool"], "plugin.resolve")

    def test_explicit_install_wins_over_intermediate_resolve_wording(self):
        decision = _deterministic_decision(
            "安装 EssentialsX 插件，但不要重启；先解析兼容制品并显示下载校验进度。",
            [],
            {"plugin.resolve", "plugin.install", "instance.restart"},
        )
        self.assertEqual(decision["preferredTool"], "plugin.install")

    def test_restart_negation_does_not_negate_later_install_verification_clause(self):
        decision = _deterministic_decision(
            "下载并安装 ProtocolLib 插件，不要重启服务器；安装后必须确认插件 JAR 已经真实落盘。",
            [],
            {"plugin.resolve", "plugin.install", "instance.restart", "files.list"},
        )
        self.assertEqual(decision["preferredTool"], "plugin.install")

    def test_explicit_no_install_stays_resolve_only(self):
        decision = _deterministic_decision(
            "查询 EssentialsX 官方制品，只解析和校验下载，不要安装，不要重启。",
            [],
            {"plugin.resolve", "plugin.install", "instance.restart"},
        )
        self.assertEqual(decision["preferredTool"], "plugin.resolve")

    def test_colloquial_plugin_probe_ignores_stale_failure_history(self):
        decision = _deterministic_decision(
            "看看 ProtocolLib 能不能装，先别安装",
            [{"role": "assistant", "content": "上一次解析失败，未找到兼容制品"}],
            {"plugin.resolve", "plugin.install"},
        )
        self.assertEqual(decision["route"], "tool")
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

    def test_natural_difficulty_change_routes_to_console(self):
        decision = _deterministic_decision(
            "把当前服务器游戏难度调成简单，完成后确认结果，不要重启。",
            [],
            {"console.command", "instance.restart"},
        )
        self.assertEqual(decision["preferredTool"], "console.command")
        self.assertIn("difficulty easy", decision["toolIntent"])

    def test_current_difficulty_query_routes_to_console(self):
        decision = _deterministic_decision(
            "只读查询当前服务器游戏难度并告诉我结果，不要修改。",
            [],
            {"console.command"},
        )
        self.assertEqual(decision["preferredTool"], "console.command")
        self.assertIn("difficulty", decision["toolIntent"])

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

    def test_short_health_request_is_sent_to_the_planner_model(self):
        available = {"logs.query", "console.command"}
        self.assertIsNone(_deterministic_decision("看看服务器有没有问题", [], available))
        self.assertTrue(_should_plan_request("看看服务器有没有问题", available))

    def test_short_service_abnormal_phrase_expands_to_the_readonly_health_skill(self):
        expanded = _readonly_health_skill_intent("查看服务是否有异常")
        self.assertIsNotNone(expanded)
        self.assertIn("version", expanded)
        self.assertIn("plugins", expanded)
        self.assertIn("最近 60 分钟日志", expanded)
        self.assertTrue(_should_plan_request("查看服务是否有异常", {"logs.query", "console.command"}))

    def test_general_knowledge_comparison_uses_the_refinement_agent(self):
        available = {"logs.query", "console.command"}
        self.assertTrue(_should_plan_request(
            "概念问题：Paper 与 Fabric 的适用场景有什么不同？只基于通用知识回答，不读取实例数据。",
            available,
        ))

    def test_trivial_arithmetic_skips_the_refinement_agent(self):
        self.assertFalse(_should_plan_request("17 乘以 19 等于多少？", {"console.command"}))

    def test_refiner_prompt_contains_the_operational_instruction_set(self):
        prompt = _planner_prompt({
            "instance": {"id": "current"},
            "availableTools": ["console.command", "logs.query", "plugin.install"],
        })
        for expected in (
            "任务润色 Agent",
            "不得重复询问实例 ID",
            "日志默认最近 60 分钟",
            "不能混淆已加载插件和磁盘 JAR",
            "等待每个真实回调",
            "没有回调证据不得声称成功",
            "EULA 只能在用户明确同意后写入",
            "停止和重启属于高风险",
            "不得无限循环",
            "仅当缺失信息会改变制品、目标、权限或产生不可逆风险时澄清",
        ):
            self.assertIn(expected, prompt)

    def test_health_tutorial_question_is_not_expanded_to_a_live_skill(self):
        decision = _deterministic_decision(
            "Minecraft 服务器健康检查一般怎么做？",
            [],
            {"logs.query", "console.command"},
        )
        self.assertIsNone(decision)

    def test_explicit_operation_is_not_swallowed_by_offline_delegate_keywords(self):
        decision = _deterministic_decision(
            "离线安装方案：下载 Paper 1.21.1 服务端。",
            [],
            {"server.install"},
        )
        self.assertEqual(decision["route"], "tool")
        self.assertEqual(decision["preferredTool"], "server.install")


class ModelAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_native_schema_times_out_while_compact_json_finishes_in_the_same_budget(self):
        legacy = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        compact = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", profile=ProviderCapabilityProfile(mode="json_only")))
        valid = '{"schema_version":"intent-candidate/v2","clauses":[],"goals":[],"scopes":[],"constraints":[],"evidence_requirements":[],"response_requirements":[],"predicates":[],"unknown_goals":[]}'
        async def request(_model, _system, _messages, _schema, mode, max_tokens=None):
            if mode == "json_schema":
                await asyncio.sleep(0.05)
            return valid
        legacy._request = request  # type: ignore[method-assign]
        compact._request = request  # type: ignore[method-assign]
        with self.assertRaises(ModelProviderError):
            await legacy.structured("legacy", [{"role": "user", "content": "inspect"}], _intent_ir_schema(), timeout_seconds=0.01)
        result = await compact.compact_json("compact", [{"role": "user", "content": "inspect"}], _intent_candidate_schema(), {"attempt_seconds": 0.01, "total_seconds": 0.02})
        self.assertEqual(result["schema_version"], "intent-candidate/v2")

    async def test_compile_repairs_one_complete_parse_failure_with_remaining_budget(self):
        class RepairingProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, _system, _messages, _schema, _budget):
                self.calls += 1
                if self.calls == 1:
                    raise ModelProviderError("INTENT_COMPILER_PARSE_ERROR", [], {"provider_ms": 3})
                return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": ["src-0001"], "frames": [{"owner_source_ref": "src-0001", "roles": [{"role": "discourse", "polarity": "neutral", "status": "mapped", "reason": "context", "goals": [], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}]}], "providerModel": "repairing", "compilerMetrics": {"terminal_code": "OK"}}
        provider = RepairingProvider()
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "compact-repair.sqlite3", provider)
            try:
                result = await graph.compile_intent({"sourceCatalog": SOURCE_CATALOG, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": []})
                self.assertEqual(provider.calls, 2)
                self.assertTrue(result["repairUsed"])
                self.assertEqual(result["compilerMetrics"]["repair_reason"], "INTENT_COMPILER_PARSE_ERROR")
            finally:
                await graph.close()

    async def test_compile_does_not_repair_provider_timeout(self):
        class TimeoutProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, *_args, **_kwargs):
                self.calls += 1
                raise ModelProviderError("INTENT_COMPILER_PROVIDER_TIMEOUT", [], {"provider_ms": 10})
        provider = TimeoutProvider()
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "compact-timeout.sqlite3", provider)
            try:
                with self.assertRaises(ModelProviderError) as caught:
                    await graph.compile_intent({"sourceCatalog": SOURCE_CATALOG, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": []})
                self.assertEqual(caught.exception.code, "INTENT_COMPILER_PROVIDER_TIMEOUT")
                self.assertEqual(provider.calls, 1)
            finally:
                await graph.close()

    async def test_semantic_frame_failure_cancels_other_shards_and_ignores_late_work(self):
        cancelled = 0
        completed = 0
        class ShardedProvider(FakeProvider):
            async def compact_json(self, _system, _messages, _schema, budget):
                nonlocal cancelled, completed
                if budget["shard_id"] == "frame-shard-01":
                    raise ModelProviderError("INTENT_COMPILER_PROVIDER_TIMEOUT", [], {"provider_ms": 1})
                try:
                    await asyncio.sleep(0.1)
                    completed += 1
                    return {}
                except asyncio.CancelledError:
                    cancelled += 1
                    raise
        refs = [{"id": f"src-{index:04d}", "source_start": index - 1, "source_end": index, "text": "x", "order": index - 1} for index in range(1, 4)]
        catalog = {**SOURCE_CATALOG, "refs": refs}
        plan = {**FRAME_PLAN, "complexity": "complex", "shards": [{"id": f"frame-shard-{index:02d}", "assigned_source_refs": [f"src-{index:04d}"], "context_source_refs": [ref["id"] for ref in refs], "estimated_output_chars": 1100, "max_output_tokens": 275} for index in range(1, 4)]}
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "cancel-shards.sqlite3", ShardedProvider())
            try:
                with self.assertRaises(ModelProviderError) as caught:
                    await graph.compile_intent({"sourceCatalog": catalog, "framePlan": plan, "attempt": 1, "capabilities": []})
                self.assertEqual(caught.exception.code, "INTENT_COMPILER_PROVIDER_TIMEOUT")
                self.assertEqual(cancelled, 2)
                self.assertEqual(completed, 0)
                self.assertEqual(caught.exception.metrics["provider_call_count"], 3)
                self.assertEqual(caught.exception.metrics["cancelled_shard_count"], 2)
            finally:
                await graph.close()

    async def test_unclassified_frame_uses_only_one_global_repair(self):
        class FrameProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, _system, _messages, _schema, _budget):
                self.calls += 1
                if self.calls == 1:
                    return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": ["src-0001"], "frames": [], "providerModel": "fixture", "compilerMetrics": {}}
                roles = [{"role": "discourse", "polarity": "neutral", "status": "mapped", "reason": "context", "goals": [], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}]
                return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": ["src-0001"], "frames": [{"owner_source_ref": "src-0001", "roles": roles}], "providerModel": "fixture", "compilerMetrics": {}}
        provider = FrameProvider()
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "repair-frame.sqlite3", provider)
            try:
                result = await graph.compile_intent({"sourceCatalog": SOURCE_CATALOG, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": []})
                self.assertEqual(provider.calls, 2)
                self.assertTrue(result["repairUsed"])
                self.assertEqual(result["compilerMetrics"]["provider_call_count"], 2)
            finally:
                await graph.close()

    async def test_cross_topic_log_or_uses_one_bounded_repair_and_keeps_other_shards(self):
        class CrossTopicProvider(FakeProvider):
            def __init__(self):
                self.calls = 0
                self.repair_reasons = []

            async def compact_json(self, _system, messages, _schema, budget):
                self.calls += 1
                payload = json.loads(messages[0]["content"])
                if "branch" in payload:
                    term = "proxy_service" if self.calls == 1 else "world_storage"
                    return {"schema_version": "log-branch/v1", "group": {"all_of": [term], "any_of": ["authentication_failure"]}, "providerModel": "fixture", "compilerMetrics": {}}
                if "requiredGroupCount" in payload:
                    self.repair_reasons.append(f"LOG_FILTER_OR_BRANCH_COLLAPSE:required_groups={payload['requiredGroupCount']}")
                    return {"schema_version": "log-filter-group-repair/v1", "groups": [{"all_of": ["proxy_service", "authentication_failure"], "any_of": []}, {"all_of": ["world_storage", "chunk_corruption"], "any_of": []}], "providerModel": "fixture", "compilerMetrics": {}}
                repair = payload.get("repair") or {}
                if repair:
                    self.repair_reasons.append(repair.get("reason"))
                assigned = payload["assignedSourceRefs"]
                roles = [{"role": "discourse", "polarity": "neutral", "status": "mapped", "reason": "context", "goals": [], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}]
                if budget["shard_id"] == "frame-shard-01":
                    groups = [{"all_of": ["proxy_service", "authentication_failure"], "any_of": []}]
                    if repair:
                        groups.append({"all_of": ["world_storage", "chunk_corruption"], "any_of": []})
                    roles = [{"role": "domain_goal", "polarity": "positive", "status": "mapped", "reason": "diagnose alternatives", "goals": [{"key": "events", "domain": "diagnosis", "entity": "recent-logs", "capability": "logs.query", "target": "recent-logs", "parameters": {"window_minutes": 30, "max_lines": 240, "filter_groups": groups}, "result_kind": "collection", "required": True}], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}]
                return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": assigned, "frames": [{"owner_source_ref": ref, "roles": roles} for ref in assigned], "providerModel": "fixture", "compilerMetrics": {}}

            async def compact_labels(self, _system, branch, _terms, _budget):
                self.calls += 1
                group = ({"all_of": ["proxy_service"], "any_of": ["authentication_failure"]}
                         if "proxy" in branch.lower() or "database" in branch.lower()
                         else {"all_of": ["world_storage"], "any_of": ["chunk_corruption"]})
                return {"group": group, "providerModel": "fixture", "compilerMetrics": {}}

        texts = [
            "Inspect proxy authentication rejection, or alternatively world snapshot corruption.",
            "Review database connection loss; alternatively certificate renewal failure.",
        ]
        for case_index, text in enumerate(texts):
            with self.subTest(text=text):
                split = max(text.find(",") + 1, text.find(";") + 1)
                refs = [{"id": "src-0001", "source_start": 0, "source_end": split, "text": text[:split], "order": 0}, {"id": "src-0002", "source_start": split, "source_end": len(text), "text": text[split:], "order": 1}]
                catalog = {**SOURCE_CATALOG, "refs": refs}
                plan = {**FRAME_PLAN, "complexity": "complex", "shards": [{"id": "frame-shard-01", "assigned_source_refs": ["src-0001"], "context_source_refs": ["src-0001", "src-0002"], "estimated_output_chars": 1100, "max_output_tokens": 275}, {"id": "frame-shard-02", "assigned_source_refs": ["src-0002"], "context_source_refs": ["src-0001", "src-0002"], "estimated_output_chars": 1100, "max_output_tokens": 275}]}
                provider = CrossTopicProvider()
                with tempfile.TemporaryDirectory() as directory:
                    graph = McaiGraph(FakeProvider(), Path(directory) / f"cross-topic-repair-{case_index}.sqlite3", provider)
                    try:
                        result = await graph.compile_intent({"sourceCatalog": catalog, "framePlan": plan, "attempt": 1, "capabilities": []})
                        self.assertEqual(provider.calls, 2)
                        self.assertFalse(result["repairUsed"])
                        self.assertIn(len(result["semanticFrames"]), {1, 2})
                        self.assertEqual(provider.repair_reasons, [])
                    finally:
                        await graph.close()

    async def test_single_topic_log_alternatives_do_not_trigger_repair(self):
        class SingleTopicProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_json(self, _system, messages, _schema, _budget):
                self.calls += 1
                payload = json.loads(messages[0]["content"])
                assigned = payload["assignedSourceRefs"]
                goal = {"key": "events", "domain": "diagnosis", "entity": "recent-logs", "capability": "logs.query", "target": "recent-logs", "parameters": {"window_minutes": 30, "max_lines": 240, "filter_groups": [{"all_of": ["proxy_service"], "any_of": ["authentication_failure", "response_timeout"]}]}, "result_kind": "collection", "required": True}
                role = {"role": "domain_goal", "polarity": "positive", "status": "mapped", "reason": "one topic", "goals": [goal], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}
                return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": assigned, "frames": [{"owner_source_ref": ref, "roles": [role]} for ref in assigned], "providerModel": "fixture", "compilerMetrics": {}}
        provider = SingleTopicProvider()
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "single-topic.sqlite3", provider)
            try:
                result = await graph.compile_intent({"sourceCatalog": SOURCE_CATALOG, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": []})
                self.assertEqual(provider.calls, 1)
                self.assertFalse(result["repairUsed"])
            finally:
                await graph.close()

    async def test_cross_topic_log_branches_compile_independently_for_two_and_three_branches(self):
        class BranchProvider(FakeProvider):
            def __init__(self): self.calls = []
            async def compact_labels(self, _system, branch, canonical_terms, _budget):
                self.calls.append(branch)
                assert "proxy_service" in canonical_terms
                return {"group": {"all_of": ["proxy_service"], "any_of": ["authentication_failure"]}, "providerModel": "fixture", "compilerMetrics": {}}
        for text, count in [("Proxy rejection; alternatively world corruption", 2), ("Database loss; alternatively certificate failure; or backup damage", 3)]:
            catalog = {**SOURCE_CATALOG, "refs": [{"id": "src-0001", "source_start": 0, "source_end": len(text), "text": text.replace("Proxy", "UnknownAlpha").replace("world", "UnknownBeta").replace("Database", "UnknownGamma").replace("backup", "UnknownDelta"), "order": 0}]}
            provider = BranchProvider()
            with tempfile.TemporaryDirectory() as directory:
                graph = McaiGraph(FakeProvider(), Path(directory) / f"branches-{count}.sqlite3", provider)
                try:
                    result = await graph.compile_intent({"sourceCatalog": catalog, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": [{"id": "logs.query"}]})
                    self.assertEqual(len(provider.calls), count)
                    goals = result["semanticFrames"][0]["frames"][0]["roles"][0]["goals"]
                    self.assertEqual(len(goals[0]["parameters"]["filter_groups"]), count)
                finally:
                    await graph.close()

    def test_top_level_log_or_split_supports_unpunctuated_cn_en_and_preserves_local_or(self):
        from mcai_graph.graph import _explicit_log_or_branches
        def catalog(text):
            return {"refs": [{"id": "src-0001", "text": text, "order": 0}]}
        self.assertEqual(len(_explicit_log_or_branches(catalog("检查代理认证失败或者世界快照损坏"))), 2)
        self.assertEqual(len(_explicit_log_or_branches(catalog("Check proxy authentication failure or world snapshot corruption"))), 2)
        self.assertEqual(len(_explicit_log_or_branches(catalog("检查数据库连接失败或是代理认证拒绝要么世界快照损坏"))), 3)
        self.assertEqual(len(_explicit_log_or_branches(catalog("Check player connection failure or timeout"))), 1)
        self.assertEqual(len(_explicit_log_or_branches(catalog("检查最近一小时日志里有没有内存不足或者服务器跟不上运行的报错，告诉我数量并判断是否需要处理"))), 2)
        self.assertEqual(len(_explicit_log_or_branches(catalog("检查内存不足、堆耗尽或GC过高"))), 1)

    async def test_full_unpunctuated_cn_log_question_compiles_two_ai_groups_and_three_goals(self):
        class ChineseBranchProvider(FakeProvider):
            def __init__(self): self.branches = []
            async def compact_labels(self, _system, branch, _canonical_terms, _budget):
                self.branches.append(branch)
                group = ({"all_of": ["memory_resource"], "any_of": ["out_of_memory"]}
                         if "内存" in branch else
                         {"all_of": ["server_lag"], "any_of": ["cannot_keep_up"]})
                return {"group": group, "providerModel": "fixture", "compilerMetrics": {}}
        text = "\u68c0\u67e5\u6700\u8fd1\u4e00\u5c0f\u65f6\u65e5\u5fd7\u91cc\u6709\u6ca1\u6709\u5185\u5b58\u4e0d\u8db3\u6216\u8005\u670d\u52a1\u5668\u8ddf\u4e0d\u4e0a\u8fd0\u884c\u7684\u62a5\u9519\uff0c\u544a\u8bc9\u6211\u5339\u914d\u6570\u91cf\u5e76\u5224\u65ad\u662f\u5426\u9700\u8981\u5904\u7406"
        catalog = {**SOURCE_CATALOG, "refs": [{"id": "src-0001", "source_start": 0, "source_end": len(text), "text": text, "order": 0}]}
        provider = ChineseBranchProvider()
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "full-cn-branches.sqlite3", provider)
            try:
                result = await graph.compile_intent({"sourceCatalog": catalog, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": [{"id": "logs.query"}]})
                goals = result["semanticFrames"][0]["frames"][0]["roles"][0]["goals"]
                self.assertEqual(len(provider.branches), 2)
                self.assertIn("\u6700\u8fd1\u4e00\u5c0f\u65f6", provider.branches[0])
                self.assertIn("\u544a\u8bc9\u6211\u5339\u914d\u6570\u91cf", provider.branches[1])
                self.assertEqual([goal["result_kind"] for goal in goals], ["collection", "count", "fact"])
                self.assertEqual(len(goals[0]["parameters"]["filter_groups"]), 2)
            finally:
                await graph.close()

    async def test_one_ref_frame_budget_allows_a_complete_semantic_envelope(self):
        seen = {}
        class BudgetProvider(FakeProvider):
            async def compact_json(self, _system, messages, _schema, budget):
                seen.update(budget)
                assigned = json.loads(messages[0]["content"])["assignedSourceRefs"]
                role = {"role": "discourse", "polarity": "neutral", "status": "mapped", "reason": "context", "goals": [], "scopes": [], "constraints": [], "evidence_requirements": [], "response_requirements": [], "predicates": [], "unknown_goals": []}
                return {"schema_version": "intent-semantic-frame/v1", "assigned_source_refs": assigned, "frames": [{"owner_source_ref": ref, "roles": [role]} for ref in assigned], "providerModel": "fixture", "compilerMetrics": {}}
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "frame-budget.sqlite3", BudgetProvider())
            try:
                await graph.compile_intent({"sourceCatalog": SOURCE_CATALOG, "framePlan": FRAME_PLAN, "attempt": 1, "capabilities": []})
                self.assertGreaterEqual(seen["max_tokens"], 512)
                self.assertGreaterEqual(seen["output_max_chars"], 2048)
            finally:
                await graph.close()

    async def test_timeout_cancels_late_provider_work(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", profile=ProviderCapabilityProfile(mode="json_only")))
        cancelled = asyncio.Event()
        completed = asyncio.Event()
        async def request(*_args, **_kwargs):
            try:
                await asyncio.sleep(0.1)
                completed.set()
                return "{}"
            except asyncio.CancelledError:
                cancelled.set()
                raise
        provider._request = request  # type: ignore[method-assign]
        with self.assertRaises(ModelProviderError):
            await provider.compact_json("compiler", [{"role": "user", "content": "inspect"}], _intent_candidate_schema(), {"attempt_seconds": 0.01, "total_seconds": 0.02})
        await asyncio.sleep(0.02)
        self.assertTrue(cancelled.is_set())
        self.assertFalse(completed.is_set())

    async def test_compact_json_profile_uses_plain_json_mode_and_hard_output_budget(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", profile=ProviderCapabilityProfile(mode="json_only")))
        seen = []
        async def request(_model, _system, _messages, _schema, mode, max_tokens=None):
            seen.append((mode, max_tokens))
            return '{"schema_version":"intent-candidate/v2","clauses":[],"goals":[],"scopes":[],"constraints":[],"evidence_requirements":[],"response_requirements":[],"predicates":[],"unknown_goals":[]}'
        provider._request = request  # type: ignore[method-assign]
        result = await provider.compact_json("compiler", [{"role": "user", "content": "inspect"}], _intent_candidate_schema(), {"attempt_seconds": 1, "total_seconds": 2})
        self.assertEqual(seen, [("json_only", 2048)])
        self.assertLessEqual(result["compilerMetrics"]["output_chars"], INTENT_CANDIDATE_OUTPUT_MAX_CHARS)

    async def test_compact_labels_uses_plain_non_streaming_content_request(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", profile=ProviderCapabilityProfile(mode="json_only")))
        seen = {}
        async def request(_model, system, messages, schema, mode, max_tokens=None):
            seen.update({"system": system, "messages": messages, "schema": schema, "mode": mode, "max_tokens": max_tokens})
            return "ALL=proxy_service|ANY=authentication_failure"
        provider._request = request  # type: ignore[method-assign]
        result = await provider.compact_labels("classify", "proxy auth failure", ["proxy_service", "authentication_failure"], {"attempt_seconds": 1, "total_seconds": 2})
        self.assertEqual(result["group"], {"all_of": ["proxy_service"], "any_of": ["authentication_failure"]})
        self.assertEqual(seen["mode"], "plain_labels")
        self.assertEqual(seen["schema"], {})
        self.assertLessEqual(seen["max_tokens"], 256)

    async def test_plain_label_http_body_omits_structured_and_stream_controls(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        captured = {}
        class Response:
            status_code = 200
            def json(self): return {"choices": [{"message": {"content": "ALL=server_lag|ANY=cannot_keep_up"}}]}
        class Client:
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): return None
            async def post(self, _endpoint, **kwargs): captured.update(kwargs["json"]); return Response()
        with patch("mcai_graph.graph.httpx.AsyncClient", return_value=Client()):
            content = await provider._request("primary", "classify", [{"role": "user", "content": "lag"}], {}, "plain_labels", 128)
        self.assertEqual(content, "ALL=server_lag|ANY=cannot_keep_up")
        self.assertNotIn("reasoning_split", captured)
        self.assertNotIn("response_format", captured)
        self.assertNotIn("stream", captured)

    async def test_agent_loop_plain_content_http_body_omits_structured_reasoning_and_stream_controls(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary"))
        captured = {}
        class Response:
            status_code = 200
            def json(self): return {"choices": [{"message": {"content": '{"action":"cannot_proceed","answer":"Need details"}'}}]}
        class Client:
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): return None
            async def post(self, _endpoint, **kwargs): captured.update(kwargs["json"]); return Response()
        with patch("mcai_graph.graph.httpx.AsyncClient", return_value=Client()):
            content = await provider.plain_json("agent loop", [{"role": "user", "content": "help"}])
        self.assertIn('"action"', content)
        self.assertNotIn("reasoning_split", captured)
        self.assertNotIn("response_format", captured)
        self.assertNotIn("stream", captured)

    async def test_compact_label_parser_rejects_unknown_extra_empty_and_repairs_one_branch(self):
        from mcai_graph.graph import _parse_compact_log_labels
        allowed = {"server_lag", "cannot_keep_up"}
        self.assertEqual(_parse_compact_log_labels("ALL=server_lag|ANY=cannot_keep_up", allowed), {"all_of": ["server_lag"], "any_of": ["cannot_keep_up"]})
        for invalid in ("ALL=unknown|ANY=", "answer ALL=server_lag|ANY=", "ALL=|ANY=", "ALL=server_lag,server_lag|ANY=", "ALL=server_lag|ANY=server_lag"):
            with self.assertRaises(ValueError): _parse_compact_log_labels(invalid, allowed)

        class RepairProvider(FakeProvider):
            def __init__(self): self.calls = 0
            async def compact_labels(self, _system, _branch, _terms, _budget):
                self.calls += 1
                if self.calls == 1:
                    raise ModelProviderError("INTENT_COMPILER_PARSE_ERROR", [], {})
                return {"group": {"all_of": ["server_lag"], "any_of": ["cannot_keep_up"]}, "providerModel": "fixture", "compilerMetrics": {}}
        text = "Check server lag or proxy authentication failure"
        catalog = {**SOURCE_CATALOG, "refs": [{"id": "src-0001", "source_start": 0, "source_end": len(text), "text": text, "order": 0}]}
        provider = RepairProvider()
        with tempfile.TemporaryDirectory() as directory:
            graph = McaiGraph(FakeProvider(), Path(directory) / "label-repair.sqlite3", provider)
            try:
                result = await graph.compile_intent({"sourceCatalog": catalog, "framePlan": {**FRAME_PLAN, "max_provider_calls": 4}, "attempt": 1, "capabilities": [{"id": "logs.query"}]})
                self.assertEqual(provider.calls, 3)
                self.assertEqual(len(result["semanticFrames"][0]["frames"][0]["roles"][0]["goals"][0]["parameters"]["filter_groups"]), 2)
            finally:
                await graph.close()

    async def test_compiler_timeout_is_terminal_and_does_not_try_another_mode_or_model(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", ("fallback",), ProviderCapabilityProfile(mode="json_only")))
        calls = []
        async def request(model, _system, _messages, _schema, mode, max_tokens=None):
            calls.append((model, mode))
            await asyncio.sleep(0.05)
            return "{}"
        provider._request = request  # type: ignore[method-assign]
        with self.assertRaises(ModelProviderError) as caught:
            await provider.compact_json("compiler", [{"role": "user", "content": "inspect"}], _intent_candidate_schema(), {"attempt_seconds": 0.01, "total_seconds": 0.02})
        self.assertEqual(caught.exception.code, "INTENT_COMPILER_PROVIDER_TIMEOUT")
        self.assertEqual(calls, [("primary", "json_only")])

    async def test_compact_parser_accepts_a_single_fence_but_rejects_extra_text_and_truncation(self):
        provider = ModelProvider(ProviderConfig("test", "http://example.invalid/v1", "primary", profile=ProviderCapabilityProfile(mode="json_only")))
        valid = '{"schema_version":"intent-candidate/v2","clauses":[],"goals":[],"scopes":[],"constraints":[],"evidence_requirements":[],"response_requirements":[],"predicates":[],"unknown_goals":[]}'
        responses = iter([f"```json\n{valid}\n```", valid + " trailing", valid[:-1]])
        async def request(*_args, **_kwargs): return next(responses)
        provider._request = request  # type: ignore[method-assign]
        self.assertEqual((await provider.compact_json("compiler", [{"role": "user", "content": "inspect"}], _intent_candidate_schema(), {"attempt_seconds": 1, "total_seconds": 2}))["schema_version"], "intent-candidate/v2")
        for _ in range(2):
            with self.assertRaises(ModelProviderError) as caught:
                await provider.compact_json("compiler", [{"role": "user", "content": "inspect"}], _intent_candidate_schema(), {"attempt_seconds": 1, "total_seconds": 2})
            self.assertIn(caught.exception.code, {"INTENT_COMPILER_PARSE_ERROR", "INTENT_COMPILER_VALIDATION_ERROR"})
    def test_output_budgets_keep_routing_and_answers_concise(self):
        answer_schema = {"required": ["answer"]}
        self.assertEqual(_max_tokens_for_schema(answer_schema), 512)
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

    def test_compact_json_parser_discards_complete_think_block(self):
        self.assertEqual(
            _strict_json_object('<think>private analysis</think>\n{"schema_version":"x","groups":[]}'),
            {"schema_version": "x", "groups": []},
        )

    def test_compact_json_parser_accepts_only_final_versioned_object_after_reasoning(self):
        self.assertEqual(
            _strict_json_object('analysis that is never executable\n{"schema_version":"x","count":true}'),
            {"schema_version": "x", "count": True},
        )

        self.assertEqual(
            _strict_json_object('analysis\n{"schema_version":"x","count":true}\ntrailing explanation'),
            {"schema_version": "x", "count": True},
        )

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
