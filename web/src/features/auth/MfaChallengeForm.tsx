import { KeyRound, Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

interface MfaChallengeFormProps {
  busy?: boolean
  error?: string
  onSubmit: (code: string) => Promise<void>
  submitLabel?: string
}

export function MfaChallengeForm({
  busy = false,
  error = '',
  onSubmit,
  submitLabel = '验证并继续',
}: MfaChallengeFormProps) {
  const [code, setCode] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (code.trim()) void onSubmit(code.trim())
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Label className="grid gap-2">
        验证码或恢复码
        <Input
          aria-label="验证码或恢复码"
          autoComplete="one-time-code"
          autoFocus
          disabled={busy}
          inputMode="numeric"
          onChange={(event) => setCode(event.target.value)}
          placeholder="6 位验证码"
          value={code}
        />
      </Label>
      <p className="text-xs leading-5 text-zinc-500">输入身份验证器中的 6 位验证码，也可以使用一个尚未使用的恢复码。</p>
      {error ? <p className="border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p> : null}
      <Button disabled={busy || !code.trim()} type="submit">
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {busy ? '正在验证...' : submitLabel}
      </Button>
    </form>
  )
}
