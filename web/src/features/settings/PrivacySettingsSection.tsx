import { Download, FileArchive, Loader2, ShieldAlert, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  cancelAccountDeletion,
  getAccountPrivacyState,
  requestPrivacyExport,
  scheduleAccountDeletion,
} from '../../api/client'
import type { AccountDataExport, AccountDeletionBlocker, AccountPrivacyState, AuthUser } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

export function PrivacySettingsSection({ user }: { user: AuthUser }) {
  const [state, setState] = useState<AccountPrivacyState | null>(null)
  const [exportPassword, setExportPassword] = useState('')
  const [deletionPassword, setDeletionPassword] = useState('')
  const [confirmEmail, setConfirmEmail] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    void getAccountPrivacyState()
      .then((value) => { if (active) setState(value) })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason, '无法加载隐私设置。')) })
    return () => { active = false }
  }, [user.id, user.workspaceId])

  async function exportData(scope: 'account' | 'workspace') {
    if (!exportPassword) return
    setBusy(`export:${scope}`)
    setError('')
    setNotice('')
    try {
      const archive = await requestPrivacyExport({ password: exportPassword, scope })
      downloadArchive(archive)
      setExportPassword('')
      setNotice(scope === 'workspace' ? 'Workspace 数据已导出。' : '账号数据已导出。')
      setState(await getAccountPrivacyState())
    } catch (reason) {
      setError(errorMessage(reason, '数据导出失败。'))
    } finally {
      setBusy('')
    }
  }

  async function scheduleDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!deletionPassword || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) return
    setBusy('delete')
    setError('')
    setNotice('')
    try {
      await scheduleAccountDeletion({ password: deletionPassword, confirmEmail })
      setDeletionPassword('')
      setConfirmEmail('')
      setState(await getAccountPrivacyState())
      setNotice('账号删除已进入宽限期。')
    } catch (reason) {
      setError(errorMessage(reason, '无法安排账号删除。'))
    } finally {
      setBusy('')
    }
  }

  async function cancelDeletion() {
    if (!deletionPassword) return
    setBusy('cancel')
    setError('')
    setNotice('')
    try {
      await cancelAccountDeletion(deletionPassword)
      setDeletionPassword('')
      setState(await getAccountPrivacyState())
      setNotice('账号删除已取消。')
    } catch (reason) {
      setError(errorMessage(reason, '无法取消账号删除。'))
    } finally {
      setBusy('')
    }
  }

  return <section className="min-w-0" aria-labelledby="privacy-data-title">
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-md bg-cyan-50 text-cyan-800"><ShieldAlert className="size-4" /></span>
      <div><h2 className="text-xl font-semibold" id="privacy-data-title">数据与隐私</h2><p className="mt-1 text-sm text-zinc-500">导出数据或管理账号删除。</p></div>
    </div>
    {error ? <div className="mt-4 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</div> : null}
    {notice ? <div className="mt-4 border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status">{notice}</div> : null}
    {!state ? <div className="mt-5 flex h-24 items-center justify-center border text-sm text-zinc-500"><Loader2 className="mr-2 size-4 animate-spin" />正在加载</div> : <div className="mt-5 grid gap-6 xl:grid-cols-2">
      <div className="border bg-white p-5">
        <div className="flex items-start gap-3"><FileArchive className="mt-0.5 size-5 text-blue-700" /><div><h3 className="font-semibold">数据导出</h3><p className="mt-1 text-sm text-zinc-500">JSON 格式，敏感凭据不会包含在归档中。</p></div></div>
        <Label className="mt-5 grid gap-2">当前密码<Input aria-label="导出数据当前密码" autoComplete="current-password" onChange={(event) => setExportPassword(event.target.value)} type="password" value={exportPassword} /></Label>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button disabled={Boolean(busy) || !exportPassword} onClick={() => void exportData('account')} variant="outline">{busy === 'export:account' ? <Loader2 className="animate-spin" /> : <Download />}导出账号</Button>
          {user.role === 'owner' ? <Button disabled={Boolean(busy) || !exportPassword} onClick={() => void exportData('workspace')}>{busy === 'export:workspace' ? <Loader2 className="animate-spin" /> : <Download />}导出 Workspace</Button> : null}
        </div>
      </div>

      <div className="border border-red-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3"><Trash2 className="mt-0.5 size-5 text-red-700" /><div><h3 className="font-semibold">删除账号</h3><p className="mt-1 text-sm text-zinc-500">宽限期为 {state.gracePeriodDays} 天。</p></div></div>{state.deletion ? <Badge variant="secondary">已安排</Badge> : null}</div>
        {state.deletion ? <div className="mt-5">
          <p className="text-sm text-zinc-700">计划执行：{formatDateTime(state.deletion.scheduledFor)}</p>
          <Label className="mt-4 grid gap-2">当前密码<Input aria-label="取消删除当前密码" autoComplete="current-password" onChange={(event) => setDeletionPassword(event.target.value)} type="password" value={deletionPassword} /></Label>
          <div className="mt-4 flex justify-end"><Button disabled={Boolean(busy) || !deletionPassword || state.deletion.status !== 'scheduled'} onClick={() => void cancelDeletion()} variant="outline">{busy === 'cancel' ? <Loader2 className="animate-spin" /> : <Undo2 />}取消删除</Button></div>
        </div> : <form className="mt-5 grid gap-4" onSubmit={scheduleDeletion}>
          {state.blockers.length ? <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{state.blockers.map((blocker) => <p key={`${blocker.code}:${blocker.workspaceId}`}>{blockerMessage(blocker)}</p>)}</div> : null}
          <Label className="grid gap-2">确认邮箱<Input aria-label="确认删除邮箱" autoComplete="off" onChange={(event) => setConfirmEmail(event.target.value)} value={confirmEmail} /></Label>
          <Label className="grid gap-2">当前密码<Input aria-label="删除账号当前密码" autoComplete="current-password" onChange={(event) => setDeletionPassword(event.target.value)} type="password" value={deletionPassword} /></Label>
          <div className="flex justify-end"><Button disabled={Boolean(busy) || Boolean(state.blockers.length) || !deletionPassword || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()} type="submit" variant="destructive">{busy === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />}安排删除</Button></div>
        </form>}
      </div>
    </div>}
  </section>
}

function blockerMessage(blocker: AccountDeletionBlocker): string {
  if (blocker.code === 'OWNERSHIP_TRANSFER_REQUIRED') return `${blocker.workspaceName} 仍有其他成员，请先处理所有权。`
  return `${blocker.workspaceName} 仍有生效中的付费订阅。`
}

function downloadArchive(archive: AccountDataExport) {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `primalthrum-${archive.scope}-data-${archive.generatedAt.slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function formatDateTime(value: string | null): string {
  if (!value) return '待定'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
