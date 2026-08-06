import { Loader2 } from 'lucide-react'

import { OperatorAuthPage } from './OperatorAuthPage'
import { OperatorConsolePage } from './OperatorConsolePage'
import { useOperatorSession } from './useOperatorSession'

export function OperatorApp() {
  const session = useOperatorSession()

  if (session.mode === 'checking') {
    return (
      <main className="grid min-h-screen place-items-center bg-zinc-100 text-zinc-950">
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" />
          正在连接运营控制面
        </div>
      </main>
    )
  }

  if (
    session.mode === 'setup'
    || session.mode === 'login'
    || session.mode === 'password-change'
  ) {
    return (
      <OperatorAuthPage
        message={session.message}
        mode={session.mode}
        onAuthenticate={session.authenticate}
        onChangePassword={session.changePassword}
        setupEnabled={session.setupEnabled}
      />
    )
  }

  if (!session.user) return null
  return <OperatorConsolePage onLogout={session.logout} user={session.user} />
}
