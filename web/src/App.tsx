import { Loader2 } from 'lucide-react'

import { AuthScreen } from './features/auth/AuthScreen'
import { useAuthSession } from './features/auth/useAuthSession'
import { AgentBuilderPage } from './features/builder/AgentBuilderPage'
import { HostedAgentPage } from './features/hosted-agent/HostedAgentPage'
import './App.css'

export default function App() {
  const auth = useAuthSession()
  const agentSlug = hostedAgentSlug(window.location.pathname)

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

  if (agentSlug) {
    if (auth.user) {
      return (
        <HostedAgentPage
          onBack={() => window.location.assign('/')}
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

  if (authScreen) {
    return authScreen
  }

  if (!auth.user) {
    return null
  }

  return <AgentBuilderPage user={auth.user} onLogout={auth.logout} />
}

function hostedAgentSlug(pathname: string): string | null {
  const match = /^\/a\/([^/]+)\/?$/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}
