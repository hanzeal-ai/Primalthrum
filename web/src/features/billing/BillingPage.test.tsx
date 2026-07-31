import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BillingPage } from './BillingPage'

const api = vi.hoisted(() => ({
  cancelBillingSubscription: vi.fn(),
  createBillingCheckout: vi.fn(),
  createBillingPortal: vi.fn(),
  getBillingSummary: vi.fn(),
  listPublicPlans: vi.fn(),
  listWorkspaces: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const summary = {
  entitlementSnapshot: {
    workspaceId: 1,
    planKey: 'free',
    subscriptionState: 'active',
    generatedAt: '2026-07-31T00:00:00.000Z',
    entitlements: {},
  },
  creditAccount: {
    workspaceId: 1,
    availableCredits: 750,
    reservedCredits: 50,
    spentCredits: 200,
    updatedAt: '2026-07-31T00:00:00.000Z',
  },
  subscription: {
    workspaceId: 1,
    planKey: 'free',
    state: 'active',
    periodStartsAt: '2026-07-01T00:00:00.000Z',
    periodEndsAt: '2026-08-01T00:00:00.000Z',
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    provider: '',
    providerCustomerRef: '',
    providerSubscriptionRef: '',
    providerPriceRef: '',
    providerSubscriptionItemRef: '',
    pendingPlanKey: '',
    graceEndsAt: null,
    canceledAt: null,
  },
  invoices: [],
}

const plans = [
  {
    key: 'free', name: 'Free', status: 'active', currency: 'usd',
    monthlyPriceMinor: 0, monthlyCreditGrant: 1000, trialCreditGrant: 0,
    trialDays: 0, overageEnabled: false, metadata: {}, entitlements: [],
  },
  {
    key: 'pro', name: 'Pro', status: 'active', currency: 'usd',
    monthlyPriceMinor: 2900, monthlyCreditGrant: 25000, trialCreditGrant: 10000,
    trialDays: 7, overageEnabled: true, metadata: {}, entitlements: [],
  },
]

describe('BillingPage', () => {
  beforeEach(() => {
    api.getBillingSummary.mockResolvedValue(summary)
    api.listPublicPlans.mockResolvedValue(plans)
    api.listWorkspaces.mockResolvedValue([{ id: 1, name: 'Acme', slug: 'acme', role: 'owner' }])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the current plan and starts hosted checkout for an owner', async () => {
    const navigate = vi.fn()
    api.createBillingCheckout.mockResolvedValue({ checkoutUrl: 'https://checkout.example/session' })

    render(<BillingPage navigate={navigate} onLogout={vi.fn()} user={{
      id: 1, workspaceId: 1, email: 'owner@example.com', role: 'owner',
    }} />)

    expect(await screen.findByRole('heading', { name: '账单与套餐' })).toBeTruthy()
    expect(screen.getByText('750')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '升级到 Pro' }))

    await waitFor(() => expect(api.createBillingCheckout).toHaveBeenCalledWith('pro'))
    expect(navigate).toHaveBeenCalledWith('https://checkout.example/session')
  })

  it('keeps payment mutations hidden from a read-only admin', async () => {
    render(<BillingPage onLogout={vi.fn()} user={{
      id: 2, workspaceId: 1, email: 'admin@example.com', role: 'admin',
    }} />)

    expect(await screen.findByRole('heading', { name: 'Free', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '升级到 Pro' })).toBeNull()
    expect(screen.getByText('只有 Workspace Owner 或 Billing 可以管理订阅。')).toBeTruthy()
  })
})
