import unittest

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


if __name__ == "__main__":
    unittest.main()
