# Tool And Skill Authoring Guide

Tools perform actions. Skills package reusable instructions and declare which tools they expect.
Both must be explicit, testable, and safe by default.

## Tool Manifest

Every tool must implement `ToolDefinition` from `agent/runtime/tools.py`:

```python
class ToolDefinition(Protocol):
    name: str
    manifest: ToolManifest

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...
```

The manifest must include:

- `name`: stable API-facing identifier.
- `description`: concise user-facing purpose.
- `input_schema`: JSON-schema-like object schema.
- `permissions`: non-empty permission labels such as `fs:read`.
- `dangerous`: boolean risk marker.

Register tools in `agent/runtime/factory.py` through `validate_tool_definition(tool)`.

## Dangerous Tool Policy

Mark `dangerous: true` when a tool can mutate state, execute commands, make network calls, access secrets, or write/delete files.

Dangerous tools must:

- Declare specific permissions.
- Validate all input before side effects.
- Use allowlists for filesystem roots, domains, commands, and protocols.
- Return structured results instead of raw logs when possible.
- Have tests for allowed and denied operations.

## File Tool Safety

The built-in `file_reader` is read-only and requires configured `file_reader_allowed_roots`.
Do not default file tools to unrestricted local access.

## Skill Package

A skill package lives under `agent/skills/<name>/`:

```text
agent/skills/research/
  skill.json
  instructions.md
```

`skill.json`:

```json
{
  "name": "research",
  "version": "0.1.0",
  "tools": ["file_reader"],
  "instructions_file": "instructions.md"
}
```

Rules:

- `name`, `version`, and `instructions_file` are required.
- `tools` must be a list of strings.
- The instructions file must not be empty.
- Keep instructions operational; avoid hidden assumptions about unavailable tools.

## Verification

Run runtime tests after adding or changing tools or skills:

```bash
cd agent
./.venv/bin/python -m unittest tests/test_runtime_registry.py
```

Run the full smoke command before merging broad tool or skill changes:

```bash
scripts/smoke.sh
```
