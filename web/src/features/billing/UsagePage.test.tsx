import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UsagePage } from './UsagePage'

const api = vi.hoisted(() => ({
  getBillingSummary: vi.fn(),
  getBillingUsage: vi.fn(),
  listBillingCostAlerts: vi.fn(),
  listWorkspaces: vi.fn(),
  updateBillingCostControls: vi.fn(),
}))

vi.mock('../../api/client', () => api)

describe('UsagePage', () => {
  beforeEach(() => {
    api.listWorkspaces.mockResolvedValue([{ id: 1, name: 'Acme', slug: 'acme', role: 'owner' }])
    api.getBillingSummary.mockResolvedValue({
      entitlementSnapshot: {
        workspaceId: 1, planKey: 'pro', subscriptionState: 'active',
        generatedAt: '2026-07-31T00:00:00.000Z', entitlements: {},
      },
      creditAccount: {
        workspaceId: 1, availableCredits: 18000, reservedCredits: 1000,
        spentCredits: 6000, updatedAt: '2026-07-31T00:00:00.000Z',
      },
      subscription: {
        workspaceId: 1, planKey: 'pro', state: 'active',
        periodStartsAt: '2026-07-01T00:00:00.000Z', periodEndsAt: '2026-08-01T00:00:00.000Z',
        trialEndsAt: null, cancelAtPeriodEnd: false, provider: 'stripe',
        providerCustomerRef: 'cus_1', providerSubscriptionRef: 'sub_1',
        providerPriceRef: 'price_1', providerSubscriptionItemRef: 'si_1',
        pendingPlanKey: '', graceEndsAt: null, canceledAt: null,
      },
      invoices: [],
    })
    api.getBillingUsage.mockResolvedValue({
      workspaceId: 1,
      periodStartsAt: '2026-07-01T00:00:00.000Z',
      periodEndsAt: '2026-08-01T00:00:00.000Z',
      creditsCharged: 6000,
      providerCostMicros: 1750000,
      eventCount: 12,
      byMeter: [{
        meter: 'llm.input_tokens', quantity: 42000, creditsCharged: 4000,
        providerCostMicros: 1250000,
      }],
      controls: {
        workspaceId: 1, monthlyCreditLimit: 20000,
        monthlyProviderCostMicrosLimit: 5000000, hardLimit: true,
        overageEnabled: false, alertThresholds: [50, 80, 100],
      },
    })
    api.listBillingCostAlerts.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders meter evidence and saves owner cost controls', async () => {
    api.updateBillingCostControls.mockResolvedValue({
      workspaceId: 1, monthlyCreditLimit: 24000,
      monthlyProviderCostMicrosLimit: 6000000, hardLimit: true,
      overageEnabled: false, alertThresholds: [50, 80, 100],
    })

    render(<UsagePage onLogout={vi.fn()} user={{
      id: 1, workspaceId: 1, email: 'owner@example.com', role: 'owner',
    }} />)

    expect(await screen.findByRole('heading', { name: '用量与成本' })).toBeTruthy()
    expect(screen.getByText('模型输入')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('月度 credits 上限'), { target: { value: '24000' } })
    fireEvent.change(screen.getByLabelText('月度 Provider 成本上限'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: '保存成本控制' }))

    await waitFor(() => expect(api.updateBillingCostControls).toHaveBeenCalledWith({
      monthlyCreditLimit: 24000,
      monthlyProviderCostMicrosLimit: 6000000,
      hardLimit: true,
      overageEnabled: false,
      alertThresholds: [50, 80, 100],
    }))
  })
})
