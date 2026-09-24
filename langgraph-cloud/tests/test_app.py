from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from mcai_graph import app as app_module
from mcai_graph.graph import ModelProviderError


class FakeGraph:
    def __init__(self) -> None:
        self.payload = None

    async def route(self, payload):
        self.payload = payload
        return {"route": "direct", "answer": "2", "requestId": "request-test"}

    async def respond(self, payload):
        self.payload = payload
        return {"status": "answered", "answer": "任务已完成。", "requestId": "response-test"}

    async def decide_agent_loop(self, payload):
        self.payload = payload
        return {"decision": {"action": "tool_call", "tool": "files.list", "arguments": {"path": "/plugins"}, "reason": "inspect files"}, "requestId": payload["_requestId"], "providerModel": "test", "repairUsed": False}

    async def probe(self):
        return {"model": "test"}

    async def compile_intent(self, payload):
        self.payload = payload
        return {"semanticFrames": [], "requestId": "intent-test", "providerModel": "test"}

    async def propose_confirmed_write(self, payload):
        self.payload = payload
        return {"proposal": {"schema_version": "confirmed-write-proposal/v1", "decision": "propose", "tool": "console.command", "parameters": {"command": "weather clear"}, "summary": "pending"}, "requestId": "proposal-test", "providerModel": "test", "proposalMetrics": {"mode": "json_only", "terminal_code": "WRITE_PROPOSAL_OK"}}


class TimeoutGraph(FakeGraph):
    async def compile_intent(self, payload):
        raise ModelProviderError("INTENT_COMPILER_PROVIDER_TIMEOUT", [], {"mode": "json_only", "attempt": 1, "provider": "test", "prompt": "must-not-leak"})


class ToolGraph(FakeGraph):
    async def route(self, payload):
        self.payload = payload
        return {
            "route": "tool",
            "answer": "正在调用受控工具。",
            "preferredTool": "instance.start",
            "toolIntent": "启动当前实例",
            "requestId": "request-tool-test",
        }


class UnavailableGraph(FakeGraph):
    async def probe(self):
        raise ModelProviderError("RATE_LIMIT", [])


class AppTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "serviceToken": "service-secret",
            "provider": {"apiKey": "provider-secret", "baseUrl": "https://example.invalid/v1", "model": "test"},
        }
        self.graph = FakeGraph()
        self.load_patch = patch.object(app_module, "load_config", return_value=self.config)
        self.graph_patch = patch.object(app_module, "current_graph", return_value=self.graph)
        self.load_patch.start()
        self.graph_patch.start()
        self.client = TestClient(app_module.app)

    def tearDown(self):
        self.graph_patch.stop()
        self.load_patch.stop()

    def test_health_identifies_python_langgraph_runtime(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["runtime"], "python-langgraph")
        self.assertTrue(response.json()["configured"])

    def test_ready_verifies_a_model_response(self):
        response = self.client.get("/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["model"], "test")

    def test_ready_reports_the_provider_failure_code(self):
        with patch.object(app_module, "current_graph", return_value=UnavailableGraph()):
            response = self.client.get("/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "RATE_LIMIT")

    def test_stream_announces_route_before_answer_content(self):
        with patch.object(app_module, "current_graph", return_value=ToolGraph()):
            response = self.client.post(
                "/v1/chat/stream",
                headers={"authorization": "Bearer service-secret"},
                json={"threadId": "stream-route", "message": "启动服务器"},
            )
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual(events[0], {"type": "route", "route": "tool"})
        self.assertEqual(events[1], {"type": "reset"})
        self.assertEqual(events[-1]["type"], "done")

    def test_chat_requires_service_token_and_preserves_thread_id(self):
        unauthorized = self.client.post("/v1/chat", json={"message": "1+1"})
        self.assertEqual(unauthorized.status_code, 401)

        response = self.client.post(
            "/v1/chat",
            headers={"authorization": "Bearer service-secret"},
            json={"threadId": "session-1", "message": "1+1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["answer"], "2")
        self.assertEqual(self.graph.payload["threadId"], "session-1")

    def test_respond_returns_structured_completion(self):
        response = self.client.post(
            "/v1/respond",
            headers={"authorization": "Bearer service-secret"},
            json={"threadId": "session-1", "intent": "读取插件目录"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "answered")

    def test_agent_loop_endpoint_requires_token_and_returns_decision_envelope(self):
        payload = {
            "message": "List plugin jars", "systemPrompt": "Operate safely.", "history": [], "instance": {"id": "instance-1"},
            "toolCatalog": [{"name": "files.list", "description": "List files.", "input_schema": {"type": "object", "additionalProperties": False, "properties": {"path": {"type": "string"}}, "required": ["path"]}}],
            "observations": [], "round": 1, "limits": {"maxRounds": 8, "maxToolCalls": 19},
        }
        self.assertEqual(self.client.post("/v1/agent-loop/decide", json=payload).status_code, 401)
        response = self.client.post("/v1/agent-loop/decide", headers={"authorization": "Bearer service-secret"}, json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["decision"]["tool"], "files.list")
        self.assertTrue(response.json()["requestId"].startswith("agent-loop-"))
        self.assertEqual(self.graph.payload["message"], "List plugin jars")

    def test_intent_compile_requires_token_and_preserves_attempt(self):
        catalog = {"schema_version": "intent-source-catalog/v1", "source_digest": "a" * 64, "digest": "b" * 64, "refs": []}
        unauthorized = self.client.post("/v1/intent/compile", json={"sourceCatalog": catalog, "attempt": 1})
        self.assertEqual(unauthorized.status_code, 401)
        response = self.client.post(
            "/v1/intent/compile", headers={"authorization": "Bearer service-secret"},
            json={"sourceCatalog": catalog, "attempt": 2, "validationErrors": [{"code": "SPAN_MISMATCH"}]},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["requestId"], "intent-test")
        self.assertEqual(self.graph.payload["attempt"], 2)

    def test_intent_compile_maps_provider_timeout_to_stable_504(self):
        with patch.object(app_module, "current_graph", return_value=TimeoutGraph()):
            response = self.client.post(
                "/v1/intent/compile", headers={"authorization": "Bearer service-secret"},
                json={"sourceCatalog": {"schema_version": "intent-source-catalog/v1", "source_digest": "a" * 64, "digest": "b" * 64, "refs": []}, "attempt": 1},
            )
        self.assertEqual(response.status_code, 504)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "INTENT_COMPILER_PROVIDER_TIMEOUT")
        self.assertEqual(detail["httpStatus"], 504)
        self.assertEqual(detail["provider"], "test")
        self.assertEqual(detail["compilerMetrics"]["mode"], "json_only")
        self.assertNotIn("prompt", detail["compilerMetrics"])

    def test_confirmed_write_proposal_requires_token_and_allows_only_compact_console_tool(self):
        unauthorized = self.client.post("/v1/confirmed-write/propose", json={"intent": "set weather", "allowedTools": ["console.command"]})
        self.assertEqual(unauthorized.status_code, 401)
        response = self.client.post("/v1/confirmed-write/propose", headers={"authorization": "Bearer service-secret"}, json={"intent": "set weather", "allowedTools": ["console.command"], "instanceContext": {"name": "Realm"}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["proposal"]["parameters"]["command"], "weather clear")
        self.assertEqual(response.json()["proposalMetrics"]["terminal_code"], "WRITE_PROPOSAL_OK")
        self.assertNotIn("instance_id", self.graph.payload.get("instanceContext", {}))
        rejected = self.client.post("/v1/confirmed-write/propose", headers={"authorization": "Bearer service-secret"}, json={"intent": "set weather", "allowedTools": ["shell.exec"]})
        self.assertEqual(rejected.status_code, 400)


if __name__ == "__main__":
    unittest.main()
