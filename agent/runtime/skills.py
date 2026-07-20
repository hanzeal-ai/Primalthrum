from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SkillDefinition:
    name: str
    version: str
    tools: list[str] = field(default_factory=list)
    instructions: str = ""
