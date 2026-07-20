import json
import unittest

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


class StreamContractTest(unittest.TestCase):
    def test_stream_endpoint_emits_canonical_agent_events(self) -> None:
        client = TestClient(app)

        response = client.post(
            "/stream",
            json={
                "goal": "Create a research agent",
                "agent": "ResearchAgent",
                "tools": ["search", "files"],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertNotIn("event: agent.update", response.text)
        self.assertNotIn("event: agent.done", response.text)

        events = sse_event_names(response.text)
        self.assertEqual(events[0], "agent.run.started")
        self.assertIn("agent.node.completed", events)
        self.assertEqual(events[-1], "agent.run.completed")

        payloads = sse_payloads(response.text)
        self.assertGreaterEqual(len(payloads), 5)
        self.assertEqual(payloads[0]["node"], "run")
        self.assertEqual(payloads[0]["status"], "running")
        self.assertEqual(payloads[1]["node"], "intake")
        self.assertEqual(payloads[-1]["status"], "done")
        self.assertEqual(payloads[-1]["agent"], "ResearchAgent")


if __name__ == "__main__":
    unittest.main()
