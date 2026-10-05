import unittest
from mcai_graph.plugin_workflow import finalize_plugin_decision, next_plugin_decision, plugin_outcome_summary


def observation(tool, project, fact, status="succeeded"):
    return {"tool": tool, "status": status, "tool_call_id": tool + project, "data": {
        "call_arguments": {"project": project, "artifact_ref": project + ".jar"}, "observations": [{"observed": fact}]}}


def existing(project):
    return observation("plugin.install", project, {"schema_version": "plugin-install-result/v1", "project": project,
        "already_present": True, "sha256": "a" * 64, "installed_path": "plugins/" + project + ".jar"})


def blocked(project, resolution="no-compatible-artifact"):
    return observation("plugin.resolve", project, {"schema_version": "resolved-plugin/v1", "project": project,
        "resolution": resolution, "checked_sources": ["Modrinth", "Hangar"], "requested_minecraft_version": "1.21.1"})


class PluginOutcomeTests(unittest.TestCase):
    def test_multi_plugin_partial_answer_uses_actual_sources_and_noop(self):
        facts = [existing("alpha"), blocked("beta")]
        answer = plugin_outcome_summary("安装 Alpha 和 Beta", facts)
        self.assertIn("alpha：已有文件", answer)
        self.assertIn("无需重复安装或重启", answer)
        self.assertIn("beta：未安装", answer)
        self.assertIn("Modrinth、Hangar", answer)
        self.assertIn("1.21.1", answer)
        self.assertIsNone(next_plugin_decision("安装 Alpha 和 Beta", [], facts, {}))

    def test_incomplete_is_not_absence(self):
        answer = plugin_outcome_summary("安装 Beta", [blocked("beta", "search-incomplete")])
        self.assertIn("查询不完整", answer)
        self.assertNotIn("未找到适用于", answer)

    def test_query_failure_is_not_absence(self):
        fact = blocked("beta", "query-failed"); fact["status"] = "failed"
        answer = plugin_outcome_summary("安装 Beta", [fact])
        self.assertIn("查询或制品校验失败", answer)
        self.assertNotIn("未找到适用于", answer)

    def test_negative_resolution_cannot_install(self):
        self.assertIsNone(next_plugin_decision("安装 Beta", [{"name": "plugin.install"}], [blocked("beta")], {}))

    def test_read_only_request_does_not_gain_install_summary(self):
        self.assertIsNone(plugin_outcome_summary("只查看 Beta，不要安装", [blocked("beta")]))

    def test_two_existing_artifacts_are_not_new_installs(self):
        answer = plugin_outcome_summary("安装 Alpha 和 Beta", [existing("alpha"), existing("beta")])
        self.assertEqual(answer.count("无需重复安装或重启"), 2)
        self.assertNotIn("插件文件已安装", answer)

    def test_final_claim_corrected_from_observations_preserves_citations(self):
        decision = {"action": "final", "answer": "全部安装成功", "citations": ["a", "b"]}
        answer = finalize_plugin_decision(decision, "安装 Alpha 和 Beta", [existing("alpha"), blocked("beta")])
        self.assertNotIn("全部安装成功", answer["answer"])
        self.assertEqual(answer["citations"], decision["citations"])

    def test_unactivated_write_is_not_claimed_loaded(self):
        fact = existing("alpha"); fact["data"]["observations"][0]["observed"]["already_present"] = False
        self.assertIn("尚未确认", plugin_outcome_summary("安装 Alpha 和 Beta", [fact, blocked("beta")]))
