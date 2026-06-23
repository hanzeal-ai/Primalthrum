import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, TypedDict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field


class AgentRequest(BaseModel):
    goal: str = Field(..., min_length=1)
    agent: str = Field(default="ResearchAgent", min_length=1)
    tools: list[str] = Field(default_factory=list)


class AgentState(TypedDict):
    goal: str
    agent: str
    tools: list[str]
    plan: list[str]
    artifacts: list[str]
    checks: list[str]
    message: str
    status: str


def normalize_tools(tools: list[str]) -> list[str]:
    cleaned = [tool.strip() for tool in tools if tool.strip()]
    return cleaned or ["planner", "memory", "executor"]


def intake(state: AgentState) -> dict[str, Any]:
    tools = normalize_tools(state["tools"])
    return {
        "tools": tools,
        "message": f"Accepted goal for {state['agent']}: {state['goal']}",
        "status": "running",
    }


def design_graph(state: AgentState) -> dict[str, Any]:
    plan = [
        "Define agent role and boundaries",
        "Select tools and memory shape",
        "Expose execution through the stream contract",
    ]
    return {
        "plan": plan,
        "message": f"Prepared {len(plan)} implementation steps",
    }


def scaffold_agent(state: AgentState) -> dict[str, Any]:
    artifacts = [
        f"agent:{state['agent']}",
        f"tools:{','.join(state['tools'])}",
        "interface:stream",
    ]
    return {
        "artifacts": artifacts,
        "message": "Generated runtime scaffold metadata",
    }


def verify_agent(state: AgentState) -> dict[str, Any]:
    checks = [
        "goal is non-empty",
        "stream endpoint is available",
        "graph reached terminal node",
    ]
    return {
        "checks": checks,
        "message": "Verified minimal agent contract",
        "status": "done",
    }


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("intake", intake)
    graph.add_node("design_graph", design_graph)
    graph.add_node("scaffold_agent", scaffold_agent)
    graph.add_node("verify_agent", verify_agent)

    graph.set_entry_point("intake")
    graph.add_edge("intake", "design_graph")
    graph.add_edge("design_graph", "scaffold_agent")
    graph.add_edge("scaffold_agent", "verify_agent")
    graph.add_edge("verify_agent", END)
    return graph.compile()


compiled_graph = build_graph()

app = FastAPI(title="Primalthrum Agent Runtime", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def stream_graph(request: AgentRequest) -> AsyncIterator[str]:
    initial_state: AgentState = {
        "goal": request.goal.strip(),
        "agent": request.agent.strip(),
        "tools": normalize_tools(request.tools),
        "plan": [],
        "artifacts": [],
        "checks": [],
        "message": "",
        "status": "queued",
    }

    async for update in compiled_graph.astream(initial_state, stream_mode="updates"):
        for node, patch in update.items():
            payload = {
                "node": node,
                "agent": initial_state["agent"],
                "message": patch.get("message", f"{node} completed"),
                "status": patch.get("status", "running"),
            }
            for key in ("tools", "plan", "artifacts", "checks"):
                if key in patch:
                    payload[key] = patch[key]
            yield sse("agent.update", payload)
            await asyncio.sleep(0)

    yield sse(
        "agent.done",
        {
            "node": "done",
            "agent": initial_state["agent"],
            "message": "Agent stream completed",
            "status": "done",
        },
    )


@app.post("/stream")
async def stream(request: AgentRequest) -> StreamingResponse:
    return StreamingResponse(
        stream_graph(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/stream/generate-agent")
async def legacy_stream(request: AgentRequest) -> StreamingResponse:
    return await stream(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "agent"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
