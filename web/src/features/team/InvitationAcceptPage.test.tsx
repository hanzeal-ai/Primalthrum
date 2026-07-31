import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InvitationAcceptPage } from './InvitationAcceptPage'

const api = vi.hoisted(() => ({
  acceptWorkspaceInvitation: vi.fn(),
  isMfaChallengeResponse: vi.fn((response: Record<string, unknown>) => response.mfaRequired === true),
  verifyMfaChallenge: vi.fn(),
}))
vi.mock('../../api/client', () => api)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('InvitationAcceptPage', () => {
  it('accepts the token with a password and opens the invited workspace', async () => {
    const navigate = vi.fn()
    api.acceptWorkspaceInvitation.mockResolvedValue({
      user: { id: 2, workspaceId: 7, email: 'member@example.com', role: 'member' },
      session: { token: 'session-token', expiresAt: '2026-08-07T00:00:00.000Z' },
      emailVerified: true,
    })

    render(<InvitationAcceptPage navigate={navigate} token="invite-token" />)
    fireEvent.change(screen.getByLabelText('账户密码'), { target: { value: 'new member password' } })
    fireEvent.click(screen.getByRole('button', { name: '接受邀请' }))

    await waitFor(() => expect(api.acceptWorkspaceInvitation)
      .toHaveBeenCalledWith('invite-token', 'new member password'))
    expect(navigate).toHaveBeenCalledWith('/app')
  })

  it('completes an MFA challenge before opening the invited workspace', async () => {
    const navigate = vi.fn()
    api.acceptWorkspaceInvitation.mockResolvedValue({
      mfaRequired: true,
      challengeToken: 'mfa-challenge',
      expiresAt: '2026-08-01T10:05:00.000Z',
      methods: ['totp', 'recovery_code'],
    })
    api.verifyMfaChallenge.mockResolvedValue({
      user: { id: 2, workspaceId: 7, email: 'member@example.com', role: 'member' },
      session: { token: 'session-token', expiresAt: '2026-08-07T00:00:00.000Z' },
      emailVerified: true,
    })

    render(<InvitationAcceptPage navigate={navigate} token="invite-token" />)
    fireEvent.change(screen.getByLabelText('账户密码'), { target: { value: 'existing user password' } })
    fireEvent.click(screen.getByRole('button', { name: '接受邀请' }))
    expect(await screen.findByRole('heading', { name: '完成安全验证' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('验证码或恢复码'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并加入' }))

    await waitFor(() => expect(api.verifyMfaChallenge).toHaveBeenCalledWith({
      challengeToken: 'mfa-challenge', code: '123456',
    }))
    expect(navigate).toHaveBeenCalledWith('/app')
  })
})
