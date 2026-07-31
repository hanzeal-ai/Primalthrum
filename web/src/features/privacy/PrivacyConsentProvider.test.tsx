import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getPrivacyConfig, recordAnalyticsEvent, recordPrivacyConsent } from '../../api/client'
import { PrivacyConsentProvider } from './PrivacyConsentProvider'
import { usePrivacyConsent } from './usePrivacyConsent'

vi.mock('../../api/client', () => ({
  getPrivacyConfig: vi.fn(),
  recordAnalyticsEvent: vi.fn(),
  recordPrivacyConsent: vi.fn(),
}))

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
  vi.mocked(getPrivacyConfig).mockResolvedValue({
    policyVersion: '2026-07-31',
    categories: {
      necessary: { required: true },
      analytics: { required: false, default: false },
    },
  })
  vi.mocked(recordAnalyticsEvent).mockResolvedValue()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PrivacyConsentProvider', () => {
  it('defaults to necessary only and stores the server receipt', async () => {
    vi.mocked(recordPrivacyConsent).mockResolvedValue({
      receiptId: '11111111-1111-4111-8111-111111111111',
      policyVersion: '2026-07-31',
      necessary: true,
      analytics: false,
      action: 'denied',
      recordedAt: '2026-07-31T00:00:00.000Z',
    })
    render(<PrivacyConsentProvider><div>Product</div></PrivacyConsentProvider>)

    fireEvent.click(await screen.findByRole('button', { name: '仅必要' }))
    await waitFor(() => expect(recordPrivacyConsent).toHaveBeenCalledWith(expect.objectContaining({
      analytics: false,
      policyVersion: '2026-07-31',
      source: 'banner',
    })))
    expect(screen.queryByLabelText('隐私设置')).toBeNull()
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('primalthrum.privacy-consent')).toContain('"analytics":false')
  })

  it('records page views only after analytics is granted and supports reopening settings', async () => {
    vi.mocked(recordPrivacyConsent).mockResolvedValue({
      receiptId: '22222222-2222-4222-8222-222222222222',
      policyVersion: '2026-07-31',
      necessary: true,
      analytics: true,
      action: 'granted',
      recordedAt: '2026-07-31T00:00:00.000Z',
    })
    render(<PrivacyConsentProvider><SettingsButton /></PrivacyConsentProvider>)

    fireEvent.click(await screen.findByRole('button', { name: '全部接受' }))
    await waitFor(() => expect(recordAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'page_view',
      properties: { source: 'direct' },
    })))
    fireEvent.click(screen.getByRole('button', { name: 'Open preferences' }))
    expect(screen.getByRole('dialog', { name: '隐私设置' })).not.toBeNull()
    expect((screen.getByRole('checkbox', { name: '产品分析' }) as HTMLInputElement).checked).toBe(true)
  })
})

function SettingsButton() {
  const privacy = usePrivacyConsent()
  return <button onClick={privacy.openPreferences} type="button">Open preferences</button>
}
