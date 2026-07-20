from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


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
        return self.values.get(key)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value
