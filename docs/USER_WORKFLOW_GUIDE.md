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
- Enabled tools.
- Enabled skills.

Use `none` or `null` when a capability should be disabled.

## Knowledge

Select an agent, register a document, and index it. Indexed documents become retrieval-ready for providers that support RAG.

## Run Console

Select an agent, enter a goal, and start a stream. The timeline shows run start, node updates, cache events, errors, and completion.

## Generated Agent

After creating an agent, generate the standalone project. The generated project includes a LangGraph skeleton, provider folders, and a demo test path.
