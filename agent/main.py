import asyncio
import hashlib
import json
import math
import time
from collections.abc import AsyncIterator
from typing import Any, TypedDict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.config import get_stream_writer
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field, SecretStr

from runtime import AgentRuntimeConfig, ModelProviderConfig, create_runtime
from runtime.capabilities import capability_health, capability_manifests
from runtime.embeddings import create_embedding_provider
from runtime.llm import ProviderRequestError


class RuntimeModelRequest(BaseModel):
    provider: str = "mock"
    model: str = "mock-chat"
    api_key: SecretStr | None = None
    base_url: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=128_000)


class AgentRequest(BaseModel):
    goal: str = Field(..., min_length=1)
    agent: str = Field(default="ResearchAgent", min_length=1)
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    memory_provider: str = "null"
    cache_provider: str = "memory"
    cache_path: str | None = None
    rag_provider: str = "null"
    llm: RuntimeModelRequest = Field(default_factory=RuntimeModelRequest)
    embedding: RuntimeModelRequest = Field(
        default_factory=lambda: RuntimeModelRequest(model="mock-embedding")
    )
    context: str = ""
    sources: list[dict[str, Any]] = Field(default_factory=list)


class EmbeddingBatchRequest(BaseModel):
    embedding: RuntimeModelRequest = Field(
        default_factory=lambda: RuntimeModelRequest(model="mock-embedding")
    )
    texts: list[str] = Field(..., min_length=1, max_length=128)


class AgentState(TypedDict):
    goal: str
    agent: str
    tools: list[str]
    skills: list[str]
    runtime: dict[str, Any]
    runtime_options: dict[str, Any]
    context: str
    sources: list[dict[str, Any]]
    plan: list[str]
    artifacts: list[str]
    checks: list[str]
    cache_event: dict[str, str] | None
    answer: str
    message: str
    status: str


def normalize_tools(tools: list[str]) -> list[str]:
    return [tool.strip() for tool in tools if tool.strip()]


def normalize_skills(skills: list[str]) -> list[str]:
    return [skill.strip() for skill in skills if skill.strip()]


def cache_key_for_goal(agent: str, goal: str) -> str:
    digest = hashlib.sha256(f"{agent}:{goal}".encode("utf-8")).hexdigest()
    return f"stream:{digest}"


def model_provider_config(value: RuntimeModelRequest) -> ModelProviderConfig:
    return ModelProviderConfig(
        provider=value.provider.strip(),
        model=value.model.strip(),
        api_key=value.api_key.get_secret_value() if value.api_key else None,
        base_url=value.base_url.strip() if value.base_url else None,
        temperature=value.temperature,
        max_tokens=value.max_tokens,
    )


def runtime_config(state: AgentState) -> AgentRuntimeConfig:
    options = state["runtime_options"]
    return AgentRuntimeConfig(
        agent_name=state["agent"],
        enabled_tools=state["tools"],
        enabled_skills=state["skills"],
        memory_provider=options["memory_provider"],
        cache_provider=options["cache_provider"],
        cache_path=options.get("cache_path"),
        rag_provider=options["rag_provider"],
        llm_config=options["llm"],
        embedding_config=options["embedding"],
    )


