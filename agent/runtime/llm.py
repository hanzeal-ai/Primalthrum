from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class LLMProvider(Protocol):
    name: str

    def chat(self, messages: list[dict[str, str]]) -> str:
        ...

    def embed(self, texts: list[str]) -> list[list[float]]:
        ...


@dataclass
class MockLLMProvider:
    name: str = "mock"

    def chat(self, messages: list[dict[str, str]]) -> str:
        latest = messages[-1]["content"] if messages else ""
        return f"mock response: {latest}"

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(text)), float(sum(ord(ch) for ch in text) % 997)] for text in texts]
