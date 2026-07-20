from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


@dataclass(frozen=True)
class SkillDefinition:
    name: str
    version: str
    tools: list[str] = field(default_factory=list)
    instructions: str = ""


def load_skill_package(package_dir: Path) -> SkillDefinition:
    manifest_path = package_dir / "skill.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    name = _required_text(manifest, "name")
    version = _required_text(manifest, "version")
    instructions_file = _required_text(manifest, "instructions_file")
    tools = manifest.get("tools", [])
    if not isinstance(tools, list) or any(not isinstance(tool, str) for tool in tools):
        raise ValueError(f"skill '{name}' tools must be a list of strings")

    instructions_path = package_dir / instructions_file
    instructions = instructions_path.read_text(encoding="utf-8").strip()
    if not instructions:
        raise ValueError(f"skill '{name}' instructions cannot be empty")

    return SkillDefinition(
        name=name,
        version=version,
        tools=tools,
        instructions=instructions,
    )


def load_skill_packages(skills_dir: Path = DEFAULT_SKILLS_DIR) -> dict[str, SkillDefinition]:
    if not skills_dir.exists():
        return {}
    packages: dict[str, SkillDefinition] = {}
    for package_dir in sorted(path for path in skills_dir.iterdir() if path.is_dir()):
        skill = load_skill_package(package_dir)
        packages[skill.name] = skill
    return packages


def _required_text(manifest: dict[str, Any], key: str) -> str:
    value = manifest.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"skill manifest {key} is required")
    return value.strip()
