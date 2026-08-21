import type { TemplateFile } from './templateTypes';

export function runtimeTemplates(): TemplateFile[] {
  return [
    {
      path: 'src/main.py',
      content: `from __future__ import annotations

import sys

from .runner import run_agent


def main() -> None:
    task = sys.argv[1] if len(sys.argv) > 1 else "Run the demo task"
    print(run_agent(task))


if __name__ == "__main__":
    main()
`,
    },
    {
      path: 'src/runner.py',
      content: `from __future__ import annotations

from .graph import build_graph


def run_agent(task: str) -> str:
    result = build_graph().invoke({"task": task, "events": []})
    return result["answer"]
`,
    },
    {
      path: 'src/app.py',
      content: `from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import load_config
from .runner import run_agent


WEB_DIRECTORY = Path(__file__).with_name("web")

app = FastAPI(title="Primalthrum Agent")
app.mount("/assets", StaticFiles(directory=WEB_DIRECTORY), name="assets")


class StreamRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


def encode_event(event: str, payload: dict[str, object]) -> str:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\\ndata: {data}\\n\\n"


def message_chunks(message: str, size: int = 24) -> Iterator[str]:
    for start in range(0, len(message), size):
        yield message[start:start + size]


async def stream_agent(message: str) -> AsyncIterator[str]:
    yield encode_event("agent.run.started", {"status": "running"})
    try:
        answer = await asyncio.to_thread(run_agent, message)
        for chunk in message_chunks(answer):
            yield encode_event("message.delta", {"delta": chunk})
            await asyncio.sleep(0)
        yield encode_event("message.completed", {"content": answer})
        yield encode_event("agent.run.completed", {"status": "done"})
    except Exception:
        yield encode_event(
            "agent.run.failed",
            {"status": "failed", "message": "The Agent could not complete this request."},
        )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIRECTORY / "index.html")


@app.get("/api/agent")
async def agent_metadata() -> dict[str, object]:
    return load_config()["agent"]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "generated-agent"}


@app.post("/stream")
async def stream(request: StreamRequest) -> StreamingResponse:
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message cannot be empty")
    return StreamingResponse(
        stream_agent(message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
`,
    },
    {
      path: 'src/graph.py',
      content: `from __future__ import annotations

from typing import TypedDict

from langgraph.graph import END, StateGraph

from .nodes.act_with_tools import act_with_tools
from .nodes.finalize import finalize
from .nodes.load_context import load_context
from .nodes.plan import plan
from .nodes.retrieve_optional_rag import retrieve_optional_rag
from .nodes.update_memory import update_memory


class AgentState(TypedDict):
    task: str
    events: list[str]
    answer: str


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("load_context", load_context)
    graph.add_node("plan", plan)
    graph.add_node("retrieve_optional_rag", retrieve_optional_rag)
    graph.add_node("act_with_tools", act_with_tools)
    graph.add_node("update_memory", update_memory)
    graph.add_node("finalize", finalize)
    graph.set_entry_point("load_context")
    graph.add_edge("load_context", "plan")
    graph.add_edge("plan", "retrieve_optional_rag")
    graph.add_edge("retrieve_optional_rag", "act_with_tools")
    graph.add_edge("act_with_tools", "update_memory")
    graph.add_edge("update_memory", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()
`,
    },
    ...nodeTemplates(),
    ...packageTemplates(),
    ...testTemplates(),
  ];
}

function nodeTemplates(): TemplateFile[] {
  return [
    {
      path: 'src/nodes/__init__.py',
      content: '',
    },
    {
      path: 'src/nodes/load_context.py',
      content: `from __future__ import annotations


def load_context(state: dict) -> dict:
    return {"events": state["events"] + ["load_context"]}
`,
    },
    {
      path: 'src/nodes/plan.py',
      content: `from __future__ import annotations


def plan(state: dict) -> dict:
    return {"events": state["events"] + ["plan"]}
`,
    },
    {
      path: 'src/nodes/retrieve_optional_rag.py',
      content: `from __future__ import annotations

from ..config import load_config


def retrieve_optional_rag(state: dict) -> dict:
    config = load_config()
    rag_provider = config["runtime"].get("ragProvider", "none")
    event = "rag_skipped" if rag_provider in {"none", "null"} else "rag_retrieved"
    return {"events": state["events"] + [event]}
`,
    },
    {
      path: 'src/nodes/act_with_tools.py',
      content: `from __future__ import annotations

from ..config import load_config


def act_with_tools(state: dict) -> dict:
    config = load_config()
    tools = ", ".join(config["runtime"].get("enabledTools", [])) or "no tools"
    answer = f"Planned task: {state['task']} with {tools}."
    return {"events": state["events"] + ["act_with_tools"], "answer": answer}
`,
    },
    {
      path: 'src/nodes/update_memory.py',
      content: `from __future__ import annotations


def update_memory(state: dict) -> dict:
    return {"events": state["events"] + ["update_memory"]}
`,
    },
    {
      path: 'src/nodes/finalize.py',
      content: `from __future__ import annotations


def finalize(state: dict) -> dict:
    return {"events": state["events"] + ["finalize"]}
`,
    },
  ];
}

function packageTemplates(): TemplateFile[] {
  return ['providers', 'tools', 'skills', 'rag', 'memory', 'cache'].map((name) => ({
    path: `src/${name}/__init__.py`,
    content: '',
  }));
}

function testTemplates(): TemplateFile[] {
  return [
    {
      path: 'tests/__init__.py',
      content: '',
    },
    {
      path: 'tests/test_demo.py',
      content: `import unittest

from src.graph import build_graph


class DemoGraphTest(unittest.TestCase):
    def test_demo_graph_runs(self) -> None:
        graph = build_graph()
        result = graph.invoke({"task": "demo", "events": []})
        self.assertIn("answer", result)
        self.assertIn("rag_skipped", result["events"])


if __name__ == "__main__":
    unittest.main()
`,
    },
    {
      path: 'tests/test_web_app.py',
      content: `import unittest

from fastapi.testclient import TestClient

from src.app import app


class WebAppTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_page_and_metadata_are_available(self) -> None:
        page = self.client.get("/")
        metadata = self.client.get("/api/agent")

        self.assertEqual(page.status_code, 200)
        self.assertIn("agent-composer", page.text)
        self.assertEqual(metadata.status_code, 200)
        self.assertTrue(metadata.json()["name"])

    def test_stream_returns_canonical_events(self) -> None:
        response = self.client.post("/stream", json={"message": "Web task"})

        self.assertEqual(response.status_code, 200)
        self.assertIn("event: agent.run.started", response.text)
        self.assertIn("event: message.delta", response.text)
        self.assertIn("Planned task: Web task", response.text)
        self.assertIn("event: agent.run.completed", response.text)

        invalid = self.client.post("/stream", json={"message": "   "})
        self.assertEqual(invalid.status_code, 400)


if __name__ == "__main__":
    unittest.main()
`,
    },
  ];
}
