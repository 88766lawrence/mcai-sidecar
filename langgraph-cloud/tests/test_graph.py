from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mcai_graph.graph import McaiGraph, ProviderConfig, _deterministic_decision, _infer_pending_action


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


class RoutingTests(unittest.TestCase):
    def test_plugin_install_routes_to_controlled_tool(self):
        decision = _deterministic_decision("帮我安装 EssentialsX", [], {"plugin.install"})
        self.assertEqual(decision["trace"][0]["result"], "plugin.install")

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


if __name__ == "__main__":
    unittest.main()
