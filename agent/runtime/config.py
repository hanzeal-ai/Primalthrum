from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ModelProviderConfig:
    provider: str = "mock"
    model: str = "mock-chat"
    api_key: str | None = field(default=None, repr=False)
    base_url: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class AgentRuntimeConfig:
    agent_name: str
    llm_provider: str = "mock"
    llm_config: ModelProviderConfig | None = None
    embedding_config: ModelProviderConfig | None = None
    memory_provider: str = "null"
    memory_path: str | None = None
    cache_provider: str = "memory"
    cache_path: str | None = None
    rag_provider: str = "null"
    enabled_tools: list[str] | None = None
    enabled_skills: list[str] | None = None
    allow_dangerous_tools: bool = False
    file_reader_allowed_roots: list[str] | None = None
    model_config: dict[str, Any] = field(default_factory=dict)
