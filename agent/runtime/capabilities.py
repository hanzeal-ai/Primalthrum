from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from .skills import load_skill_packages
from .tools import FileReaderTool, validate_tool_definition

CapabilityKind = Literal[
    "llm", "embedding", "stt", "tts", "tool", "skill", "memory", "cache", "rag"
]
CapabilityStatus = Literal["available", "planned"]


@dataclass(frozen=True)
class CapabilityManifest:
    kind: CapabilityKind
    name: str
    version: str
    description: str
    status: CapabilityStatus = "available"
    hot_pluggable: bool = True
    config_schema: dict[str, Any] = field(
        default_factory=lambda: {"type": "object", "additionalProperties": False}
    )
    permissions: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.kind}:{self.name}"

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["hotPluggable"] = payload.pop("hot_pluggable")
        payload["configSchema"] = payload.pop("config_schema")
        return payload


def capability_manifests() -> list[CapabilityManifest]:
    manifests = [
        *_model_manifests(),
        *_storage_manifests(),
        *_tool_manifests(),
        *_skill_manifests(),
        CapabilityManifest(
            "stt", "openai", "1.0.0", "OpenAI-compatible speech-to-text adapter.", status="planned"
        ),
        CapabilityManifest(
            "tts", "openai", "1.0.0", "OpenAI-compatible text-to-speech adapter.", status="planned"
        ),
    ]
    validate_capability_manifests(manifests)
    return sorted(manifests, key=lambda item: (item.kind, item.name))


def capability_health() -> list[dict[str, str]]:
    return [
        {
            "key": manifest.key,
            "status": "ok" if manifest.status == "available" else "planned",
        }
        for manifest in capability_manifests()
    ]


def validate_capability_manifests(
    manifests: list[CapabilityManifest],
) -> list[CapabilityManifest]:
    keys: set[str] = set()
    for manifest in manifests:
        if not manifest.name.strip() or not manifest.version.strip():
            raise ValueError("capability name and version are required")
        if not manifest.description.strip():
            raise ValueError(f"capability description is required for {manifest.key}")
        if manifest.config_schema.get("type") != "object":
            raise ValueError(f"capability config schema must be an object: {manifest.key}")
        if manifest.key in keys:
            raise ValueError(f"duplicate capability manifest: {manifest.key}")
        keys.add(manifest.key)

    for manifest in manifests:
        missing = [dependency for dependency in manifest.dependencies if dependency not in keys]
        if missing:
            raise ValueError(
                f"capability {manifest.key} has unknown dependencies: {', '.join(missing)}"
            )
    return manifests


def _model_manifests() -> list[CapabilityManifest]:
    model_schema = {
        "type": "object",
        "properties": {
            "model": {"type": "string"},
            "baseUrl": {"type": "string", "format": "uri"},
        },
        "required": ["model"],
        "additionalProperties": True,
    }
    return [
        CapabilityManifest("llm", "mock", "1.0.0", "Deterministic local chat adapter."),
        CapabilityManifest("llm", "openai", "1.0.0", "OpenAI streaming chat adapter.", config_schema=model_schema),
        CapabilityManifest("llm", "openai-compatible", "1.0.0", "OpenAI-compatible streaming chat adapter.", config_schema=model_schema),
        CapabilityManifest("llm", "anthropic", "1.0.0", "Anthropic Messages streaming adapter.", config_schema=model_schema),
        CapabilityManifest("embedding", "mock", "1.0.0", "Deterministic local embedding adapter."),
        CapabilityManifest("embedding", "openai", "1.0.0", "OpenAI embedding adapter.", config_schema=model_schema),
        CapabilityManifest("embedding", "openai-compatible", "1.0.0", "OpenAI-compatible embedding adapter.", config_schema=model_schema),
    ]


def _storage_manifests() -> list[CapabilityManifest]:
    path_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "additionalProperties": False,
    }
    return [
        CapabilityManifest("memory", "null", "1.0.0", "No-op memory provider."),
        CapabilityManifest("memory", "sqlite", "1.0.0", "SQLite run-summary memory.", config_schema=path_schema),
        CapabilityManifest("cache", "null", "1.0.0", "No-op cache provider."),
        CapabilityManifest("cache", "memory", "1.0.0", "Run-scoped in-process cache."),
        CapabilityManifest("cache", "sqlite", "1.0.0", "Persistent SQLite cache.", config_schema=path_schema),
        CapabilityManifest("rag", "none", "1.0.0", "Retrieval disabled."),
        CapabilityManifest("rag", "sqlite", "1.0.0", "Persistent built-in SQLite vector retrieval provider."),
        CapabilityManifest("rag", "in-memory", "1.0.0", "In-memory vector retrieval provider."),
        CapabilityManifest("rag", "chroma", "1.0.0", "Chroma vector retrieval provider.", status="planned"),
    ]


def _tool_manifests() -> list[CapabilityManifest]:
    tool = validate_tool_definition(FileReaderTool())
    return [
        CapabilityManifest(
            kind="tool",
            name=tool.manifest.name,
            version="1.0.0",
            description=tool.manifest.description,
            config_schema=tool.manifest.input_schema,
            permissions=tool.manifest.permissions,
        )
    ]


def _skill_manifests() -> list[CapabilityManifest]:
    return [
        CapabilityManifest(
            kind="skill",
            name=skill.name,
            version=skill.version,
            description=skill.description,
            dependencies=[f"tool:{tool}" for tool in skill.tools],
        )
        for skill in load_skill_packages().values()
    ]
