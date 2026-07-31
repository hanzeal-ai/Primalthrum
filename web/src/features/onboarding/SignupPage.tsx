import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'

import type { RegistrationInput, RegistrationResponse } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

interface SignupPageProps {
  message: string
  onRegister: (input: RegistrationInput) => Promise<RegistrationResponse>
}

export function SignupPage({ message, onRegister }: SignupPageProps) {
  const planKey = useMemo<'free' | 'pro'>(() => (
    new URLSearchParams(window.location.search).get('plan') === 'free' ? 'free' : 'pro'
  ), [])
  const [form, setForm] = useState({ email: '', password: '', workspaceName: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.workspaceName.trim() || !form.email.trim() || form.password.length < 12) {
      setError('请填写工作区名称和有效邮箱，密码至少 12 位。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onRegister({ ...form, workspaceName: form.workspaceName.trim(), planKey })
      window.location.assign('/app')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '注册失败，请稍后重试。')
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]">
      <section className="relative hidden min-h-screen overflow-hidden bg-zinc-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <img alt="Primalthrum Agent 创建器界面" className="absolute inset-0 h-full w-full object-cover opacity-45" src="/product-builder.jpg" />
        <div className="absolute inset-0 bg-zinc-950/60" />
        <a className="relative flex items-center gap-2 text-sm font-medium" href="/"><ArrowLeft className="size-4" /> Primalthrum</a>
        <div className="relative max-w-xl">
          <h1 className="text-4xl font-semibold leading-tight">从一句需求开始，得到一个可直接使用的 Agent。</h1>
          <ul className="mt-8 grid gap-4 text-sm text-zinc-200">
            <Benefit text="7 天 Pro 试用与 10,000 credits" />
            <Benefit text="LLM、RAG、Tool、Skill、Memory 与 Cache 可配置" />
            <Benefit text="创建后直接打开独立文字与语音对话页" />
          </ul>
        </div>
      </section>
      <section className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-md">
          <a className="mb-10 inline-flex items-center gap-2 text-sm font-medium lg:hidden" href="/"><ArrowLeft className="size-4" /> Primalthrum</a>
          <p className="text-sm font-medium text-blue-700">{planKey === 'pro' ? 'Pro 免费试用' : 'Free 套餐'}</p>
          <h2 className="mt-3 text-3xl font-semibold">创建你的工作区</h2>
          <p className="mt-3 text-sm text-zinc-600">{planKey === 'pro' ? '7 天试用，无需信用卡。' : '包含 1,000 credits，可随时升级。'}</p>
          <form className="mt-8 grid gap-5" onSubmit={submit}>
            <Label className="grid gap-2">工作区名称
              <Input autoComplete="organization" autoFocus onChange={(event) => setForm({ ...form, workspaceName: event.target.value })} placeholder="Acme Agents" value={form.workspaceName} />
            </Label>
            <Label className="grid gap-2">工作邮箱
              <Input autoComplete="email" onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@company.com" type="email" value={form.email} />
            </Label>
            <Label className="grid gap-2">密码
              <Input autoComplete="new-password" minLength={12} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="至少 12 位" type="password" value={form.password} />
            </Label>
            {error ? <p className="border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p> : null}
            <Button className="h-11" disabled={submitting} type="submit">
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {submitting ? message : planKey === 'pro' ? '开始 7 天免费试用' : '创建免费工作区'}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-zinc-600">已有账号？ <a className="font-medium text-zinc-950 underline underline-offset-4" href="/login">登录</a></p>
          <p className="mt-8 text-xs leading-5 text-zinc-500">继续即表示你同意<a className="underline" href="/legal/terms">服务条款</a>和<a className="underline" href="/legal/privacy">隐私说明</a>。</p>
        </div>
      </section>
    </main>
  )
}

function Benefit({ text }: { text: string }) {
  return <li className="flex items-center gap-3"><span className="grid size-6 place-items-center rounded-full bg-white/10"><Check className="size-3.5" /></span>{text}</li>
}
