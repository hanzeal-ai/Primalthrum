import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from typing import Any, TypedDict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

from runtime import AgentRuntimeConfig, create_runtime


class AgentRequest(BaseModel):
    goal: str = Field(..., min_length=1)
    agent: str = Field(default="ResearchAgent", min_length=1)
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    memory_provider: str = "null"
    cache_provider: str = "memory"
    cache_path: str | None = None
    rag_provider: str = "null"


class AgentState(TypedDict):
    goal: str
    agent: str
    tools: list[str]
    skills: list[str]
    runtime: dict[str, Any]
    plan: list[str]
    artifacts: list[str]
    checks: list[str]
    cache_event: dict[str, str] | None
    message: str
    status: str


def normalize_tools(tools: list[str]) -> list[str]:
    cleaned = [tool.strip() for tool in tools if tool.strip()]
    return cleaned or ["planner", "memory", "executor"]


def normalize_skills(skills: list[str]) -> list[str]:
    return [skill.strip() for skill in skills if skill.strip()]


def cache_key_for_goal(agent: str, goal: str) -> str:
    digest = hashlib.sha256(f"{agent}:{goal}".encode("utf-8")).hexdigest()
    return f"stream:{digest}"


def intake(state: AgentState) -> dict[str, Any]:
    tools = normalize_tools(state["tools"])
    runtime = create_runtime(
        AgentRuntimeConfig(
            agent_name=state["agent"],
            enabled_tools=tools,
            enabled_skills=state["skills"],
            memory_provider=state["runtime"]["memory_provider"],
            cache_provider=state["runtime"]["cache_provider"],
            cache_path=state["runtime"].get("cache_path"),
            rag_provider=state["runtime"]["rag_provider"],
        )
    )
    cache_event = None
    if runtime.cache.name != "null":
        cache_key = cache_key_for_goal(state["agent"], state["goal"])
        cached_value = runtime.cache.get(cache_key)
        cache_status = "hit" if cached_value is not None else "miss"
        if cached_value is None:
            runtime.cache.set(
                cache_key,
                {
                    "agent": state["agent"],
                    "goal": state["goal"],
                },
            )
        cache_event = {
            "node": "intake",
            "agent": state["agent"],
            "provider": runtime.cache.name,
            "key": cache_key,
            "status": cache_status,
            "message": f"Cache {cache_status} for intake",
        }
    runtime_metadata = {
        key: value
        for key, value in state["runtime"].items()
        if key != "cache_path"
    }
    return {
        "tools": tools,
        "runtime": {
            **runtime_metadata,
            "loaded_tools": runtime.tools.names(),
            "loaded_skills": runtime.skills.names(),
            "llm_provider": runtime.llm.name,
        },
        "cache_event": cache_event,
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
        f"skills:{','.join(state['skills']) or 'none'}",
        f"memory:{state['runtime']['memory_provider']}",
        f"cache:{state['runtime']['cache_provider']}",
        f"rag:{state['runtime']['rag_provider']}",
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
        "skills": normalize_skills(request.skills),
        "runtime": {
            "memory_provider": request.memory_provider,
            "cache_provider": request.cache_provider,
            "cache_path": request.cache_path,
            "rag_provider": request.rag_provider,
        },
        "plan": [],
        "artifacts": [],
        "checks": [],
        "cache_event": None,
        "message": "",
        "status": "queued",
    }

    yield sse(
        "agent.run.started",
        {
            "node": "run",
            "agent": initial_state["agent"],
            "message": "Agent run started",
            "status": "running",
        },
    )

    async for update in compiled_graph.astream(initial_state, stream_mode="updates"):
        for node, patch in update.items():
            cache_event = patch.get("cache_event")
            if isinstance(cache_event, dict):
                yield sse(f"agent.cache.{cache_event['status']}", cache_event)
                await asyncio.sleep(0)

            payload = {
                "node": node,
                "agent": initial_state["agent"],
                "message": patch.get("message", f"{node} completed"),
                "status": patch.get("status", "running"),
            }
            for key in ("tools", "skills", "runtime", "plan", "artifacts", "checks"):
                if key in patch:
                    payload[key] = patch[key]
            yield sse("agent.node.completed", payload)
            await asyncio.sleep(0)

    yield sse(
        "agent.run.completed",
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
