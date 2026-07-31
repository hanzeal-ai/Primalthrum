import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acceptWorkspaceInvitation,
  createBillingCheckout,
  createWorkspaceApiKey,
  createWorkspaceInvitation,
  indexDocument,
  replayAgentRun,
  registerAccount,
  revokeOtherSecuritySessions,
  streamAgentRun,
  streamPublicAgentRun,
  synthesizeSpeech,
  transcribeAudio,
  uploadDocument,
  updateBillingCostControls,
} from './client'

function streamResponse(body: string, headers: Record<string, string>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      ...headers,
    },
  })
}

describe('stream client', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps canonical event IDs and sends the idempotency key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(
      [
        'id: 11\nevent: message.delta\ndata: {"delta":"hello"}',
        'id: 12\nevent: message.completed\ndata: {"content":"hello"}',
        '',
      ].join('\n\n'),
      {
        'x-primalthrum-run-id': '7',
        'x-primalthrum-conversation-id': '9',
        'x-primalthrum-idempotency-key': 'request-1',
      },
    ))
    const events: number[] = []

    const result = await streamAgentRun(
      { agentId: 3, input: 'hello' },
      {
        idempotencyKey: 'request-1',
        onEvent: (event) => events.push(event.id ?? 0),
      },
    )

    expect(events).toEqual([11, 12])
    expect(result).toEqual({
      runId: 7,
      conversationId: 9,
      idempotencyKey: 'request-1',
      lastEventId: 12,
    })
    const request = fetchMock.mock.calls[0]
    expect(new Headers(request[1]?.headers).get('Idempotency-Key')).toBe('request-1')
  })

  it('sends challenge tokens only on protected public conversion requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: { token: 'registered-session' },
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(streamResponse(
        'event: message.completed\ndata: {"message":"done"}\n\n',
        {},
      ))

    await registerAccount({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      workspaceName: 'Acme',
      planKey: 'pro',
    }, 'signup-challenge')
    await streamPublicAgentRun('public-agent', { input: 'hello' }, {
      idempotencyKey: 'public-run-1',
      challengeToken: 'stream-challenge',
      onEvent: () => undefined,
    })

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Bot-Challenge-Token'))
      .toBe('signup-challenge')
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-Bot-Challenge-Token'))
      .toBe('stream-challenge')
  })

  it('requests only events after the last received event', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse(
      'id: 13\nevent: agent.run.completed\ndata: {"status":"completed"}\n\n',
      { 'x-primalthrum-run-id': '7' },
    ))
    const events: number[] = []

    const result = await replayAgentRun(7, 12, {
      onEvent: (event) => events.push(event.id ?? 0),
    })

    expect(events).toEqual([13])
    expect(result.lastEventId).toBe(13)
    const request = fetchMock.mock.calls[0]
    expect(new Headers(request[1]?.headers).get('Last-Event-ID')).toBe('12')
  })

  it('uploads UTF-8 document bytes through the bounded upload contract', async () => {
    const record = {
      id: 5,
      agentId: 3,
      workspaceId: 1,
      filename: 'guide.md',
      hash: 'a'.repeat(64),
      indexStatus: 'registered',
      collection: 'default',
      storageRef: 'local://documents/guide.md',
      mimeType: 'text/markdown',
      sizeBytes: 7,
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(record),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ))

    expect(await uploadDocument(3, {
      filename: 'guide.md',
      mimeType: 'text/markdown',
      content: '# Guide',
    })).toEqual(record)

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(String(request[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({
      filename: 'guide.md',
      mimeType: 'text/markdown',
      dataBase64: window.btoa('# Guide'),
    })
  })

  it('waits for a queued document index job to succeed', async () => {
    const document = {
      id: 5,
      agentId: 3,
      workspaceId: 1,
      filename: 'guide.md',
      hash: 'a'.repeat(64),
      indexStatus: 'indexed',
      collection: 'default',
      storageRef: 'local://documents/guide.md',
      mimeType: 'text/markdown',
      sizeBytes: 7,
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...document,
        indexStatus: 'indexing',
        job: { id: 8, status: 'queued' },
      }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 8,
        status: 'succeeded',
        result: { document, indexEntryCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

    expect(await indexDocument(3, 5)).toEqual(document)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/jobs/8')
  })

  it('encodes recorded audio and returns speech results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        provider: 'openai', model: 'stt-test', text: 'transcribed',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        provider: 'openai', model: 'tts-test', mimeType: 'audio/mpeg',
        audioBase64: window.btoa('speech'),
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm;codecs=opus' })
    expect(await transcribeAudio(audio, 7)).toMatchObject({ text: 'transcribed' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      providerConfigId: 7,
      filename: 'recording.webm',
      mimeType: 'audio/webm',
      audioBase64: 'AQID',
    })
    expect(await synthesizeSpeech('Read this', 8)).toMatchObject({ model: 'tts-test' })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      providerConfigId: 8,
      text: 'Read this',
      voice: 'alloy',
    })
  })

  it('sends billing mutations with explicit idempotency and typed controls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        checkoutUrl: 'https://checkout.example/session',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        workspaceId: 1,
        monthlyCreditLimit: 20000,
        monthlyProviderCostMicrosLimit: 5000000,
        hardLimit: true,
        overageEnabled: false,
        alertThresholds: [50, 80, 100],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await createBillingCheckout('pro', 'checkout-request-1')
    await updateBillingCostControls({
      monthlyCreditLimit: 20000,
      monthlyProviderCostMicrosLimit: 5000000,
      hardLimit: true,
      overageEnabled: false,
      alertThresholds: [50, 80, 100],
    })

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/billing/checkout')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key'))
      .toBe('checkout-request-1')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      monthlyCreditLimit: 20000,
      monthlyProviderCostMicrosLimit: 5000000,
    })
  })

  it('creates and accepts workspace invitations without leaking the session contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 9, workspaceId: 3, email: 'member@example.com', role: 'member', token: 'invite-token',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: 4, workspaceId: 3, email: 'member@example.com', role: 'member' },
        session: { token: 'invited-session', expiresAt: '2026-08-07T00:00:00.000Z' },
        emailVerified: true,
      }), { status: 201, headers: { 'content-type': 'application/json' } }))

    await createWorkspaceInvitation(3, { email: 'member@example.com', role: 'member' })
    await acceptWorkspaceInvitation('invite-token', 'new member password')

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/workspaces/3/invitations')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: 'member@example.com', role: 'member',
    })
    expect(window.localStorage.getItem('primalthrum.sessionToken')).toBe('invited-session')
  })

  it('creates scoped API keys and revokes other sessions through security settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 4, name: 'Production', token: 'ptk_prefix_secret',
        scopes: ['agents:read', 'agents:run'], expiresAt: '2026-10-29T00:00:00.000Z',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: 2 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))

    await createWorkspaceApiKey({
      name: 'Production', scopes: ['agents:read', 'agents:run'],
      expiresInDays: 90, password: 'current password value',
    })
    expect(await revokeOtherSecuritySessions()).toEqual({ revoked: 2 })

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/settings/api-keys')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: 'Production', scopes: ['agents:read', 'agents:run'],
      expiresInDays: 90, password: 'current password value',
    })
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/settings/sessions/revoke-others')
  })
})
