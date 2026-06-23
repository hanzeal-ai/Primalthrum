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


class StreamContractTest(unittest.TestCase):
    def test_stream_endpoint_emits_agent_events(self) -> None:
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
        self.assertIn("event: agent.update", response.text)
        self.assertIn("event: agent.done", response.text)

        payloads = sse_payloads(response.text)
        self.assertGreaterEqual(len(payloads), 4)
        self.assertEqual(payloads[0]["node"], "intake")
        self.assertEqual(payloads[-1]["status"], "done")
        self.assertEqual(payloads[-1]["agent"], "ResearchAgent")


if __name__ == "__main__":
    unittest.main()
