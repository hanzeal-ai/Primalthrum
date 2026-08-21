import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from runtime.sqlite_rag import SQLiteRagProvider


class SQLiteRagProviderTest(unittest.TestCase):
    def test_entries_persist_across_provider_instances(self) -> None:
        with TemporaryDirectory() as temp_dir:
            path = str(Path(temp_dir) / "rag.sqlite3")
            provider = SQLiteRagProvider(path)
            provider.upsert("doc-a", "alpha beta gamma")
            provider.upsert("doc-b", "pricing subscription invoice")

            reloaded = SQLiteRagProvider(path)
            results = reloaded.retrieve("pricing invoice", top_k=1)

            self.assertEqual(results[0]["document_id"], "doc-b")

    def test_upsert_replaces_document_and_delete_is_durable(self) -> None:
        with TemporaryDirectory() as temp_dir:
            path = str(Path(temp_dir) / "rag.sqlite3")
            provider = SQLiteRagProvider(path)
            provider.upsert("doc-a", "obsolete content")
            provider.upsert("doc-a", "replacement knowledge")

            self.assertEqual(
                [entry["text"] for entry in provider.retrieve("replacement", 4)],
                ["replacement knowledge"],
            )
            provider.delete("doc-a")
            self.assertEqual(SQLiteRagProvider(path).retrieve("replacement"), [])

    def test_non_positive_top_k_returns_no_results(self) -> None:
        with TemporaryDirectory() as temp_dir:
            provider = SQLiteRagProvider(str(Path(temp_dir) / "rag.sqlite3"))
            provider.upsert("doc-a", "stored knowledge")

            self.assertEqual(provider.retrieve("stored", top_k=0), [])


if __name__ == "__main__":
    unittest.main()
