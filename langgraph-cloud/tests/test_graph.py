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
    _has_invalid_tps_claim,
    _infer_pending_action,
    _max_tokens_for_schema,
    _normalize_decision,
    _provider_content,
    _planner_prompt,
    _readonly_health_skill_intent,
    _router_prompt,
    _should_plan_request,
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
        # Windows can release SQLite sidecar files a few milliseconds after
        # the async connection closes. Test assertions must not become flaky
        # because rmtree races that delayed handle release.
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
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
