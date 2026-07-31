import { useContext } from 'react'

import { PrivacyConsentContext } from './PrivacyConsentProvider'

export function usePrivacyConsent() {
  return useContext(PrivacyConsentContext)
}
