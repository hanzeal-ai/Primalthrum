import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from runtime import AgentRuntimeConfig, create_runtime


class RuntimeRegistryTest(unittest.TestCase):
    def test_default_runtime_has_hot_pluggable_systems(self) -> None:
        runtime = create_runtime(AgentRuntimeConfig(agent_name="ResearchAgent"))

        self.assertEqual(runtime.llm.name, "mock")
        self.assertEqual(runtime.memory.name, "null")
        self.assertEqual(runtime.cache.name, "memory")
        self.assertEqual(runtime.rag.name, "null")
        self.assertIn("file_reader", runtime.tools.names())
        self.assertIn("research", runtime.skills.names())

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


if __name__ == "__main__":
    unittest.main()