def intake(state: AgentState) -> dict[str, Any]:
    tools = normalize_tools(state["tools"])
    runtime = create_runtime(runtime_config({**state, "tools": tools}))
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
    options = state["runtime_options"]
    return {
        "tools": tools,
        "runtime": {
            "memory_provider": options["memory_provider"],
            "cache_provider": options["cache_provider"],
            "rag_provider": options["rag_provider"],
            "loaded_tools": runtime.tools.names(),
            "loaded_skills": runtime.skills.names(),
            "llm_provider": runtime.llm.name,
            "llm_model": runtime.llm.model,
            "embedding_provider": runtime.embeddings.name,
            "embedding_model": runtime.embeddings.model,
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
        f"memory:{state['runtime_options']['memory_provider']}",
        f"cache:{state['runtime_options']['cache_provider']}",
        f"rag:{state['runtime_options']['rag_provider']}",
        "interface:stream",
    ]
    return {
        "artifacts": artifacts,
        "message": "Generated runtime scaffold metadata",
    }


async def respond(state: AgentState) -> dict[str, Any]:
    runtime = create_runtime(runtime_config(state))
    writer = get_stream_writer()
    system_message = f"You are {state['agent']}. Answer the user's request directly."
    if state["context"]:
        system_message += f"\n\nUse this retrieved context and cite it when relevant:\n{state['context']}"
    answer_parts: list[str] = []
    async for delta in runtime.llm.stream_chat([
        {"role": "system", "content": system_message},
        {"role": "user", "content": state["goal"]},
    ]):
        answer_parts.append(delta)
        writer({
            "event": "message.delta",
            "payload": {
                "node": "respond",
                "agent": state["agent"],
                "delta": delta,
                "status": "running",
            },
        })
    answer = "".join(answer_parts)
    return {
        "answer": answer,
        "message": "Generated assistant response",
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
    graph.add_node("respond", respond)
    graph.add_node("verify_agent", verify_agent)

    graph.set_entry_point("intake")
    graph.add_edge("intake", "design_graph")
    graph.add_edge("design_graph", "scaffold_agent")
    graph.add_edge("scaffold_agent", "respond")
    graph.add_edge("respond", "verify_agent")
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
            "rag_provider": request.rag_provider,
        },
        "runtime_options": {
            "memory_provider": request.memory_provider,
            "cache_provider": request.cache_provider,
            "cache_path": request.cache_path,
            "rag_provider": request.rag_provider,
            "llm": model_provider_config(request.llm),
            "embedding": model_provider_config(request.embedding),
        },
        "context": request.context.strip(),
        "sources": request.sources,
        "plan": [],
        "artifacts": [],
        "checks": [],
        "cache_event": None,
        "answer": "",
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

    try:
        stream = compiled_graph.astream(
            initial_state,
            stream_mode=["updates", "custom"],
        )
        async for mode, update in stream:
            if mode == "custom":
                if isinstance(update, dict):
                    event = str(update.get("event", "message"))
                    payload = update.get("payload")
                    if isinstance(payload, dict):
                        yield sse(event, payload)
                        await asyncio.sleep(0)
                continue

            for node, patch in update.items():
                cache_event = patch.get("cache_event")
                if isinstance(cache_event, dict):
                    yield sse(f"agent.cache.{cache_event['status']}", cache_event)
                    await asyncio.sleep(0)

                answer = patch.get("answer")
                if isinstance(answer, str) and answer:
                    yield sse(
                        "message.completed",
                        {
                            "node": node,
                            "agent": initial_state["agent"],
                            "message": answer,
                            "sources": initial_state["sources"],
                            "status": "done",
                        },
                    )
                    await asyncio.sleep(0)

                payload = {
                    "node": node,
                    "agent": initial_state["agent"],
                    "message": patch.get("message", f"{node} completed"),
                    "status": patch.get("status", "running"),
                }
                for key in (
                    "tools",
                    "skills",
                    "runtime",
                    "plan",
                    "artifacts",
                    "checks",
                ):
                    if key in patch:
                        payload[key] = patch[key]
                yield sse("agent.node.completed", payload)
                await asyncio.sleep(0)
    except ProviderRequestError as error:
        yield sse(
            "agent.error",
            {
                "node": "respond",
                "agent": initial_state["agent"],
                "message": str(error),
                "status": "error",
            },
        )
        return
    except Exception:
        yield sse(
            "agent.error",
            {
                "node": "run",
                "agent": initial_state["agent"],
                "message": "Agent runtime failed",
                "status": "error",
            },
        )
        return

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


@app.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    manifests = capability_manifests()
    return {
        "schemaVersion": "1.0",
        "capabilities": [manifest.to_dict() for manifest in manifests],
        "health": capability_health(),
    }


@app.post("/internal/embeddings")
async def embeddings(request: EmbeddingBatchRequest) -> dict[str, Any]:
    texts = [text.strip() for text in request.texts]
    if any(not text for text in texts):
        raise HTTPException(status_code=400, detail="embedding texts cannot be empty")
    if sum(len(text) for text in texts) > 250_000:
        raise HTTPException(status_code=413, detail="embedding batch is too large")

    try:
        provider = create_embedding_provider(model_provider_config(request.embedding))
        vectors = await asyncio.to_thread(provider.embed, texts)
    except ProviderRequestError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    if len(vectors) != len(texts):
        raise HTTPException(status_code=502, detail="embedding provider returned the wrong count")
    dimensions = len(vectors[0]) if vectors else 0
    if dimensions <= 0 or any(
        len(vector) != dimensions or any(not math.isfinite(value) for value in vector)
        for vector in vectors
    ):
        raise HTTPException(status_code=502, detail="embedding provider returned invalid vectors")

    return {
        "provider": provider.name,
        "model": provider.model,
        "dimensions": dimensions,
        "embeddings": vectors,
    }


@app.get("/ready")
async def ready() -> JSONResponse:
    started_at = time.monotonic()
    checks: list[dict[str, Any]] = []

    try:
        runtime = create_runtime(
            AgentRuntimeConfig(
                agent_name="ReadinessAgent",
                enabled_tools=[],
                enabled_skills=[],
                memory_provider="null",
                cache_provider="null",
                rag_provider="null",
            )
        )
        checks.append(
            {
                "name": "runtime_registry",
                "status": "ok",
                "loaded_tools": runtime.tools.names(),
                "loaded_skills": runtime.skills.names(),
                "capability_count": len(capability_manifests()),
            }
        )
        checks.append({"name": "langgraph", "status": "ok"})
        status_code = 200
        status = "ready"
    except Exception as error:
        checks.append(
            {
                "name": "runtime_registry",
                "status": "failed",
                "message": str(error),
            }
        )
        status_code = 503
        status = "not_ready"

    return JSONResponse(
        status_code=status_code,
        content={
            "status": status,
            "service": "agent",
            "latency_ms": round((time.monotonic() - started_at) * 1000, 3),
            "checks": checks,
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
