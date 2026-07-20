import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from runtime import AgentRuntimeConfig, create_runtime
from runtime.llm import MockLLMProvider
from runtime.rag import InMemoryRagProvider, chunk_text
from runtime.tools import ToolManifest, validate_tool_manifest


class RuntimeRegistryTest(unittest.TestCase):
    def test_default_runtime_has_hot_pluggable_systems(self) -> None:
        runtime = create_runtime(AgentRuntimeConfig(agent_name="ResearchAgent"))

        self.assertEqual(runtime.llm.name, "mock")
        self.assertEqual(runtime.memory.name, "null")
        self.assertEqual(runtime.cache.name, "memory")
        self.assertEqual(runtime.rag.name, "null")
        self.assertIn("file_reader", runtime.tools.names())
        self.assertIn("research", runtime.skills.names())

    def test_file_reader_exposes_valid_tool_manifest(self) -> None:
        runtime = create_runtime(AgentRuntimeConfig(agent_name="ResearchAgent"))
        tool = runtime.tools.get("file_reader")

        self.assertEqual(tool.manifest.name, "file_reader")
        self.assertEqual(tool.manifest.input_schema["type"], "object")
        self.assertEqual(tool.manifest.input_schema["required"], ["path"])
        self.assertEqual(tool.manifest.permissions, ["fs:read"])
        self.assertFalse(tool.manifest.dangerous)

    def test_tool_manifest_rejects_missing_permission_metadata(self) -> None:
        manifest = ToolManifest(
            name="unsafe_tool",
            description="Missing permission metadata",
            input_schema={"type": "object"},
            permissions=[],
            dangerous=False,
        )

        with self.assertRaisesRegex(ValueError, "permissions"):
            validate_tool_manifest(manifest)

    def test_file_reader_allows_only_configured_roots(self) -> None:
        with TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            allowed_root = workspace / "allowed"
            allowed_root.mkdir()
            allowed_file = allowed_root / "notes.txt"
            allowed_file.write_text("approved content", encoding="utf-8")
            denied_file = workspace / "secret.txt"
            denied_file.write_text("private content", encoding="utf-8")

            runtime = create_runtime(
                AgentRuntimeConfig(
                    agent_name="ResearchAgent",
                    file_reader_allowed_roots=[str(allowed_root)],
                )
            )
            tool = runtime.tools.get("file_reader")

            self.assertEqual(
                tool.call({"path": str(allowed_file)})["content"],
                "approved content",
            )
            with self.assertRaises(PermissionError):
                tool.call({"path": str(allowed_root / ".." / "secret.txt")})

    def test_file_reader_denies_reads_without_allowed_roots(self) -> None:
        with TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / "notes.txt"
            file_path.write_text("content", encoding="utf-8")
            runtime = create_runtime(AgentRuntimeConfig(agent_name="ResearchAgent"))

            with self.assertRaises(PermissionError):
                runtime.tools.get("file_reader").call({"path": str(file_path)})

    def test_research_skill_loads_from_manifest_package(self) -> None:
        runtime = create_runtime(AgentRuntimeConfig(agent_name="ResearchAgent"))
        skill = runtime.skills.get("research")

        self.assertEqual(skill.version, "0.1.0")
        self.assertEqual(skill.tools, ["file_reader"])
        self.assertIn("Use retrieved evidence before acting.", skill.instructions)

    def test_chunk_text_is_deterministic_with_word_overlap(self) -> None:
        chunks = chunk_text(
            "doc-1",
            "alpha beta gamma delta epsilon zeta",
            max_words=3,
            overlap_words=1,
        )

        self.assertEqual(
            [(chunk.chunk_id, chunk.text) for chunk in chunks],
            [
                ("doc-1:0", "alpha beta gamma"),
                ("doc-1:1", "gamma delta epsilon"),
                ("doc-1:2", "epsilon zeta"),
            ],
        )
        self.assertEqual(
            chunks,
            chunk_text(
                "doc-1",
                "alpha beta gamma delta epsilon zeta",
                max_words=3,
                overlap_words=1,
            ),
        )

    def test_mock_embeddings_are_deterministic_fixed_width_vectors(self) -> None:
        provider = MockLLMProvider()

        first = provider.embed(["retrieval chunk"])[0]
        second = provider.embed(["retrieval chunk"])[0]
        other = provider.embed(["different chunk"])[0]

        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertEqual(len(first), 8)
        self.assertTrue(all(0.0 <= value <= 1.0 for value in first))

    def test_in_memory_rag_returns_vector_ranked_chunks(self) -> None:
        provider = InMemoryRagProvider()
        provider.upsert("doc-a", "alpha beta")
        provider.upsert("doc-b", "gamma delta")

        results = provider.retrieve("gamma delta", top_k=2)

        self.assertEqual(
            [(result["document_id"], result["chunk_id"]) for result in results],
            [("doc-b", "doc-b:0"), ("doc-a", "doc-a:0")],
        )

    def test_runtime_respects_disabled_tools_skills_and_rag(self) -> None:
        runtime = create_runtime(
            AgentRuntimeConfig(
                agent_name="ResearchAgent",
                enabled_tools=[],
                enabled_skills=[],
                rag_provider="none",
            )
        )

        self.assertEqual(runtime.tools.names(), [])
        self.assertEqual(runtime.skills.names(), [])
        self.assertEqual(runtime.rag.retrieve("anything"), [])

    def test_sqlite_memory_persists_summaries_by_path(self) -> None:
        with TemporaryDirectory() as temp_dir:
            memory_path = str(Path(temp_dir) / "memory.sqlite3")
            runtime = create_runtime(
                AgentRuntimeConfig(
                    agent_name="ResearchAgent",
                    memory_provider="sqlite",
                    memory_path=memory_path,
                )
            )

            self.assertEqual(runtime.memory.name, "sqlite")
            runtime.memory.write_summary("run-1", "accepted goal")
            runtime.memory.write_summary("run-2", "finished graph")

            reloaded = create_runtime(
                AgentRuntimeConfig(
                    agent_name="ResearchAgent",
                    memory_provider="sqlite",
                    memory_path=memory_path,
                )
            )

            self.assertEqual(
                reloaded.memory.list_summaries(),
                [
                    {"run_id": "run-1", "summary": "accepted goal"},
                    {"run_id": "run-2", "summary": "finished graph"},
                ],
            )

    def test_sqlite_cache_persists_values_with_normalized_keys(self) -> None:
        with TemporaryDirectory() as temp_dir:
            cache_path = str(Path(temp_dir) / "cache.sqlite3")
            runtime = create_runtime(
                AgentRuntimeConfig(
                    agent_name="ResearchAgent",
                    cache_provider="sqlite",
                    cache_path=cache_path,
                )
            )

            self.assertEqual(runtime.cache.name, "sqlite")
            runtime.cache.set("  answer:demo  ", {"status": "ok", "tokens": 12})

            reloaded = create_runtime(
                AgentRuntimeConfig(
                    agent_name="ResearchAgent",
                    cache_provider="sqlite",
                    cache_path=cache_path,
                )
            )

            self.assertEqual(
                reloaded.cache.get("answer:demo"),
                {"status": "ok", "tokens": 12},
            )


if __name__ == "__main__":
    unittest.main()
