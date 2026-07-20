from __future__ import annotations

from dataclasses import dataclass, field
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass
class Registry(Generic[T]):
    entries: dict[str, T] = field(default_factory=dict)

    def register(self, name: str, value: T) -> None:
        normalized = name.strip()
        if not normalized:
            raise ValueError("registry name is required")
        self.entries[normalized] = value

    def get(self, name: str) -> T:
        try:
            return self.entries[name]
        except KeyError as exc:
            available = ", ".join(self.names()) or "none"
            raise KeyError(f"unknown provider '{name}', available: {available}") from exc

    def names(self) -> list[str]:
        return sorted(self.entries)
