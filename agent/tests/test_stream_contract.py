import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from main import app


def sse_payloads(body: str) -> list[dict]:
    payloads: list[dict] = []
    for line in body.splitlines():
        if line.startswith("data: "):
            payloads.append(json.loads(line.removeprefix("data: ")))
    return payloads


def sse_event_names(body: str) -> list[str]:
    events: list[str] = []
    for line in body.splitlines():
        if line.startswith("event: "):
            events.append(line.removeprefix("event: "))
    return events


def sse_messages(body: str) -> list[tuple[str, dict]]:
    messages: list[tuple[str, dict]] = []
    for block in body.strip().split("\n\n"):
        event = ""
        payload: dict | None = None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line.removeprefix("event: ")
            if line.startswith("data: "):
                payload = json.loads(line.removeprefix("data: "))
        if event and payload is not None:
            messages.append((event, payload))
    return messages


class StreamContractTest(unittest.TestCase):
    def test_health_and_readiness_endpoints_expose_runtime_status(self) -> None:
        client = TestClient(app)

        health_response = client.get("/health")
        self.assertEqual(health_response.status_code, 200)
        self.assertEqual(health_response.json()["status"], "ok")

        readiness_response = client.get("/ready")
        self.assertEqual(readiness_response.status_code, 200)
        readiness = readiness_response.json()
        self.assertEqual(readiness["status"], "ready")
        self.assertEqual(readiness["service"], "agent")
        self.assertIn("checks", readiness)
        self.assertTrue(
            any(check["name"] == "runtime_registry" for check in readiness["checks"])
        )

        capabilities_response = client.get("/capabilities")
        self.assertEqual(capabilities_response.status_code, 200)
        catalog = capabilities_response.json()
        self.assertEqual(catalog["schemaVersion"], "1.0")
        self.assertTrue(
            any(
                item["kind"] == "tool" and item["name"] == "file_reader"
                for item in catalog["capabilities"]
            )
        )

    def test_stream_endpoint_emits_canonical_agent_events(self) -> None:
        client = TestClient(app)

        response = client.post(
            "/stream",
            json={
                "goal": "Create a research agent",
                "agent": "ResearchAgent",
                "tools": ["file_reader"],
                "context": "The launch guide requires source citations.",
                "sources": [{"title": "launch-guide.md", "documentId": 7}],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertNotIn("event: agent.update", response.text)
        self.assertNotIn("event: agent.done", response.text)

        events = sse_event_names(response.text)
        self.assertEqual(events[0], "agent.run.started")
        self.assertIn("agent.node.completed", events)
        self.assertIn("agent.rag.retrieved", events)
        self.assertIn("message.delta", events)
        self.assertIn("agent.usage.reported", events)
        self.assertIn("message.completed", events)
        self.assertEqual(events[-1], "agent.run.completed")

        messages = sse_messages(response.text)
        deltas = [
            payload["delta"]
            for event, payload in messages
            if event == "message.delta"
        ]
        self.assertGreater(len(deltas), 1)
        self.assertEqual(
            "".join(deltas),
            "mock response: Create a research agent",
        )
        completed = next(
            payload for event, payload in messages if event == "message.completed"
        )
        self.assertEqual(
            completed["sources"],
            [{"title": "launch-guide.md", "documentId": 7}],
        )
        usage = next(
            payload for event, payload in messages
            if event == "agent.usage.reported"
        )
        self.assertEqual(usage["provider"], "mock")
        self.assertGreater(usage["inputTokens"], 0)
        self.assertGreater(usage["outputTokens"], 0)
        runtime_event = next(
            payload for event, payload in messages
            if event == "agent.node.completed" and payload["node"] == "intake"
        )
        self.assertEqual(runtime_event["runtime"]["llm_provider"], "mock")
        self.assertNotIn("api_key", json.dumps(runtime_event))

        payloads = sse_payloads(response.text)
        self.assertGreaterEqual(len(payloads), 5)
        self.assertEqual(payloads[0]["node"], "run")
        self.assertEqual(payloads[0]["status"], "running")
        self.assertEqual(payloads[1]["node"], "retrieve")
        self.assertEqual(payloads[1]["sourceCount"], 1)
        self.assertEqual(payloads[-1]["status"], "done")
        self.assertEqual(payloads[-1]["agent"], "ResearchAgent")

    def test_internal_embeddings_returns_validated_batch_metadata(self) -> None:
        client = TestClient(app)

        response = client.post(
            "/internal/embeddings",
            json={
                "embedding": {"provider": "mock", "model": "mock-embedding"},
                "texts": ["first chunk", "second chunk"],
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "mock")
        self.assertEqual(body["model"], "mock-embedding")
        self.assertEqual(body["dimensions"], 8)
        self.assertGreater(body["inputTokens"], 0)
        self.assertEqual(len(body["embeddings"]), 2)
        self.assertTrue(all(len(vector) == 8 for vector in body["embeddings"]))

        invalid = client.post(
            "/internal/embeddings",
            json={"texts": ["valid", "   "]},
        )
        self.assertEqual(invalid.status_code, 400)

    def test_stream_emits_cache_miss_then_hit_for_sqlite_cache(self) -> None:
        client = TestClient(app)

        with TemporaryDirectory() as temp_dir:
            cache_path = str(Path(temp_dir) / "cache.sqlite3")
            payload = {
                "goal": "Cache this graph plan",
                "agent": "ResearchAgent",
                "cache_provider": "sqlite",
                "cache_path": cache_path,
            }

            first_response = client.post("/stream", json=payload)
            second_response = client.post("/stream", json=payload)

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)

        first_cache_events = [
            message for message in sse_messages(first_response.text)
            if message[0].startswith("agent.cache.")
        ]
        second_cache_events = [
            message for message in sse_messages(second_response.text)
            if message[0].startswith("agent.cache.")
        ]

        self.assertEqual(first_cache_events[0][0], "agent.cache.miss")
        self.assertEqual(first_cache_events[0][1]["status"], "miss")
        self.assertEqual(first_cache_events[0][1]["provider"], "sqlite")
        self.assertEqual(second_cache_events[0][0], "agent.cache.hit")
        self.assertEqual(second_cache_events[0][1]["status"], "hit")
        self.assertEqual(second_cache_events[0][1]["provider"], "sqlite")


if __name__ == "__main__":
    unittest.main()
