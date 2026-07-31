import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TeamPage } from './TeamPage'

const api = vi.hoisted(() => ({
  createWorkspaceInvitation: vi.fn(),
  getBillingSummary: vi.fn(),
  listWorkspaces: vi.fn(),
  listWorkspaceInvitations: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
  updateWorkspaceMemberRole: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const members = [
  {
    id: 1, workspaceId: 1, userId: 1, email: 'owner@example.com', role: 'owner',
    status: 'active', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 2, workspaceId: 1, userId: 2, email: 'viewer@example.com', role: 'viewer',
    status: 'active', createdAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z',
  },
]

describe('TeamPage', () => {
  beforeEach(() => {
    api.listWorkspaces.mockResolvedValue([{ id: 1, name: 'Acme', slug: 'acme', role: 'owner' }])
    api.listWorkspaceMembers.mockResolvedValue(members)
    api.listWorkspaceInvitations.mockResolvedValue([])
    api.getBillingSummary.mockResolvedValue({
      entitlementSnapshot: { entitlements: { seats: { quantityLimit: 3 } } },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates an invitation link and changes a member role', async () => {
    api.createWorkspaceInvitation.mockResolvedValue({
      id: 7, workspaceId: 1, email: 'new@example.com', role: 'member',
      expiresAt: '2026-08-07T00:00:00.000Z', acceptedAt: null, revokedAt: null,
      createdAt: '2026-07-31T00:00:00.000Z', token: 'invite-token',
      acceptUrl: 'http://localhost/accept-invitation?token=invite-token',
    })
    api.updateWorkspaceMemberRole.mockResolvedValue({ ...members[1], role: 'developer' })

    render(<TeamPage onLogout={vi.fn()} user={{
      id: 1, workspaceId: 1, email: 'owner@example.com', role: 'owner',
    }} />)

    expect(await screen.findByRole('heading', { name: '团队成员' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('邀请邮箱'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '创建邀请' }))
    await waitFor(() => expect(api.createWorkspaceInvitation).toHaveBeenCalledWith(1, {
      email: 'new@example.com', role: 'member',
    }))
    expect(screen.getByLabelText('邀请链接')).toHaveProperty('value', expect.stringContaining('invite-token'))

    fireEvent.change(screen.getByLabelText('调整 viewer@example.com 的角色'), {
      target: { value: 'developer' },
    })
    await waitFor(() => expect(api.updateWorkspaceMemberRole).toHaveBeenCalledWith(1, 2, 'developer'))
  })

  it('keeps member management read-only for a developer', async () => {
    render(<TeamPage onLogout={vi.fn()} user={{
      id: 2, workspaceId: 1, email: 'viewer@example.com', role: 'developer',
    }} />)

    expect(await screen.findByText('2 位成员')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: '团队' }).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('邀请邮箱')).toBeNull()
    expect(screen.queryByLabelText('调整 viewer@example.com 的角色')).toBeNull()
  })
})
