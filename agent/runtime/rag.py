from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Protocol

from .llm import mock_embedding


@dataclass(frozen=True)
class TextChunk:
    document_id: str
    chunk_id: str
    text: str


@dataclass(frozen=True)
class VectorEntry:
    document_id: str
    chunk_id: str
    text: str
    embedding: list[float]


def chunk_text(
    document_id: str,
    text: str,
    max_words: int = 120,
    overlap_words: int = 20,
) -> list[TextChunk]:
    if max_words <= 0:
        raise ValueError("max_words must be greater than 0")
    if overlap_words < 0 or overlap_words >= max_words:
        raise ValueError(
            "overlap_words must be non-negative and less than max_words"
        )

    words = text.split()
    if not words:
        return []

    chunks: list[TextChunk] = []
    start = 0
    while start < len(words):
        end = min(start + max_words, len(words))
        chunk_words = words[start:end]
        chunks.append(
            TextChunk(
                document_id=document_id,
                chunk_id=f"{document_id}:{len(chunks)}",
                text=" ".join(chunk_words),
            )
        )
        if end == len(words):
            break
        start = end - overlap_words
    return chunks


class RagProvider(Protocol):
    name: str

    def upsert(self, document_id: str, text: str) -> None:
        ...

    def retrieve(self, query: str, top_k: int = 4) -> list[dict[str, str]]:
        ...


@dataclass
class NullRagProvider:
    name: str = "null"

    def upsert(self, document_id: str, text: str) -> None:
        return None

    def retrieve(self, query: str, top_k: int = 4) -> list[dict[str, str]]:
        return []


@dataclass
class InMemoryRagProvider:
    name: str = "in-memory"
    entries: list[VectorEntry] = field(default_factory=list)

    def upsert(self, document_id: str, text: str) -> None:
        self.entries = [
            entry for entry in self.entries
            if entry.document_id != document_id
        ]
        self.entries.extend(
            VectorEntry(
                document_id=chunk.document_id,
                chunk_id=chunk.chunk_id,
                text=chunk.text,
                embedding=mock_embedding(chunk.text),
            )
            for chunk in chunk_text(document_id, text)
        )

    def retrieve(self, query: str, top_k: int = 4) -> list[dict[str, str]]:
        if top_k <= 0 or not self.entries:
            return []

        query_embedding = mock_embedding(query)
        scored = [
            (
                cosine_similarity(query_embedding, entry.embedding),
                entry.chunk_id,
                entry,
            )
            for entry in self.entries
        ]
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [
            {
                "document_id": entry.document_id,
                "chunk_id": entry.chunk_id,
                "text": entry.text,
            }
            for _, _, entry in scored[:top_k]
        ]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return numerator / (left_norm * right_norm)
