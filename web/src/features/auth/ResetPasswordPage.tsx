import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { resetPassword } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [complete, setComplete] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (password.length < 12 || password !== confirmation || !token) {
      setMessage(!token ? '重置链接无效。' : password !== confirmation ? '两次密码输入不一致。' : '密码至少 12 位。')
      return
    }
    setSubmitting(true)
    try {
      await resetPassword(token, password)
      setComplete(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '密码重置失败。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 px-4 py-12">
      <section className="w-full max-w-md border border-zinc-200 bg-white p-7 shadow-lg shadow-zinc-950/5">
        <a className="flex items-center gap-2 text-sm text-zinc-500" href="/login"><ArrowLeft className="size-4" /> 返回登录</a>
        <h1 className="mt-8 text-2xl font-semibold">设置新密码</h1>
        {complete ? (
          <div className="mt-6"><CheckCircle2 className="size-6 text-emerald-700" /><p className="mt-4 text-sm text-zinc-600">密码已更新，其他设备上的登录状态已失效。</p><Button asChild className="mt-6 w-full"><a href="/login">使用新密码登录</a></Button></div>
        ) : (
          <form className="mt-6 grid gap-5" onSubmit={submit}>
            <Label className="grid gap-2">新密码<Input autoComplete="new-password" minLength={12} onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Label>
            <Label className="grid gap-2">确认新密码<Input autoComplete="new-password" minLength={12} onChange={(event) => setConfirmation(event.target.value)} type="password" value={confirmation} /></Label>
            {message ? <p className="text-sm text-red-700" role="alert">{message}</p> : null}
            <Button disabled={submitting} type="submit">{submitting ? <Loader2 className="animate-spin" /> : null}更新密码</Button>
          </form>
        )}
      </section>
    </main>
  )
}
