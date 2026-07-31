import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { getPrivacyConfig, recordAnalyticsEvent, recordPrivacyConsent } from '../../api/client'
import type { AnalyticsEventName } from '../../api/types'
import { ConsentBanner } from './ConsentBanner'
import { readPrivacyConsent, writePrivacyConsent, type StoredPrivacyConsent } from './privacyConsentStorage'

type AnalyticsProperties = Record<string, string | boolean>

interface PrivacyConsentContextValue {
  analyticsEnabled: boolean
  openPreferences: () => void
  track: (eventName: AnalyticsEventName, properties?: AnalyticsProperties) => Promise<boolean>
}

const PrivacyConsentContext = createContext<PrivacyConsentContextValue>({
  analyticsEnabled: false,
  openPreferences: () => undefined,
  track: async () => false,
})

export function PrivacyConsentProvider({ children }: { children: ReactNode }) {
  const [consent, setConsent] = useState<StoredPrivacyConsent | null>(() => readPrivacyConsent())
  const [policyVersion, setPolicyVersion] = useState('')
  const [ready, setReady] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pageViewKey = useRef('')

  useEffect(() => {
    void getPrivacyConfig()
      .then((config) => {
        setPolicyVersion(config.policyVersion)
        setConsent((current) => current?.policyVersion === config.policyVersion ? current : null)
      })
      .catch(() => setError('暂时无法保存隐私设置。'))
      .finally(() => setReady(true))
  }, [])

  const track = useCallback(async (
    eventName: AnalyticsEventName,
    properties: AnalyticsProperties = {},
  ): Promise<boolean> => {
    if (!consent?.analytics || consent.policyVersion !== policyVersion) return false
    try {
      await recordAnalyticsEvent({
        subjectId: consent.subjectId,
        consentReceiptId: consent.receiptId,
        eventId: window.crypto.randomUUID(),
        eventName,
        path: window.location.pathname,
        properties,
        occurredAt: new Date().toISOString(),
      })
      return true
    } catch {
      return false
    }
  }, [consent, policyVersion])

  useEffect(() => {
    const key = `${consent?.receiptId ?? ''}:${window.location.pathname}`
    if (!ready || !consent?.analytics || pageViewKey.current === key) return
    pageViewKey.current = key
    void track('page_view', { source: 'direct' })
  }, [consent, ready, track])

  async function save(analytics: boolean, source: 'banner' | 'preferences') {
    if (!policyVersion) return
    setSaving(true)
    setError('')
    try {
      const subjectId = consent?.subjectId ?? window.crypto.randomUUID()
      const receipt = await recordPrivacyConsent({ subjectId, policyVersion, analytics, source })
      const stored = {
        subjectId,
        receiptId: receipt.receiptId,
        policyVersion: receipt.policyVersion,
        analytics: receipt.analytics,
        recordedAt: receipt.recordedAt,
      }
      writePrivacyConsent(stored)
      setConsent(stored)
      setPreferencesOpen(false)
    } catch {
      setError('隐私设置保存失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  const value = useMemo<PrivacyConsentContextValue>(() => ({
    analyticsEnabled: Boolean(consent?.analytics && consent.policyVersion === policyVersion),
    openPreferences: () => setPreferencesOpen(true),
    track,
  }), [consent, policyVersion, track])

  return (
    <PrivacyConsentContext.Provider value={value}>
      {children}
      <ConsentBanner
        decided={Boolean(consent && consent.policyVersion === policyVersion)}
        error={error}
        initialAnalytics={Boolean(consent?.analytics)}
        onClosePreferences={() => setPreferencesOpen(false)}
        onOpenPreferences={() => setPreferencesOpen(true)}
        onSave={(analytics, source) => void save(analytics, source)}
        preferencesOpen={preferencesOpen}
        ready={ready}
        saving={saving}
      />
    </PrivacyConsentContext.Provider>
  )
}

export { PrivacyConsentContext }
