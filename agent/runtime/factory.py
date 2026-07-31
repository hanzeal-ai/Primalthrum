from __future__ import annotations

from dataclasses import dataclass

from .cache import CacheProvider, MemoryCache, NullCache, SQLiteCache
from .capabilities import capability_manifests
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
    _validate_runtime_selection(config)
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


def _validate_runtime_selection(config: AgentRuntimeConfig) -> None:
    manifests = {manifest.key: manifest for manifest in capability_manifests()}
    tool_names = config.enabled_tools
    if tool_names is None:
        tool_names = [
            manifest.name for manifest in manifests.values() if manifest.kind == "tool"
        ]
    skill_names = config.enabled_skills
    if skill_names is None:
        skill_names = [
            manifest.name for manifest in manifests.values() if manifest.kind == "skill"
        ]
    selected = {
        _canonical_capability_key("memory", config.memory_provider),
        _canonical_capability_key("cache", config.cache_provider),
        _canonical_capability_key("rag", config.rag_provider),
    }
    selected.update(f"tool:{name}" for name in tool_names)
    selected.update(f"skill:{name}" for name in skill_names)

    for key in selected:
        manifest = manifests.get(key)
        if manifest is None:
            raise ValueError(f"unknown runtime capability: {key}")
        if manifest.status != "available":
            raise ValueError(f"runtime capability is not available: {key}")

    for key in selected:
        manifest = manifests[key]
        missing = [
            dependency
            for dependency in manifest.dependencies
            if dependency not in selected
        ]
        if missing:
            raise ValueError(
                f"runtime capability {key} requires: {', '.join(missing)}"
            )


def _canonical_capability_key(kind: str, name: str) -> str:
    aliases = {
        "memory:none": "memory:null",
        "cache:none": "cache:null",
        "rag:null": "rag:none",
    }
    key = f"{kind}:{name}"
    return aliases.get(key, key)
