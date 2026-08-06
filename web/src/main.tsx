import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { PrivacyConsentProvider } from './features/privacy/PrivacyConsentProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {window.location.pathname.startsWith('/operator')
        ? <App />
        : <PrivacyConsentProvider><App /></PrivacyConsentProvider>}
    </ErrorBoundary>
  </StrictMode>,
)
