import { Loader2 } from 'lucide-react'

import { AuthScreen } from './features/auth/AuthScreen'
import { useAuthSession } from './features/auth/useAuthSession'
import { AgentBuilderPage } from './features/builder/AgentBuilderPage'
import { HostedAgentPage } from './features/hosted-agent/HostedAgentPage'
import { PublicHomePage } from './features/marketing/PublicHomePage'
import { PublicInfoPage } from './features/marketing/PublicInfoPage'
import { PublicPricingPage } from './features/marketing/PublicPricingPage'
import { SignupPage } from './features/onboarding/SignupPage'
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

  if (!auth.user) {
    return <PublicHomePage />
  }

  if (pathname === '/' && window.location.search.includes('marketing=1')) {
    return <PublicHomePage authenticated />
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
