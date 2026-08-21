from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from .factory import AgentRuntime


EventWriter = Callable[[dict[str, Any]], None]


def announce_ready_tools(
    runtime: AgentRuntime,
    agent_name: str,
    writer: EventWriter,
) -> None:
    for tool_name in runtime.tools.names():
        tool = runtime.tools.get(tool_name)
        writer({
            "event": "agent.tool.ready",
            "payload": {
                "node": "intake",
                "agent": agent_name,
                "tool": tool_name,
                "permissions": tool.manifest.permissions,
                "message": f"Tool {tool_name} is ready",
                "status": "done",
            },
        })


def enrich_prompt_with_capabilities(
    runtime: AgentRuntime,
    agent_name: str,
    system_message: str,
    writer: EventWriter,
) -> str:
    for skill_name in runtime.skills.names():
        skill = runtime.skills.get(skill_name)
        system_message += f"\n\nSkill {skill.name}:\n{skill.instructions}"
        writer({
            "event": "agent.skill.applied",
            "payload": {
                "node": "respond",
                "agent": agent_name,
                "skill": skill.name,
                "version": skill.version,
                "message": f"Applied skill {skill.name}",
                "status": "done",
            },
        })

    if runtime.memory.name == "null":
        return system_message

    memories = runtime.memory.list_summaries()
    if memories:
        recent_memories = "\n".join(item["summary"] for item in memories[-5:])
        system_message += f"\n\nRecent memory:\n{recent_memories}"
    writer({
        "event": "agent.memory.loaded",
        "payload": {
            "node": "respond",
            "agent": agent_name,
            "provider": runtime.memory.name,
            "count": len(memories),
            "message": f"Loaded {len(memories)} memory summaries",
            "status": "done",
        },
    })
    return system_message


def remember_exchange(
    runtime: AgentRuntime,
    agent_name: str,
    goal: str,
    answer: str,
    writer: EventWriter,
) -> None:
    if runtime.memory.name == "null":
        return
    runtime.memory.write_summary(
        str(uuid4()),
        f"User: {goal[:1000]}\nAssistant: {answer[:1000]}",
    )
    writer({
        "event": "agent.memory.written",
        "payload": {
            "node": "respond",
            "agent": agent_name,
            "provider": runtime.memory.name,
            "message": "Saved run summary to memory",
            "status": "done",
        },
    })
