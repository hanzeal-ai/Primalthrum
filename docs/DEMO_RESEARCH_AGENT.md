# Demo Research Agent

The demo package lives at `examples/research-agent`.

## What It Proves

- A realistic Research Agent configuration can be created from the web console.
- The first knowledge document can be registered and indexed.
- The generated standalone project path can be exercised after the agent is created.
- The stream interface can run a launch-readiness prompt against the configured agent.

## Demo Command

```bash
bash examples/research-agent/smoke.sh
```

## Suggested Run Goal

```text
Summarize the platform readiness for a launch review. Use the attached research brief as evidence.
```

## Operator Flow

1. Complete the Operator Checklist in the web console.
2. Copy `examples/research-agent/agent.config.json` into the Agent Builder fields.
3. Register `examples/research-agent/documents/research-brief.md` for the created agent.
4. Index the document.
5. Generate the standalone project.
6. Run the suggested goal through the stream console.
