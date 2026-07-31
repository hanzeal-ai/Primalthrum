import { ArrowLeft, ShieldCheck } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { MfaChallengeForm } from './MfaChallengeForm'

interface MfaChallengeScreenProps {
  busy: boolean
  error: string
  onBack: () => void
  onSubmit: (code: string) => Promise<void>
}

export function MfaChallengeScreen({ busy, error, onBack, onSubmit }: MfaChallengeScreenProps) {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 px-4 py-12 text-zinc-950">
      <Card className="w-full max-w-md border-zinc-200 shadow-lg shadow-zinc-950/5">
        <CardHeader>
          <Button className="mb-4 w-fit px-0 text-zinc-500" onClick={onBack} variant="ghost"><ArrowLeft />返回登录</Button>
          <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-emerald-700 text-white"><ShieldCheck className="size-5" /></div>
          <CardTitle>完成安全验证</CardTitle>
          <CardDescription>密码已验证，请完成账号的第二重验证。</CardDescription>
        </CardHeader>
        <CardContent><MfaChallengeForm busy={busy} error={error} onSubmit={onSubmit} /></CardContent>
      </Card>
    </main>
  )
}
