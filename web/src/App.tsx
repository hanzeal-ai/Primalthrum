import { Loader2 } from 'lucide-react'

import { AuthScreen } from './features/auth/AuthScreen'
import { EmailVerificationPage } from './features/auth/EmailVerificationPage'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { MfaChallengeScreen } from './features/auth/MfaChallengeScreen'
import { ResetPasswordPage } from './features/auth/ResetPasswordPage'
import { useAuthSession } from './features/auth/useAuthSession'
import { WorkspaceAccessDeniedPage } from './features/app-shell/WorkspaceAccessDeniedPage'
import { BillingPage } from './features/billing/BillingPage'
import { UsagePage } from './features/billing/UsagePage'
import { AgentBuilderPage } from './features/builder/AgentBuilderPage'
import { HostedAgentPage } from './features/hosted-agent/HostedAgentPage'
import { PublicHomePage } from './features/marketing/PublicHomePage'
import { PublicInfoPage } from './features/marketing/PublicInfoPage'
import { PublicPricingPage } from './features/marketing/PublicPricingPage'
import { SignupPage } from './features/onboarding/SignupPage'
import { SecuritySettingsPage } from './features/settings/SecuritySettingsPage'
import { InvitationAcceptPage } from './features/team/InvitationAcceptPage'
import { TeamPage } from './features/team/TeamPage'
import { canReadAgents, canReadBilling } from './lib/workspacePermissions'
import './App.css'

export default function App() {
  const auth = useAuthSession()
  const agentSlug = hostedAgentSlug(window.location.pathname)
  const preview = previewAgentRoute(window.location.pathname, window.location.search)
  const pathname = normalizePath(window.location.pathname)

  if (auth.mode === 'checking') {
    return (
      <main className="grid min-h-screen place-items-center bg-zinc-50 text-zinc-950">
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" />
          正在连接 Primalthrum
        </div>
      </main>
    )
  }

  const authScreen = auth.mode === 'setup' || auth.mode === 'login'
    ? (
      <AuthScreen
        credentials={auth.credentials}
        message={auth.message}
        mode={auth.mode}
        onChange={auth.setCredentials}
        onSubmit={auth.authenticate}
      />
    )
    : auth.mode === 'mfa' && auth.mfaChallenge
      ? <MfaChallengeScreen busy={auth.message.includes('正在')} error={auth.mfaError} onBack={auth.cancelMfa} onSubmit={auth.verifyMfa} />
    : null

  if (preview && auth.user) {
    return (
      <HostedAgentPage
        onBack={() => window.location.assign(auth.user ? '/app' : '/')}
        slug={preview.slug}
        user={auth.user}
        versionId={preview.versionId}
      />
    )
  }

  if (agentSlug) {
    if (auth.user) {
      return (
        <HostedAgentPage
          onBack={() => window.location.assign('/app')}
          slug={agentSlug}
          user={auth.user}
        />
      )
    }

    if (authScreen) {
      return (
        <HostedAgentPage
          access="public"
          onBack={() => window.location.assign('/')}
          slug={agentSlug}
          unavailableFallback={authScreen}
        />
      )
    }
  }

  if (pathname === '/pricing') {
    return <PublicPricingPage authenticated={Boolean(auth.user)} />
  }

  if (pathname === '/verify-email') {
    return (
      <EmailVerificationPage
        authenticated={Boolean(auth.user)}
        email={auth.user?.email}
        onLogout={auth.logout}
        onPreviewUrl={auth.updateEmailPreview}
        onVerified={auth.refreshSession}
        previewUrl={auth.emailPreviewUrl}
      />
    )
  }

  if (pathname === '/forgot-password') return <ForgotPasswordPage />
  if (pathname === '/reset-password') return <ResetPasswordPage />
  if (pathname === '/accept-invitation') {
    return <InvitationAcceptPage token={new URLSearchParams(window.location.search).get('token') ?? ''} />
  }

  const infoSlug = publicInfoSlug(pathname)
  if (infoSlug) {
    return <PublicInfoPage authenticated={Boolean(auth.user)} slug={infoSlug} />
  }

  if (!auth.user && pathname === '/signup') {
    return <SignupPage message={auth.message} onRegister={auth.register} />
  }

  if (!auth.user && pathname === '/login') {
    return authScreen
  }

  if (auth.user && !auth.emailVerified) {
    return (
      <EmailVerificationPage
        authenticated
        email={auth.user.email}
        onLogout={auth.logout}
        onPreviewUrl={auth.updateEmailPreview}
        onVerified={auth.refreshSession}
        previewUrl={auth.emailPreviewUrl}
      />
    )
  }

  if (!auth.user) {
    return <PublicHomePage />
  }

  if (pathname === '/' && window.location.search.includes('marketing=1')) {
    return <PublicHomePage authenticated />
  }

  if (pathname === '/app/billing') {
    if (!canReadBilling(auth.user.role)) {
      return <WorkspaceAccessDeniedPage active="billing" user={auth.user} onLogout={auth.logout} />
    }
    return <BillingPage user={auth.user} onLogout={auth.logout} />
  }

  if (pathname === '/app/team') {
    return <TeamPage user={auth.user} onLogout={auth.logout} />
  }

  if (pathname === '/app/settings') {
    return <SecuritySettingsPage user={auth.user} onLogout={auth.logout} />
  }

  if (pathname === '/app/usage') {
    if (!canReadBilling(auth.user.role)) {
      return <WorkspaceAccessDeniedPage active="usage" user={auth.user} onLogout={auth.logout} />
    }
    return <UsagePage user={auth.user} onLogout={auth.logout} />
  }

  if (!canReadAgents(auth.user.role)) {
    return <BillingPage user={auth.user} onLogout={auth.logout} />
  }

  return <AgentBuilderPage user={auth.user} onLogout={auth.logout} />
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '')
  return normalized || '/'
}

function publicInfoSlug(pathname: string) {
  const match = /^\/(security|docs|contact|status|legal\/privacy|legal\/terms)$/.exec(pathname)
  return match?.[1] ?? null
}

function hostedAgentSlug(pathname: string): string | null {
  const match = /^\/a\/([^/]+)\/?$/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function previewAgentRoute(
  pathname: string,
  search: string,
): { slug: string; versionId: number } | null {
  const match = /^\/preview\/a\/([^/]+)\/?$/.exec(pathname)
  const versionId = Number(new URLSearchParams(search).get('version'))
  if (!match?.[1] || !Number.isInteger(versionId) || versionId <= 0) return null
  return { slug: decodeURIComponent(match[1]), versionId }
}
