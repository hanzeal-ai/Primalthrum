from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


DEFAULT_CACHE_PATH = Path(".primalthrum") / "cache.sqlite3"


def normalize_cache_key(key: str) -> str:
    normalized = key.strip()
    if not normalized:
        raise ValueError("cache key is required")
    return normalized


class CacheProvider(Protocol):
    name: str

    def get(self, key: str) -> Any | None:
        ...

    def set(self, key: str, value: Any) -> None:
        ...


@dataclass
class NullCache:
    name: str = "null"

    def get(self, key: str) -> None:
        return None

    def set(self, key: str, value: Any) -> None:
        return None


@dataclass
class MemoryCache:
    name: str = "memory"
    values: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str) -> Any | None:
        return self.values.get(normalize_cache_key(key))

    def set(self, key: str, value: Any) -> None:
        self.values[normalize_cache_key(key)] = value


@dataclass
class SQLiteCache:
    path: str | Path | None = None
    name: str = "sqlite"
    db_path: Path = field(init=False)

    def __post_init__(self) -> None:
        self.db_path = Path(self.path) if self.path else DEFAULT_CACHE_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS cache_entries (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def get(self, key: str) -> Any | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT value
                FROM cache_entries
                WHERE key = ?
                """,
                (normalize_cache_key(key),),
            ).fetchone()
        if row is None:
            return None
        return json.loads(row["value"])

    def set(self, key: str, value: Any) -> None:
        serialized = json.dumps(value, ensure_ascii=False, sort_keys=True)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO cache_entries (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (normalize_cache_key(key), serialized),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection
