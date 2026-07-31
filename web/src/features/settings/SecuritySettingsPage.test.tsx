import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SecuritySettingsPage } from './SecuritySettingsPage'

const api = vi.hoisted(() => ({
  beginMfaSetup: vi.fn(),
  confirmMfaSetup: vi.fn(),
  createWorkspaceApiKey: vi.fn(),
  disableMfa: vi.fn(),
  enforceRetentionSettings: vi.fn(),
  getRetentionSettings: vi.fn(),
  getMfaStatus: vi.fn(),
  listSecuritySessions: vi.fn(),
  listWorkspaceApiKeys: vi.fn(),
  listWorkspaces: vi.fn(),
  revokeOtherSecuritySessions: vi.fn(),
  revokeSecuritySession: vi.fn(),
  revokeWorkspaceApiKey: vi.fn(),
  regenerateMfaRecoveryCodes: vi.fn(),
  updateRetentionSettings: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const sessions = [
  { id: 1, current: true, createdAt: '2026-07-30T00:00:00.000Z', lastSeenAt: '2026-07-31T00:00:00.000Z', expiresAt: '2026-08-07T00:00:00.000Z' },
  { id: 2, current: false, createdAt: '2026-07-29T00:00:00.000Z', lastSeenAt: '2026-07-30T00:00:00.000Z', expiresAt: '2026-08-06T00:00:00.000Z' },
]

describe('SecuritySettingsPage', () => {
  beforeEach(() => {
    api.listWorkspaces.mockResolvedValue([{ id: 1, name: 'Acme', slug: 'acme', role: 'owner' }])
    api.listSecuritySessions.mockResolvedValue(sessions)
    api.listWorkspaceApiKeys.mockResolvedValue([])
    api.getMfaStatus.mockResolvedValue({ enabled: false, recoveryCodesRemaining: 0, enabledAt: null })
    api.getRetentionSettings.mockResolvedValue({
      policy: {
        workspaceId: 1, conversationDays: null, runDays: null, documentDays: null,
        updatedByUserId: null, lastEnforcedAt: null, nextEnforcementAt: null,
        createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z',
      },
      preview: { conversations: 0, runs: 0, documents: 0, documentBytes: 0 },
      events: [], customRetentionEnabled: false, canManage: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates an API key once and revokes other sessions', async () => {
    api.createWorkspaceApiKey.mockResolvedValue({
      id: 8, workspaceId: 1, name: 'Production', keyPrefix: 'ptk_prefix',
      scopes: ['agents:read', 'agents:run'], createdByUserId: 1,
      expiresAt: '2026-10-29T00:00:00.000Z', lastUsedAt: null,
      lastUsedMethod: '', lastUsedPath: '', revokedAt: null,
      createdAt: '2026-07-31T00:00:00.000Z', token: 'ptk_prefix_secret',
    })
    api.revokeOtherSecuritySessions.mockResolvedValue({ revoked: 1 })

    render(<SecuritySettingsPage onLogout={vi.fn()} user={{
      id: 1, workspaceId: 1, email: 'owner@example.com', role: 'owner',
    }} />)

    expect(await screen.findByRole('heading', { name: '设置与安全' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('密钥名称'), { target: { value: 'Production' } })
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'current password value' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 API Key' }))

    await waitFor(() => expect(api.createWorkspaceApiKey).toHaveBeenCalledWith({
      name: 'Production',
      scopes: ['agents:read', 'agents:run'],
      expiresInDays: 90,
      password: 'current password value',
    }))
    expect(screen.getByLabelText('新 API Key')).toHaveProperty('value', 'ptk_prefix_secret')

    fireEvent.click(screen.getByRole('button', { name: '退出其他会话' }))
    await waitFor(() => expect(api.revokeOtherSecuritySessions).toHaveBeenCalled())
  })

  it('keeps API key management hidden for a developer', async () => {
    render(<SecuritySettingsPage onLogout={vi.fn()} user={{
      id: 2, workspaceId: 1, email: 'dev@example.com', role: 'developer',
    }} />)

    expect(await screen.findByText('当前会话')).toBeTruthy()
    expect(screen.queryByLabelText('密钥名称')).toBeNull()
    expect(api.listWorkspaceApiKeys).not.toHaveBeenCalled()
  })
})
