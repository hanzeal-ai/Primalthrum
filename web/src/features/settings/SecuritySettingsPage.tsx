import {
  Check,
  Clipboard,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  createWorkspaceApiKey,
  listSecuritySessions,
  listWorkspaceApiKeys,
  revokeOtherSecuritySessions,
  revokeSecuritySession,
  revokeWorkspaceApiKey,
} from '../../api/client'
import type {
  ApiKeyScope,
  AuthUser,
  CreatedWorkspaceApiKey,
  SessionSecurityRecord,
  WorkspaceApiKeyRecord,
} from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { canManageApiKeys } from '../../lib/workspacePermissions'
import { WorkspaceAppShell } from '../app-shell/WorkspaceAppShell'

const API_KEY_SCOPE_OPTIONS: Array<{ scope: ApiKeyScope; label: string; description: string }> = [
  { scope: 'agents:read', label: '读取', description: '读取 Agent、版本、对话和运行记录' },
  { scope: 'agents:write', label: '编辑', description: '创建 Agent、上传知识和修改草稿' },
  { scope: 'agents:run', label: '运行', description: '调用流式运行与创建对话' },
  { scope: 'agents:publish', label: '发布', description: '发布版本、回滚和修改公开范围' },
]

interface SecuritySettingsPageProps {
  onLogout: () => Promise<void>
  user: AuthUser
}

