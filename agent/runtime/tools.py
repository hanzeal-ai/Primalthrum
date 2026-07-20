from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


class ToolDefinition(Protocol):
    name: str
    permissions: list[str]
    dangerous: bool

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...


@dataclass
class FileReaderTool:
    name: str = "file_reader"
    permissions: list[str] = field(default_factory=lambda: ["fs:read"])
    dangerous: bool = False

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        path = Path(str(payload.get("path", ""))).expanduser()
        if not path.is_file():
            raise FileNotFoundError(str(path))
        return {"path": str(path), "content": path.read_text(encoding="utf-8")}
