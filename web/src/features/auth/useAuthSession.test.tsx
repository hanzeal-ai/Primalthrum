import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthSession } from './useAuthSession'

const api = vi.hoisted(() => ({
  clearStoredSessionToken: vi.fn(),
  getCurrentSession: vi.fn(),
  getSetupStatus: vi.fn(),
  isMfaChallengeResponse: vi.fn((response: Record<string, unknown>) => response.mfaRequired === true),
  isUnauthorizedError: vi.fn(() => true),
  loginAdmin: vi.fn(),
  logoutAdmin: vi.fn(),
  registerAccount: vi.fn(),
  setupAdmin: vi.fn(),
  verifyMfaChallenge: vi.fn(),
}))

vi.mock('../../api/client', () => api)

describe('useAuthSession MFA flow', () => {
  beforeEach(() => {
    api.getCurrentSession.mockRejectedValue(new Error('unauthorized'))
    api.getSetupStatus.mockResolvedValue({ needsSetup: false })
    api.loginAdmin.mockResolvedValue({
      mfaRequired: true,
      challengeToken: 'mfa-challenge',
      expiresAt: '2026-08-01T10:05:00.000Z',
      methods: ['totp', 'recovery_code'],
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps normal guidance separate from an MFA verification error', async () => {
    const { result } = renderHook(() => useAuthSession())
    await waitFor(() => expect(result.current.mode).toBe('login'))

    act(() => result.current.setCredentials({
      email: 'owner@example.com', password: 'correct horse battery staple',
    }))
    await act(async () => result.current.authenticate())
    expect(result.current.mode).toBe('mfa')
    expect(result.current.mfaError).toBe('')

    api.verifyMfaChallenge.mockRejectedValueOnce(new Error('invalid authentication code'))
    await act(async () => {
      await expect(result.current.verifyMfa('000000')).rejects.toThrow('invalid authentication code')
    })
    expect(result.current.mfaError).toBe('invalid authentication code')

    api.verifyMfaChallenge.mockResolvedValueOnce({
      user: { id: 1, workspaceId: 1, email: 'owner@example.com', role: 'owner' },
      session: { token: 'session-token', expiresAt: '2026-08-08T00:00:00.000Z' },
      emailVerified: true,
    })
    await act(async () => result.current.verifyMfa('123456'))
    expect(result.current.mode).toBe('ready')
    expect(result.current.mfaError).toBe('')
  })
})
