# User Workflow Guide

This guide covers the core operator and user workflows in the web console.

## Admin Setup

Open the web console, create the first admin account, then sign in. Existing deployments show the login flow instead of setup.

## Provider Settings

Open Security Settings and save provider configs for LLM or embedding usage. Secrets are stored server-side as redacted references.

## Agent Builder

Create an agent with:

- Name and description.
- Memory provider.
- Cache provider.
- RAG provider.
- Embedding provider when RAG is enabled.
- Enabled tools.
- Enabled skills.

Use `none` or `null` when a capability should be disabled.

## Knowledge

Select an agent, upload a supported document, and start indexing. The server accepts indexing as a durable background Job, and the Web client waits for the Job to succeed before showing the document as indexed. Queued and retrying Jobs resume after a server restart. Indexed documents become retrieval-ready for providers that support RAG.

The Builder obtains vector-store choices from the runtime capability catalog. Select `none` to disable retrieval, `sqlite` for the built-in persistent vector store, or another available adapter. Planned adapters remain visible but disabled. When RAG is enabled, select an Embedding Provider; runs only retrieve chunks indexed with the same vector store, provider, and model, and render matching documents as message sources.

## Run Console

Select an agent, enter a goal, and start a stream. The timeline shows run start, node updates, cache events, errors, and completion.

## Generated Agent

After creating an agent, generate the standalone project. The generated project includes a LangGraph skeleton, provider folders, and a demo test path.
