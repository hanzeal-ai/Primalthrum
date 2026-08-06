import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { OperatorSessionMode } from './useOperatorSession'

interface OperatorAuthPageProps {
  message: string
  mode: Extract<OperatorSessionMode, 'setup' | 'login' | 'password-change'>
  onAuthenticate: (input: {
    email: string
    password: string
    bootstrapToken?: string
  }) => Promise<void>
  onChangePassword: (input: {
    currentPassword: string
    password: string
  }) => Promise<void>
  setupEnabled: boolean
}

export function OperatorAuthPage({
  message,
  mode,
  onAuthenticate,
  onChangePassword,
  setupEnabled,
}: OperatorAuthPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [bootstrapToken, setBootstrapToken] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const busy = message.startsWith('正在')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'password-change') {
      await onChangePassword({ currentPassword, password })
      return
    }
    await onAuthenticate({ email, password, bootstrapToken })
  }

  const title = mode === 'setup'
    ? '初始化运营控制面'
    : mode === 'password-change' ? '更新临时密码' : '运营人员登录'
  const description = mode === 'setup'
    ? '创建首个独立 Super Admin 账号。'
    : mode === 'password-change'
      ? '首次登录必须更换临时密码。'
      : '使用独立 Operator 凭据访问平台运营数据。'

  return (
    <main className="grid min-h-screen place-items-center bg-zinc-100 px-4 py-10 text-zinc-950">
      <Card className="w-full max-w-md rounded-lg shadow-sm">
        <CardHeader className="gap-3">
          <div className="grid size-10 place-items-center rounded-md bg-zinc-950 text-white">
            <ShieldCheck className="size-5" />
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {mode === 'setup' && !setupEnabled ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              服务器未配置有效的 Operator Bootstrap Token。
            </div>
          ) : (
            <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
              {mode !== 'password-change' && (
                <Label>
                  邮箱
                  <Input
                    autoComplete="username"
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    type="email"
                    value={email}
                  />
                </Label>
              )}
              {mode === 'setup' && (
                <Label>
                  Bootstrap Token
                  <Input
                    autoComplete="off"
                    onChange={(event) => setBootstrapToken(event.target.value)}
                    required
                    type="password"
                    value={bootstrapToken}
                  />
                </Label>
              )}
              {mode === 'password-change' && (
                <Label>
                  当前密码
                  <Input
                    autoComplete="current-password"
                    minLength={16}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    required
                    type="password"
                    value={currentPassword}
                  />
                </Label>
              )}
              <Label>
                {mode === 'password-change' ? '新密码' : '密码'}
                <Input
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={16}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </Label>
              {message && !busy && (
                <p className="text-sm text-red-600" role="alert">{message}</p>
              )}
              <Button disabled={busy} type="submit">
                {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
                {mode === 'setup' ? '创建 Super Admin' : mode === 'login' ? '登录' : '更新密码'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
