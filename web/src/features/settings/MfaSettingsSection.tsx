import {
  Check,
  Clipboard,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  beginMfaSetup,
  confirmMfaSetup,
  disableMfa,
  getMfaStatus,
  regenerateMfaRecoveryCodes,
} from '../../api/client'
import type { MfaSetupResponse, MfaStatus } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

type ManageMode = 'idle' | 'regenerate' | 'disable'

export function MfaSettingsSection({
  onSessionAssuranceChange = () => undefined,
}: {
  onSessionAssuranceChange?: () => void
}) {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [manageMode, setManageMode] = useState<ManageMode>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void getMfaStatus().then((result) => {
      if (active) setStatus(result)
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason, '无法加载多因素认证状态。'))
    })
    return () => { active = false }
  }, [])

  async function startSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      setSetup(await beginMfaSetup(password))
      setPassword('')
    } catch (reason) {
      setError(errorMessage(reason, '无法开始设置多因素认证。'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await confirmMfaSetup(code)
      setStatus(result)
      setRecoveryCodes(result.recoveryCodes)
      setSetup(null)
      setCode('')
      onSessionAssuranceChange()
    } catch (reason) {
      setError(errorMessage(reason, '验证码无效。'))
    } finally {
      setBusy(false)
    }
  }

  async function manage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (manageMode === 'idle') return
    setBusy(true)
    setError('')
    try {
      if (manageMode === 'regenerate') {
        const result = await regenerateMfaRecoveryCodes({ password, code })
        setRecoveryCodes(result.recoveryCodes)
        setStatus((current) => current ? { ...current, recoveryCodesRemaining: result.recoveryCodes.length } : current)
      } else {
        await disableMfa({ password, code })
        setStatus({ enabled: false, recoveryCodesRemaining: 0, enabledAt: null })
        setRecoveryCodes([])
        onSessionAssuranceChange()
      }
      setPassword('')
      setCode('')
      setManageMode('idle')
    } catch (reason) {
      setError(errorMessage(reason, manageMode === 'disable' ? '无法关闭多因素认证。' : '无法生成恢复码。'))
    } finally {
      setBusy(false)
    }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setCopied(true)
    } catch {
      setError('浏览器无法写入剪贴板，请手动保存恢复码。')
    }
  }

  return (
    <section className="min-w-0" aria-labelledby="mfa-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md bg-emerald-50 text-emerald-700"><ShieldCheck className="size-4" /></span>
          <div><h2 className="text-xl font-semibold" id="mfa-title">多因素认证</h2><p className="mt-1 text-sm text-zinc-500">使用身份验证器保护账号登录与团队邀请。</p></div>
        </div>
        {status ? <Badge variant={status.enabled ? 'success' : 'secondary'}>{status.enabled ? '已启用' : '未启用'}</Badge> : null}
      </div>

      {error ? <p className="mt-4 border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p> : null}
      {!status ? <p className="mt-5 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" />正在加载认证状态</p> : null}

      {status && !status.enabled && !setup ? (
        <form className="mt-5 grid max-w-xl gap-4 rounded-lg border bg-white p-5" onSubmit={startSetup}>
          <div><h3 className="text-sm font-semibold">连接身份验证器</h3><p className="mt-1 text-xs leading-5 text-zinc-500">启用后，每次密码登录都需要额外验证码。</p></div>
          <Label className="grid gap-2">当前密码<Input aria-label="MFA 当前密码" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Label>
          <div className="flex justify-end"><Button disabled={busy || !password} type="submit">{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}开始设置</Button></div>
        </form>
      ) : null}

      {setup ? (
        <form className="mt-5 grid max-w-2xl gap-5 rounded-lg border bg-white p-5" onSubmit={confirmSetup}>
          <div><h3 className="text-sm font-semibold">在身份验证器中添加 Primalthrum</h3><p className="mt-1 text-xs leading-5 text-zinc-500">使用下方链接打开支持的应用，或手动输入密钥。</p></div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input aria-label="MFA 手动密钥" className="font-mono" readOnly value={setup.secret} />
            <Button asChild variant="outline"><a href={setup.otpauthUri}><ExternalLink />打开身份验证器</a></Button>
          </div>
          <Label className="grid gap-2">6 位验证码<Input aria-label="MFA 验证码" autoComplete="one-time-code" inputMode="numeric" onChange={(event) => setCode(event.target.value)} value={code} /></Label>
          <div className="flex justify-end gap-2"><Button onClick={() => { setSetup(null); setCode('') }} type="button" variant="ghost">取消</Button><Button disabled={busy || !/^\d{6}$/.test(code.replace(/\s/g, ''))} type="submit">{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}确认启用</Button></div>
        </form>
      ) : null}

      {recoveryCodes.length ? (
        <div className="mt-5 max-w-2xl border border-amber-300 bg-amber-50 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-amber-950">立即保存恢复码</h3><p className="mt-1 text-xs leading-5 text-amber-800">每个恢复码只能使用一次，关闭后不会再次显示。</p></div><Button onClick={() => void copyRecoveryCodes()} size="sm" variant="outline">{copied ? <Check /> : <Clipboard />}{copied ? '已复制' : '复制全部'}</Button></div>
          <div className="mt-4 grid gap-2 font-mono text-sm sm:grid-cols-2">{recoveryCodes.map((recoveryCode) => <code key={recoveryCode}>{recoveryCode}</code>)}</div>
          <div className="mt-4 flex justify-end"><Button onClick={() => setRecoveryCodes([])} size="sm">我已安全保存</Button></div>
        </div>
      ) : null}

      {status?.enabled ? (
        <div className="mt-5 max-w-2xl rounded-lg border bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-4"><div><h3 className="text-sm font-semibold">账号已受保护</h3><p className="mt-1 text-xs text-zinc-500">剩余 {status.recoveryCodesRemaining} 个恢复码{status.enabledAt ? ` · 启用于 ${formatDate(status.enabledAt)}` : ''}</p></div><div className="flex gap-2"><Button disabled={busy} onClick={() => setManageMode('regenerate')} size="sm" variant="outline"><RefreshCw />重置恢复码</Button><Button disabled={busy} onClick={() => setManageMode('disable')} size="sm" variant="destructive"><ShieldOff />关闭</Button></div></div>
          {manageMode !== 'idle' ? <form className="mt-5 grid gap-4 border-t pt-5" onSubmit={manage}><p className="text-sm font-medium">{manageMode === 'disable' ? '关闭多因素认证' : '生成新的恢复码'}</p><div className="grid gap-4 sm:grid-cols-2"><Label className="grid gap-2">当前密码<Input aria-label="MFA 管理密码" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Label><Label className="grid gap-2">验证码或恢复码<Input aria-label="MFA 管理验证码" autoComplete="one-time-code" onChange={(event) => setCode(event.target.value)} value={code} /></Label></div><div className="flex justify-end gap-2"><Button onClick={() => setManageMode('idle')} type="button" variant="ghost">取消</Button><Button disabled={busy || !password || !code} type="submit" variant={manageMode === 'disable' ? 'destructive' : 'default'}>{busy ? <Loader2 className="animate-spin" /> : manageMode === 'disable' ? <ShieldOff /> : <RefreshCw />}{manageMode === 'disable' ? '确认关闭' : '生成新恢复码'}</Button></div></form> : null}
        </div>
      ) : null}
    </section>
  )
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
