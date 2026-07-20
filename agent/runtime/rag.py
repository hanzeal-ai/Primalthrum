from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class TextChunk:
    document_id: str
    chunk_id: str
    text: str


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
    documents: dict[str, str] = field(default_factory=dict)

    def upsert(self, document_id: str, text: str) -> None:
        self.documents[document_id] = text

    def retrieve(self, query: str, top_k: int = 4) -> list[dict[str, str]]:
        query_terms = {term.lower() for term in query.split() if term.strip()}
        scored: list[tuple[int, str, str]] = []
        for document_id, text in self.documents.items():
            text_terms = set(text.lower().split())
            score = len(query_terms & text_terms)
            if score > 0:
                scored.append((score, document_id, text))
        scored.sort(reverse=True)
        return [
            {"document_id": document_id, "text": text}
            for _, document_id, text in scored[:top_k]
        ]
