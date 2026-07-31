from __future__ import annotations

from dataclasses import dataclass

from .cache import CacheProvider, MemoryCache, NullCache, SQLiteCache
from .config import AgentRuntimeConfig, ModelProviderConfig
from .embeddings import EmbeddingProvider, create_embedding_provider
from .llm import LLMProvider, create_llm_provider
from .memory import MemoryProvider, NullMemory, SQLiteMemory
from .rag import InMemoryRagProvider, NullRagProvider, RagProvider
from .registry import Registry
from .skills import SkillDefinition, load_skill_packages
from .tools import (
    FileReaderTool,
    ToolDefinition,
    ToolPolicy,
    is_tool_allowed,
    validate_tool_definition,
)


@dataclass
class AgentRuntime:
    config: AgentRuntimeConfig
    llm: LLMProvider
    embeddings: EmbeddingProvider
    memory: MemoryProvider
    cache: CacheProvider
    rag: RagProvider
    tools: Registry[ToolDefinition]
    skills: Registry[SkillDefinition]


def create_runtime(config: AgentRuntimeConfig) -> AgentRuntime:
    llm_config = config.llm_config or ModelProviderConfig(
        provider=config.llm_provider,
        model="mock-chat",
    )
    embedding_config = config.embedding_config or ModelProviderConfig(
        provider="mock",
        model="mock-embedding",
    )
    llm = create_llm_provider(llm_config)
    embeddings = create_embedding_provider(embedding_config)

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
    tool_policy = ToolPolicy(allow_dangerous_tools=config.allow_dangerous_tools)
    for name, tool in available_tools.items():
        tool = validate_tool_definition(tool)
        if (
            (enabled_tools is None or name in enabled_tools)
            and is_tool_allowed(tool.manifest, tool_policy)
        ):
            tools.register(name, tool)

    skills = Registry[SkillDefinition]()
    available_skills = load_skill_packages()
    enabled_skills = config.enabled_skills
    for name, skill in available_skills.items():
        if enabled_skills is None or name in enabled_skills:
            skills.register(name, skill)

    return AgentRuntime(
        config=config,
        llm=llm,
        embeddings=embeddings,
        memory=memory_registry.get(config.memory_provider),
        cache=cache_registry.get(config.cache_provider),
        rag=rag_registry.get(config.rag_provider),
        tools=tools,
        skills=skills,
    )
