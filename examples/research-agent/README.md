# Demo Research Agent

This package is the commercial demo fixture for a retrieval-capable Research Agent.

## Files

- `agent.config.json`: agent creation payload compatible with `POST /api/agents`.
- `documents/research-brief.md`: first knowledge document for the demo RAG collection.
- `smoke.sh`: validates the demo package shape.

## Generate From UI

1. Create or sign in as admin.
2. Save a provider config.
3. Open Agent Builder.
4. Copy the fields from `agent.config.json`.
5. Create the agent.
6. Select the agent and register `documents/research-brief.md` in Knowledge.
7. Index the document.
8. Generate the project.
9. Run a stream goal such as `Summarize the platform readiness for a launch review`.

## Smoke

```bash
bash examples/research-agent/smoke.sh
```
