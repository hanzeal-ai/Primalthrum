from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class MemoryProvider(Protocol):
    name: str

    def write_summary(self, run_id: str, summary: str) -> None:
        ...

    def list_summaries(self) -> list[dict[str, str]]:
        ...


@dataclass
class NullMemory:
    name: str = "null"

    def write_summary(self, run_id: str, summary: str) -> None:
        return None

    def list_summaries(self) -> list[dict[str, str]]:
        return []


@dataclass
class InMemoryMemory:
    name: str = "memory"
    summaries: list[dict[str, str]] = field(default_factory=list)

    def write_summary(self, run_id: str, summary: str) -> None:
        self.summaries.append({"run_id": run_id, "summary": summary})

    def list_summaries(self) -> list[dict[str, str]]:
        return list(self.summaries)
