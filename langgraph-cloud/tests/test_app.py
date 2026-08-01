from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from mcai_graph import app as app_module


class FakeGraph:
    def __init__(self) -> None:
        self.payload = None

    async def route(self, payload):
        self.payload = payload
        return {"route": "direct", "answer": "2", "requestId": "request-test"}

    async def respond(self, payload):
        self.payload = payload
        return {"status": "answered", "answer": "任务已完成。", "requestId": "response-test"}


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


if __name__ == "__main__":
    unittest.main()
