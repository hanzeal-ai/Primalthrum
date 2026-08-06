import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OperatorUser } from './operatorTypes'
import { OperatorConsolePage } from './OperatorConsolePage'

const api = vi.hoisted(() => ({
  createOperator: vi.fn(),
  createSupportGrant: vi.fn(),
  getOperatorOverview: vi.fn(),
  getSupportContext: vi.fn(),
  listOperatorAbuseEvents: vi.fn(),
  listOperatorAgents: vi.fn(),
  listOperatorAudit: vi.fn(),
  listOperatorCustomerUsers: vi.fn(),
  listOperatorJobs: vi.fn(),
  listOperatorPayments: vi.fn(),
  listOperatorSubscriptions: vi.fn(),
  listOperatorUsage: vi.fn(),
  listOperators: vi.fn(),
  listOperatorWorkspaces: vi.fn(),
  listSupportGrants: vi.fn(),
  revokeSupportGrant: vi.fn(),
}))

vi.mock('./operatorClient', () => api)

const overview = {
  overview: {
    workspaces: 4,
    users: 12,
    activeSubscriptions: 3,
    agents: 18,
    failedJobs: 1,
    failedPayments: 0,
    abuseEnforcements: 2,
    activeSupportGrants: 1,
    monthlyCredits: 200,
    monthlyProviderCostMicros: 1_250_000,
  },
  readiness: {
    status: 'ready',
    service: 'server',
    checks: [{ name: 'database', status: 'ok', latencyMs: 1 }],
  },
}

describe('OperatorConsolePage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/operator')
    api.getOperatorOverview.mockResolvedValue(overview)
    api.listOperatorAbuseEvents.mockResolvedValue([])
    api.listOperatorAgents.mockResolvedValue([])
    api.listOperatorCustomerUsers.mockResolvedValue([])
    api.listOperatorJobs.mockResolvedValue([])
    api.listOperatorPayments.mockResolvedValue({ invoices: [], refunds: [], webhookFailures: [] })
    api.listOperatorSubscriptions.mockResolvedValue([])
    api.listOperatorUsage.mockResolvedValue([])
    api.listOperatorWorkspaces.mockResolvedValue([])
    api.listOperators.mockResolvedValue([])
    api.listSupportGrants.mockResolvedValue([])
    api.listOperatorAudit.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps viewer navigation read-only', async () => {
    render(<OperatorConsolePage onLogout={vi.fn()} user={operator('viewer')} />)

    expect(await screen.findByText('18')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '支持访问' })).toBeNull()
    expect(screen.queryByRole('button', { name: '客户' })).toBeNull()
    expect(screen.queryByRole('button', { name: '计费' })).toBeNull()
    expect(screen.queryByRole('button', { name: '运行' })).toBeNull()
    expect(screen.queryByRole('button', { name: '安全' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Operators' })).toBeNull()
    expect(screen.queryByRole('button', { name: '审计' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Workspaces' }).length).toBeGreaterThan(0)
  })

  it('shows Super Admin operations and loads support data on demand', async () => {
    render(<OperatorConsolePage onLogout={vi.fn()} user={operator('super_admin')} />)
    expect(await screen.findByText('系统健康')).toBeTruthy()

    const supportButtons = screen.getAllByRole('button', { name: '支持访问' })
    fireEvent.click(supportButtons[0])

    await waitFor(() => expect(api.listSupportGrants).toHaveBeenCalled())
    expect(api.listOperatorWorkspaces).toHaveBeenCalled()
    expect(api.listOperators).toHaveBeenCalled()
    expect(await screen.findByText('创建限时授权')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '计费' })[0])
    await waitFor(() => expect(api.listOperatorSubscriptions).toHaveBeenCalled())
    expect(api.listOperatorUsage).toHaveBeenCalled()
    expect(api.listOperatorPayments).toHaveBeenCalled()
    expect(await screen.findByText('支付事件')).toBeTruthy()
  })
})

function operator(role: OperatorUser['role']): OperatorUser {
  return {
    id: 1,
    email: `${role}@example.com`,
    role,
    status: 'active',
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-08-06T00:00:00.000Z',
  }
}
