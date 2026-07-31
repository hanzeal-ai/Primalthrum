# Provider Extension Guide

Primalthrum runtime providers are small Python classes registered in `agent/runtime/factory.py`.
Each provider must satisfy the matching Protocol and have a stable `name`.

## Provider Types

| Type | Protocol file | Required methods |
| --- | --- | --- |
| LLM | `agent/runtime/llm.py` | `stream_chat(messages)` |
| Embedding | `agent/runtime/embeddings.py` | `embed(texts)` |
| Memory | `agent/runtime/memory.py` | `write_summary(run_id, summary)`, `list_summaries()` |
| Cache | `agent/runtime/cache.py` | `get(key)`, `set(key, value)` |
| RAG | `agent/runtime/rag.py` | `upsert(document_id, text)`, `retrieve(query, top_k)` |

## Add A Provider

1. Add the provider class to the relevant runtime file.
2. Keep configuration explicit in `AgentRuntimeConfig` when the provider needs paths, URLs, or credentials.
3. Register the provider in `create_runtime()` only when it is selected, especially if initialization opens files or network connections.
4. Add focused tests in `agent/tests/test_runtime_registry.py`.
5. Run:

```bash
cd agent
./.venv/bin/python -m unittest tests/test_runtime_registry.py
```

## Skeleton

```python
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ExampleMemory:
    path: str | Path
    name: str = "example"
    summaries: list[dict[str, str]] = field(default_factory=list)

    def write_summary(self, run_id: str, summary: str) -> None:
        self.summaries.append({"run_id": run_id, "summary": summary})

    def list_summaries(self) -> list[dict[str, str]]:
        return list(self.summaries)
```

Register it conservatively:

```python
if config.memory_provider == "example":
    memory_registry.register("example", ExampleMemory(config.memory_path))
```

## Rules

- Do not initialize inactive providers.
- Do not hide required external services behind defaults.
- Keep provider names stable; Web and Server persist provider names in agent config.
- Normalize cache keys before storing values.
- Keep mock providers deterministic so smoke tests are stable.
- Add or update discovery metadata when the provider should appear in the Web builder.
- Keep Embedding output count, dimensions, and numeric values stable within one batch;
  the Agent validates these invariants before the Server persists vectors.
- The Server calls `POST /internal/embeddings` for durable indexing. Keep that route
  private to the trusted service network in production.