export function SecuritySettingsPage({ onLogout, user }: SecuritySettingsPageProps) {
  const canManageKeys = canManageApiKeys(user.role)
  const [apiKeys, setApiKeys] = useState<WorkspaceApiKeyRecord[]>([])
  const [sessions, setSessions] = useState<SessionSecurityRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(90)
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['agents:read', 'agents:run'])
  const [createdKey, setCreatedKey] = useState<CreatedWorkspaceApiKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmKey, setConfirmKey] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      listSecuritySessions(),
      canManageKeys ? listWorkspaceApiKeys() : Promise.resolve([]),
    ]).then(([sessionRecords, keyRecords]) => {
      if (!active) return
      setSessions(sessionRecords)
      setApiKeys(keyRecords)
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason, '无法加载安全设置。'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [canManageKeys, user.workspaceId])

  async function submitApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || !password || !scopes.length) return
    setBusy('create-key')
    setError('')
    setNotice('')
    setCopied(false)
    try {
      const created = await createWorkspaceApiKey({
        name: name.trim(), scopes, expiresInDays, password,
      })
      setCreatedKey(created)
      setApiKeys((current) => [created, ...current])
      setName('')
      setPassword('')
    } catch (reason) {
      setError(errorMessage(reason, '无法创建 API Key。'))
    } finally {
      setBusy('')
    }
  }

  function toggleScope(scope: ApiKeyScope) {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope])
  }

  async function copyCreatedKey() {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey.token)
      setCopied(true)
    } catch {
      setError('浏览器无法写入剪贴板，请手动复制 API Key。')
    }
  }

  async function revokeKey(apiKey: WorkspaceApiKeyRecord) {
    setBusy(`key:${apiKey.id}`)
    setError('')
    try {
      await revokeWorkspaceApiKey(apiKey.id)
      setApiKeys((current) => current.map((item) => item.id === apiKey.id
        ? { ...item, revokedAt: new Date().toISOString() }
        : item))
      if (createdKey?.id === apiKey.id) setCreatedKey(null)
      setConfirmKey(null)
    } catch (reason) {
      setError(errorMessage(reason, '无法撤销 API Key。'))
    } finally {
      setBusy('')
    }
  }

  async function revokeSession(sessionId: number) {
    setBusy(`session:${sessionId}`)
    setError('')
    try {
      await revokeSecuritySession(sessionId)
      setSessions((current) => current.filter((session) => session.id !== sessionId))
    } catch (reason) {
      setError(errorMessage(reason, '无法撤销会话。'))
    } finally {
      setBusy('')
    }
  }

  async function revokeOtherSessions() {
    setBusy('sessions')
    setError('')
    setNotice('')
    try {
      const result = await revokeOtherSecuritySessions()
      setSessions((current) => current.filter((session) => session.current))
      setNotice(result.revoked ? `已退出 ${result.revoked} 个其他会话。` : '没有需要退出的其他会话。')
    } catch (reason) {
      setError(errorMessage(reason, '无法退出其他会话。'))
    } finally {
      setBusy('')
    }
  }

  return (
    <WorkspaceAppShell active="settings" description="API Key、访问作用域与登录会话" onLogout={onLogout} title="设置与安全" user={user}>
      {error ? <div className="mb-5 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</div> : null}
      {notice ? <div className="mb-5 border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status">{notice}</div> : null}
      {loading ? <LoadingState /> : <div className="grid min-w-0 gap-10">
        {canManageKeys ? <section className="min-w-0" aria-labelledby="api-keys-title">
          <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-md bg-blue-50 text-blue-700"><KeyRound className="size-4" /></span><div><h2 className="text-xl font-semibold" id="api-keys-title">API Keys</h2><p className="mt-1 text-sm text-zinc-500">用于服务端集成，只授予必要作用域。</p></div></div>
          <div className="mt-5 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="min-w-0">
              <form className="grid gap-5 rounded-lg border bg-white p-5" onSubmit={submitApiKey}>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                  <Label className="grid gap-2">密钥名称<Input aria-label="密钥名称" maxLength={64} onChange={(event) => setName(event.target.value)} placeholder="Production integration" value={name} /></Label>
                  <Label className="grid gap-2">有效期<select aria-label="有效期" className="h-9 rounded-md border bg-white px-3 text-sm" onChange={(event) => setExpiresInDays(Number(event.target.value))} value={expiresInDays}><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option></select></Label>
                </div>
                <fieldset><legend className="text-sm font-medium">访问作用域</legend><div className="mt-3 grid gap-2 sm:grid-cols-2">{API_KEY_SCOPE_OPTIONS.map((option) => <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3" key={option.scope}><input checked={scopes.includes(option.scope)} className="mt-1 size-4" onChange={() => toggleScope(option.scope)} type="checkbox" /><span><span className="block text-sm font-medium">{option.label}</span><span className="mt-1 block text-xs leading-5 text-zinc-500">{option.description}</span></span></label>)}</div></fieldset>
                <Label className="grid gap-2">当前密码<Input aria-label="当前密码" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Label>
                <div className="flex justify-end"><Button disabled={Boolean(busy) || !name.trim() || !password || !scopes.length} type="submit">{busy === 'create-key' ? <Loader2 className="animate-spin" /> : <KeyRound />}创建 API Key</Button></div>
              </form>
              {createdKey ? <div className="mt-4 border border-amber-300 bg-amber-50 p-4"><p className="text-sm font-semibold text-amber-950">立即保存，此 Key 只显示一次</p><div className="mt-3 flex min-w-0 gap-2"><Input aria-label="新 API Key" className="min-w-0 font-mono" readOnly value={createdKey.token} /><Button aria-label="复制 API Key" onClick={() => void copyCreatedKey()} size="icon" variant="outline">{copied ? <Check /> : <Clipboard />}</Button></div></div> : null}
            </div>
            <div className="min-w-0"><h3 className="text-base font-semibold">现有 Keys</h3><div className="mt-3 overflow-hidden rounded-lg border bg-white">{apiKeys.length ? apiKeys.slice(0, 20).map((apiKey) => <ApiKeyRow apiKey={apiKey} busy={busy} confirmKey={confirmKey} key={apiKey.id} onCancel={() => setConfirmKey(null)} onConfirm={() => void revokeKey(apiKey)} onRequestRevoke={() => setConfirmKey(apiKey.id)} />) : <p className="p-5 text-sm text-zinc-500">尚未创建 API Key。</p>}</div></div>
          </div>
        </section> : null}

        <section className="min-w-0" aria-labelledby="sessions-title">
          <div className="flex flex-wrap items-end justify-between gap-4"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-md bg-emerald-50 text-emerald-700"><ShieldCheck className="size-4" /></span><div><h2 className="text-xl font-semibold" id="sessions-title">登录会话</h2><p className="mt-1 text-sm text-zinc-500">检查当前账号仍处于登录状态的会话。</p></div></div><Button disabled={Boolean(busy) || sessions.every((session) => session.current)} onClick={() => void revokeOtherSessions()} variant="outline">{busy === 'sessions' ? <Loader2 className="animate-spin" /> : <LogOut />}退出其他会话</Button></div>
          <div className="mt-5 overflow-hidden rounded-lg border bg-white">{sessions.map((session) => <div className="grid min-w-0 gap-3 border-b p-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={session.id}><div className="flex min-w-0 items-start gap-3"><Monitor className="mt-1 size-4 shrink-0 text-zinc-500" /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{session.current ? '当前会话' : '其他会话'}</p>{session.current ? <Badge variant="success">正在使用</Badge> : null}</div><p className="mt-1 text-xs text-zinc-500">最近活动 {formatDateTime(session.lastSeenAt)} · 到期 {formatDateTime(session.expiresAt)}</p></div></div>{session.current ? <span /> : <Button aria-label={`退出会话 ${session.id}`} disabled={Boolean(busy)} onClick={() => void revokeSession(session.id)} size="sm" variant="ghost"><LogOut />退出</Button>}</div>)}</div>
        </section>
      </div>}
    </WorkspaceAppShell>
  )
}

function ApiKeyRow({ apiKey, busy, confirmKey, onCancel, onConfirm, onRequestRevoke }: {
  apiKey: WorkspaceApiKeyRecord
  busy: string
  confirmKey: number | null
  onCancel: () => void
  onConfirm: () => void
  onRequestRevoke: () => void
}) {
  const status = keyStatus(apiKey)
  return <div className="min-w-0 border-b p-4 last:border-b-0"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{apiKey.name}</p><p className="mt-1 truncate font-mono text-xs text-zinc-500">{apiKey.keyPrefix}...</p></div><Badge variant={status === '有效' ? 'success' : 'secondary'}>{status}</Badge></div><p className="mt-3 text-xs leading-5 text-zinc-500">{apiKey.scopes.map(scopeLabel).join(' · ')}</p><p className="mt-1 text-xs text-zinc-500">{apiKey.lastUsedAt ? `最近使用 ${formatDateTime(apiKey.lastUsedAt)}` : '尚未使用'} · 到期 {formatDateTime(apiKey.expiresAt)}</p>{status === '有效' ? <div className="mt-3 flex justify-end">{confirmKey === apiKey.id ? <div className="flex gap-1"><Button aria-label={`确认撤销 ${apiKey.name}`} disabled={Boolean(busy)} onClick={onConfirm} size="icon" variant="destructive"><Check /></Button><Button aria-label="取消撤销" onClick={onCancel} size="icon" variant="ghost"><X /></Button></div> : <Button aria-label={`撤销 ${apiKey.name}`} onClick={onRequestRevoke} size="sm" variant="ghost"><Trash2 />撤销</Button>}</div> : null}</div>
}

function LoadingState() {
  return <div className="grid min-h-72 place-items-center text-sm text-zinc-500"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在加载安全设置</span></div>
}

function keyStatus(apiKey: WorkspaceApiKeyRecord): string {
  if (apiKey.revokedAt) return '已撤销'
  return apiKey.expiresAt <= new Date().toISOString() ? '已过期' : '有效'
}

function scopeLabel(scope: ApiKeyScope): string {
  return ({ 'agents:read': '读取', 'agents:write': '编辑', 'agents:run': '运行', 'agents:publish': '发布' })[scope]
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
