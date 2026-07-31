import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PublicPricingPage } from './PublicPricingPage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PublicPricingPage', () => {
  it('renders the public catalog returned by the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        key: 'free', name: 'Free', status: 'active', currency: 'usd',
        monthlyPriceMinor: 0, monthlyCreditGrant: 1000, trialCreditGrant: 0,
        trialDays: 0, overageEnabled: false, metadata: {},
        entitlements: [{ feature: 'agents.create', enabled: true, quantityLimit: 2, source: 'plan' }],
      },
      {
        key: 'pro', name: 'Pro', status: 'active', currency: 'usd',
        monthlyPriceMinor: 2900, monthlyCreditGrant: 25000, trialCreditGrant: 10000,
        trialDays: 7, overageEnabled: true, metadata: {},
        entitlements: [{ feature: 'voice', enabled: true, quantityLimit: null, source: 'plan' }],
      },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })))

    render(<PublicPricingPage />)

    expect(await screen.findByRole('heading', { name: 'Free' })).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Pro' })).not.toBeNull()
    expect(screen.getByRole('link', { name: '7 天免费试用' }).getAttribute('href')).toBe('/signup?plan=pro')
    expect(screen.getByText('25,000 credits / 月')).not.toBeNull()
  })
})
