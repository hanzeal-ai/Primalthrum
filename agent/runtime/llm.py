from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol


MOCK_EMBEDDING_DIMENSIONS = 8


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
        return [mock_embedding(text) for text in texts]


def mock_embedding(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [
        int.from_bytes(digest[index * 4 : (index + 1) * 4], "big") / 0xFFFFFFFF
        for index in range(MOCK_EMBEDDING_DIMENSIONS)
    ]
