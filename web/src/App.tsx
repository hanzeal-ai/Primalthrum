import { Loader2 } from 'lucide-react'

import { AuthScreen } from './features/auth/AuthScreen'
import { useAuthSession } from './features/auth/useAuthSession'
import { AgentBuilderPage } from './features/builder/AgentBuilderPage'
import './App.css'

export default function App() {
  const auth = useAuthSession()

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

  if (auth.mode === 'setup' || auth.mode === 'login') {
    return (
      <AuthScreen
        credentials={auth.credentials}
        message={auth.message}
        mode={auth.mode}
        onChange={auth.setCredentials}
        onSubmit={auth.authenticate}
      />
    )
  }

  if (!auth.user) {
    return null
  }

  return <AgentBuilderPage user={auth.user} onLogout={auth.logout} />
}
