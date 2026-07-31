import type { FormEvent } from 'react'
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react'

import type { AuthCredentials } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { AuthMode } from './useAuthSession'

interface AuthScreenProps {
  credentials: AuthCredentials
  message: string
  mode: Extract<AuthMode, 'setup' | 'login'>
  onChange: (value: AuthCredentials) => void
  onSubmit: () => Promise<void>
}

export function AuthScreen({ credentials, message, mode, onChange, onSubmit }: AuthScreenProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void onSubmit()
  }

  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 px-4 py-12 text-zinc-950">
      <Card className="w-full max-w-md border-zinc-200 shadow-lg shadow-zinc-950/5">
        <CardHeader>
          <a className="mb-4 flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-950" href="/"><ArrowLeft className="size-4" /> 返回首页</a>
          <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-zinc-950 text-white">
            <Sparkles className="size-5" />
          </div>
          <CardTitle>{mode === 'setup' ? '初始化 Primalthrum' : '欢迎回来'}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <Label className="grid gap-2">
              邮箱
              <Input
                autoComplete="email"
                onChange={(event) => onChange({ ...credentials, email: event.target.value })}
                type="email"
                value={credentials.email}
              />
            </Label>
            <Label className="grid gap-2">
              密码
              <Input
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                minLength={12}
                onChange={(event) => onChange({ ...credentials, password: event.target.value })}
                type="password"
                value={credentials.password}
              />
            </Label>
            <Button className="mt-2" type="submit">
              {message.includes('正在') ? <Loader2 className="animate-spin" /> : null}
              {mode === 'setup' ? '创建管理员' : '登录'}
            </Button>
          </form>
          {mode === 'login' ? <p className="mt-6 text-center text-sm text-zinc-600">还没有账号？ <a className="font-medium text-zinc-950 underline underline-offset-4" href="/signup?plan=pro">免费试用</a></p> : null}
          {mode === 'login' ? <p className="mt-3 text-center text-sm"><a className="text-zinc-500 hover:text-zinc-950" href="/forgot-password">忘记密码？</a></p> : null}
        </CardContent>
      </Card>
    </main>
  )
}
