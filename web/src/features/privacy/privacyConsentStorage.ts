const STORAGE_KEY = 'primalthrum.privacy-consent'

export interface StoredPrivacyConsent {
  subjectId: string
  receiptId: string
  policyVersion: string
  analytics: boolean
  recordedAt: string
}

export function readPrivacyConsent(): StoredPrivacyConsent | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<StoredPrivacyConsent>
    if (typeof parsed.subjectId !== 'string'
      || typeof parsed.receiptId !== 'string'
      || typeof parsed.policyVersion !== 'string'
      || typeof parsed.analytics !== 'boolean'
      || typeof parsed.recordedAt !== 'string') return null
    return parsed as StoredPrivacyConsent
  } catch {
    return null
  }
}

export function writePrivacyConsent(consent: StoredPrivacyConsent): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(consent))
}
