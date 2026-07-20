from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


@dataclass(frozen=True)
class ToolManifest:
    name: str
    description: str
    input_schema: dict[str, Any]
    permissions: list[str]
    dangerous: bool


@dataclass(frozen=True)
class ToolPolicy:
    allow_dangerous_tools: bool = False


def is_tool_allowed(manifest: ToolManifest, policy: ToolPolicy) -> bool:
    validate_tool_manifest(manifest)
    return policy.allow_dangerous_tools or not manifest.dangerous


def validate_tool_manifest(manifest: ToolManifest) -> ToolManifest:
    if not manifest.name.strip():
        raise ValueError("tool manifest name is required")
    if not manifest.description.strip():
        raise ValueError("tool manifest description is required")
    if manifest.input_schema.get("type") != "object":
        raise ValueError("tool manifest input_schema must describe an object")
    if not manifest.permissions:
        raise ValueError("tool manifest permissions are required")
    if any(not permission.strip() for permission in manifest.permissions):
        raise ValueError("tool manifest permissions cannot be blank")
    if not isinstance(manifest.dangerous, bool):
        raise ValueError("tool manifest dangerous flag must be a boolean")
    return manifest


def validate_tool_definition(tool: "ToolDefinition") -> "ToolDefinition":
    manifest = validate_tool_manifest(tool.manifest)
    if tool.name != manifest.name:
        raise ValueError("tool name must match manifest name")
    return tool


class ToolDefinition(Protocol):
    name: str
    manifest: ToolManifest

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...


@dataclass
class FileReaderTool:
    name: str = "file_reader"
    allowed_roots: list[str | Path] = field(default_factory=list)
    manifest: ToolManifest = field(
        default_factory=lambda: ToolManifest(
            name="file_reader",
            description="Read a UTF-8 text file from an allowed local path.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or expandable path to a readable file.",
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            permissions=["fs:read"],
            dangerous=False,
        )
    )
    _resolved_roots: list[Path] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._resolved_roots = [
            Path(root).expanduser().resolve()
            for root in self.allowed_roots
        ]

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        path = Path(str(payload.get("path", ""))).expanduser().resolve()
        if not self._is_allowed(path):
            raise PermissionError(f"path is outside allowed roots: {path}")
        if not path.is_file():
            raise FileNotFoundError(str(path))
        return {"path": str(path), "content": path.read_text(encoding="utf-8")}

    def _is_allowed(self, path: Path) -> bool:
        return any(
            path == root or root in path.parents
            for root in self._resolved_roots
        )
