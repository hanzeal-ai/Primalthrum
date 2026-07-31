# Operator Setup

This guide covers the first operator flow for a commercial Primalthrum deployment.

## 1. Create Admin

Start the server and web console, open the web URL, and create the first admin user. Passwords must be at least 12 characters.

## 2. Save Provider Config

Open Security Settings and save at least one provider configuration.

Required fields:

- `name`: stable operator-facing config name.
- `type`: `llm`, `embedding`, or another provider category supported by the deployment.
- `provider`: provider key such as `openai`, `anthropic`, or `mock`.
- `secret`: required on create; stored as a local secret reference by the server.

## 3. Create First Agent

Open Agent Builder and create an agent with explicit memory, cache, RAG, tools, and skills choices. Use `null` or `none` providers when a capability should be disabled.

## 4. Attach Knowledge

Select the agent, open Knowledge, upload the first document, then index it. The request should be accepted with a queued Job and reach `succeeded`; this verifies document storage, durable background dispatch, and the RAG indexing path for the selected agent.

## 5. Run First Stream

Open Run Configuration, submit a goal, and confirm Stream Timeline receives `agent.run.started`, `agent.node.completed`, and `agent.run.completed`.

## Completion Check

The web console checklist is complete when:

- Admin is signed in.
- At least one provider config exists.
- At least one agent exists.
- The selected agent has at least one document registered.
- The current console session has completed one run.
