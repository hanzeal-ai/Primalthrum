from __future__ import annotations

from dataclasses import dataclass

from .cache import CacheProvider, MemoryCache, NullCache, SQLiteCache
from .config import AgentRuntimeConfig
from .llm import LLMProvider, MockLLMProvider
from .memory import MemoryProvider, NullMemory, SQLiteMemory
from .rag import InMemoryRagProvider, NullRagProvider, RagProvider
from .registry import Registry
from .skills import SkillDefinition
from .tools import FileReaderTool, ToolDefinition, validate_tool_definition


@dataclass
class AgentRuntime:
    config: AgentRuntimeConfig
    llm: LLMProvider
    memory: MemoryProvider
    cache: CacheProvider
    rag: RagProvider
    tools: Registry[ToolDefinition]
    skills: Registry[SkillDefinition]


def create_runtime(config: AgentRuntimeConfig) -> AgentRuntime:
    llm_registry = Registry[LLMProvider]()
    llm_registry.register("mock", MockLLMProvider())

    memory_registry = Registry[MemoryProvider]()
    memory_registry.register("null", NullMemory())
    memory_registry.register("none", NullMemory())
    if config.memory_provider == "sqlite":
        memory_registry.register("sqlite", SQLiteMemory(config.memory_path))

    cache_registry = Registry[CacheProvider]()
    cache_registry.register("null", NullCache())
    cache_registry.register("none", NullCache())
    cache_registry.register("memory", MemoryCache())
    if config.cache_provider == "sqlite":
        cache_registry.register("sqlite", SQLiteCache(config.cache_path))

    rag_registry = Registry[RagProvider]()
    rag_registry.register("null", NullRagProvider())
    rag_registry.register("none", NullRagProvider())
    rag_registry.register("in-memory", InMemoryRagProvider())

    tools = Registry[ToolDefinition]()
    available_tools = {
        "file_reader": FileReaderTool(
            allowed_roots=config.file_reader_allowed_roots or []
        ),
    }
    enabled_tools = config.enabled_tools
    for name, tool in available_tools.items():
        if enabled_tools is None or name in enabled_tools:
            tools.register(name, validate_tool_definition(tool))

    skills = Registry[SkillDefinition]()
    available_skills = {
        "research": SkillDefinition(
            name="research",
            version="0.1.0",
            tools=["file_reader"],
            instructions="Plan, retrieve evidence, act with tools, and summarize.",
        )
    }
    enabled_skills = config.enabled_skills
    for name, skill in available_skills.items():
        if enabled_skills is None or name in enabled_skills:
            skills.register(name, skill)

    return AgentRuntime(
        config=config,
        llm=llm_registry.get(config.llm_provider),
        memory=memory_registry.get(config.memory_provider),
        cache=cache_registry.get(config.cache_provider),
        rag=rag_registry.get(config.rag_provider),
        tools=tools,
        skills=skills,
    )
