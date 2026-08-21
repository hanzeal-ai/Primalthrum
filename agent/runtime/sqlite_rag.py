from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

from .llm import mock_embedding
from .rag import chunk_text, cosine_similarity


DEFAULT_RAG_PATH = Path(".primalthrum") / "rag.sqlite3"


class SQLiteRagProvider:
    name = "sqlite"

    def __init__(self, path: str | None = None) -> None:
        selected_path = path.strip() if path and path.strip() else str(DEFAULT_RAG_PATH)
        self.path = Path(selected_path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists() and not self.path.is_file():
            raise ValueError("RAG path must be a file")
        self._initialize()

    def upsert(self, document_id: str, text: str) -> None:
        chunks = chunk_text(document_id, text)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "DELETE FROM rag_entries WHERE document_id = ?",
                (document_id,),
            )
            connection.executemany(
                """
                INSERT INTO rag_entries (
                    document_id, chunk_id, text, embedding_json
                ) VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        chunk.document_id,
                        chunk.chunk_id,
                        chunk.text,
                        json.dumps(mock_embedding(chunk.text), separators=(",", ":")),
                    )
                    for chunk in chunks
                ],
            )

    def delete(self, document_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "DELETE FROM rag_entries WHERE document_id = ?",
                (document_id,),
            )

    def retrieve(self, query: str, top_k: int = 4) -> list[dict[str, str]]:
        if top_k <= 0:
            return []
        with closing(self._connect()) as connection:
            rows = connection.execute(
                """
                SELECT document_id, chunk_id, text, embedding_json
                FROM rag_entries
                ORDER BY chunk_id ASC
                """
            ).fetchall()
        query_embedding = mock_embedding(query)
        scored = [
            (
                cosine_similarity(query_embedding, self._embedding(row[3])),
                row[1],
                row,
            )
            for row in rows
        ]
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [
            {
                "document_id": row[0],
                "chunk_id": row[1],
                "text": row[2],
            }
            for _, _, row in scored[:top_k]
        ]

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS rag_entries (
                    document_id TEXT NOT NULL,
                    chunk_id TEXT PRIMARY KEY,
                    text TEXT NOT NULL,
                    embedding_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_rag_entries_document
                ON rag_entries(document_id)
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @staticmethod
    def _embedding(serialized: str) -> list[float]:
        value = json.loads(serialized)
        if not isinstance(value, list) or not all(
            isinstance(item, (int, float)) for item in value
        ):
            raise ValueError("stored RAG embedding is invalid")
        return [float(item) for item in value]
