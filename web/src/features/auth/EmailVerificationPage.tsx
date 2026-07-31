import { CheckCircle2, Loader2, Mail, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { resendVerification, verifyEmail } from '../../api/client'
import { Button } from '../../components/ui/button'

interface EmailVerificationPageProps {
  authenticated: boolean
  email?: string
  previewUrl: string
  onLogout: () => Promise<void>
  onPreviewUrl: (url: string) => void
  onVerified: () => Promise<void>
}

export function EmailVerificationPage(props: EmailVerificationPageProps) {
  const { authenticated, email, onLogout, onPreviewUrl, onVerified, previewUrl } = props
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [status, setStatus] = useState<'pending' | 'verifying' | 'verified' | 'error'>(token ? 'verifying' : 'pending')
  const [message, setMessage] = useState(token ? '正在验证邮箱...' : '验证邮件已发送。')
  const [resending, setResending] = useState(false)
  const verificationStarted = useRef(false)

  useEffect(() => {
    if (!token || verificationStarted.current) return
    verificationStarted.current = true
    void verifyEmail(token)
      .then(async () => {
        if (authenticated) await onVerified()
        setStatus('verified')
        setMessage('邮箱验证完成。')
      })
      .catch((error) => {
        setStatus('error')
        setMessage(error instanceof Error ? error.message : '验证链接无效或已过期。')
      })
  }, [token, authenticated, onVerified])

  async function resend() {
    setResending(true)
    try {
      const response = await resendVerification()
      if (response.emailPreviewUrl) onPreviewUrl(response.emailPreviewUrl)
      setMessage('新的验证邮件已发送，旧链接已失效。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '验证邮件发送失败。')
    } finally {
      setResending(false)
    }
  }

  const complete = status === 'verified'
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50 px-4 py-12 text-zinc-950">
      <section className="w-full max-w-md border border-zinc-200 bg-white p-7 shadow-lg shadow-zinc-950/5">
        <div className={`grid size-11 place-items-center rounded-md ${complete ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>
          {status === 'verifying' ? <Loader2 className="size-5 animate-spin" /> : complete ? <CheckCircle2 className="size-5" /> : <Mail className="size-5" />}
        </div>
        <h1 className="mt-6 text-2xl font-semibold">{complete ? '邮箱已验证' : token ? '验证你的邮箱' : '检查你的邮箱'}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">{message}</p>
        {!token && email ? <p className="mt-2 font-medium">{email}</p> : null}
        {previewUrl && !complete ? (
          <Button asChild className="mt-6 w-full">
            <a href={previewUrl}>开发环境：打开验证链接</a>
          </Button>
        ) : null}
        {complete ? (
          <Button asChild className="mt-6 w-full"><a href={authenticated ? '/app' : '/login'}>{authenticated ? '进入工作台' : '返回登录'}</a></Button>
        ) : !token && authenticated ? (
          <Button className="mt-6 w-full" disabled={resending} onClick={() => void resend()} variant={previewUrl ? 'outline' : 'default'}>
            {resending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            重新发送
          </Button>
        ) : null}
        {status === 'error' ? <Button asChild className="mt-3 w-full" variant="outline"><a href={authenticated ? '/app' : '/login'}>返回</a></Button> : null}
        {authenticated && !complete ? <button className="mt-6 w-full text-sm text-zinc-500 hover:text-zinc-950" onClick={() => void onLogout()} type="button">退出当前账号</button> : null}
      </section>
    </main>
  )
}
