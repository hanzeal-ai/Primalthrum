import { ArrowLeft, Loader2, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { acceptWorkspaceInvitation } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

interface InvitationAcceptPageProps {
  navigate?: (url: string) => void
  token: string
}

export function InvitationAcceptPage({
  navigate = (url) => window.location.assign(url),
  token,
}: InvitationAcceptPageProps) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(token ? '' : '邀请链接缺少令牌。')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || password.length < 12) {
      setError(token ? '密码至少需要 12 位。' : '邀请链接缺少令牌。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await acceptWorkspaceInvitation(token, password)
      navigate('/app')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法接受邀请。')
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen bg-white text-zinc-950 sm:grid-cols-[minmax(0,1fr)_minmax(400px,520px)]">
      <section className="hidden bg-zinc-950 p-10 text-white sm:flex sm:flex-col sm:justify-between">
        <a className="inline-flex items-center gap-2 text-sm font-medium" href="/"><ArrowLeft className="size-4" />Primalthrum</a>
        <div className="max-w-xl"><Users className="size-8 text-blue-400" /><h1 className="mt-6 text-4xl font-semibold leading-tight">加入团队，共同构建和运营 Agent。</h1><p className="mt-4 max-w-lg text-sm leading-6 text-zinc-300">接受后将直接进入邀请对应的 Workspace，角色与权限由邀请人设定。</p></div>
      </section>
      <section className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <a className="mb-10 inline-flex items-center gap-2 text-sm font-medium sm:hidden" href="/"><ArrowLeft className="size-4" />Primalthrum</a>
          <p className="text-sm font-medium text-blue-700">Workspace 邀请</p>
          <h2 className="mt-3 text-3xl font-semibold">加入 Workspace</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-600">新用户请设置密码；已有账号请输入现有密码确认身份。</p>
          <form className="mt-8 grid gap-5" onSubmit={submit}>
            <Label className="grid gap-2">账户密码
              <Input autoComplete="current-password" minLength={12} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 位" type="password" value={password} />
            </Label>
            {error ? <p className="border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p> : null}
            <Button className="h-11" disabled={submitting || !token} type="submit">
              {submitting ? <Loader2 className="animate-spin" /> : null}{submitting ? '正在加入...' : '接受邀请'}
            </Button>
          </form>
          <p className="mt-6 text-xs leading-5 text-zinc-500">邀请链接只能使用一次，并在创建 7 天后失效。</p>
        </div>
      </section>
    </main>
  )
}
