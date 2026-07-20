from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


DEFAULT_MEMORY_PATH = Path(".primalthrum") / "memory.sqlite3"


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


@dataclass
class SQLiteMemory:
    path: str | Path | None = None
    name: str = "sqlite"
    db_path: Path = field(init=False)

    def __post_init__(self) -> None:
        self.db_path = Path(self.path) if self.path else DEFAULT_MEMORY_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_summaries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def write_summary(self, run_id: str, summary: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO memory_summaries (run_id, summary)
                VALUES (?, ?)
                """,
                (run_id, summary),
            )

    def list_summaries(self) -> list[dict[str, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT run_id, summary
                FROM memory_summaries
                ORDER BY id ASC
                """
            ).fetchall()
        return [{"run_id": row["run_id"], "summary": row["summary"]} for row in rows]

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection
