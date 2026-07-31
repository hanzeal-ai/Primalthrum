# User Workflow Guide

This guide covers the core operator and user workflows in the web console.

## Admin Setup

Open the web console, create the first admin account, then sign in. Existing deployments show the login flow instead of setup.

## Provider Settings

Open Provider Settings and save provider configs for LLM, embedding, STT, or TTS usage. Secrets are stored server-side as redacted references. Runtime Capabilities controls whether each configured capability may be used in the workspace.

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

## Voice Interaction

Use the microphone button in the Builder or hosted Agent page. With an STT Provider configured, the browser records bounded audio and sends it through the authenticated platform transcription route. Without one, supported browsers use native speech recognition. Denied microphone permission is shown inline and text input remains available.

Assistant messages expose a playback button. A configured TTS Provider uses the platform speech route; otherwise supported browsers use native speech synthesis. Starting another message stops the active playback.

## Usage And Cost Controls

Open `/app/usage` from the Workspace navigation to inspect the current UTC
billing period. The page shows rated credits, Provider cost, event totals, and
the immutable quantity breakdown for each meter. Owner and Billing roles can set
monthly credit and Provider-cost limits, choose a hard stop, and review 50%, 80%,
and 100% threshold alerts. Admin is read-only; roles without `billing.read` do
not receive usage or billing data.

## Billing And Invoices

Open `/app/billing` to view the effective plan, subscription state, available,
reserved, and spent credits, and the server-managed plan catalog. Owner and
Billing roles can start hosted Checkout, request a paid-plan change, open the
Provider Customer Portal, or confirm period-end cancellation. Payment card data
stays on the hosted Provider surface. Paid invoice rows link to the Provider's
hosted invoice when one is available.

## Team And Invitations

Open `/app/team` to inspect the active Workspace membership and seat usage. All
roles can read the member list. Owner and Admin can invite a member, assign one
of the Admin, Developer, Member, Billing, or Viewer roles, copy the one-time
acceptance link, revoke a pending invitation, change another member's role, or
remove a member. An active member and each non-expired pending invitation reserve
one plan seat. The server rejects invitations that exceed the seat entitlement
or target an existing member.

The recipient opens `/accept-invitation?token=...`. New users set a password;
existing users enter their current password. Successful acceptance signs the
recipient into the invited Workspace. Invitation links expire after seven days,
can be accepted once, and are rate-limited. Owners cannot be changed or removed,
and administrators cannot change their own role or remove themselves.

## Generated Agent

After creating an agent, generate the standalone project. The generated project includes a LangGraph skeleton, provider folders, and a demo test path.
