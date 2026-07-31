import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { requestPasswordReset } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const response = await requestPasswordReset(email.trim())
      setPreviewUrl(response.emailPreviewUrl ?? '')
      setSent(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法发送重置邮件。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 px-4 py-12">
      <section className="w-full max-w-md border border-zinc-200 bg-white p-7 shadow-lg shadow-zinc-950/5">
        <a className="flex items-center gap-2 text-sm text-zinc-500" href="/login"><ArrowLeft className="size-4" /> 返回登录</a>
        <h1 className="mt-8 text-2xl font-semibold">重置密码</h1>
        {sent ? (
          <div className="mt-6">
            <CheckCircle2 className="size-6 text-emerald-700" />
            <p className="mt-4 text-sm leading-6 text-zinc-600">如果该邮箱存在且已验证，我们已发送一封密码重置邮件。</p>
            {previewUrl ? <Button asChild className="mt-6 w-full"><a href={previewUrl}>开发环境：打开重置链接</a></Button> : null}
          </div>
        ) : (
          <form className="mt-6 grid gap-5" onSubmit={submit}>
            <Label className="grid gap-2">账号邮箱
              <Input autoComplete="email" autoFocus onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
            </Label>
            {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
            <Button disabled={submitting} type="submit">{submitting ? <Loader2 className="animate-spin" /> : null}发送重置邮件</Button>
          </form>
        )}
      </section>
    </main>
  )
}
