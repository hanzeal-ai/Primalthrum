import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InvitationAcceptPage } from './InvitationAcceptPage'

const api = vi.hoisted(() => ({ acceptWorkspaceInvitation: vi.fn() }))
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
})
