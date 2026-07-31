import {
  ArchiveRestore,
  Clock3,
  Database,
  Eraser,
  Loader2,
  LockKeyhole,
  Save,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  enforceRetentionSettings,
  getRetentionSettings,
  updateRetentionSettings,
} from '../../api/client'
import type { RetentionSettingsState } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

const CONVERSATION_OPTIONS = [null, 30, 90, 180, 365, 730]
const RUN_OPTIONS = [null, 7, 30, 90, 180, 365]
const DOCUMENT_OPTIONS = [null, 30, 90, 180, 365, 730]

interface RetentionSettingsSectionProps {
  workspaceId: number
}

export function RetentionSettingsSection({ workspaceId }: RetentionSettingsSectionProps) {
  const [state, setState] = useState<RetentionSettingsState | null>(null)
  const [conversationDays, setConversationDays] = useState<number | null>(null)
  const [runDays, setRunDays] = useState<number | null>(null)
  const [documentDays, setDocumentDays] = useState<number | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState('')
  const [confirmEnforce, setConfirmEnforce] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    void getRetentionSettings().then((next) => {
      if (active) applyState(next)
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason, '无法加载数据留存设置。'))
    })
    return () => { active = false }
  }, [workspaceId])

  function applyState(next: RetentionSettingsState) {
    setState(next)
    setConversationDays(next.policy.conversationDays)
    setRunDays(next.policy.runDays)
    setDocumentDays(next.policy.documentDays)
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password) return
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const next = await updateRetentionSettings({
        conversationDays,
        runDays,
        documentDays,
        password,
      })
      applyState(next)
      setPassword('')
      setConfirmEnforce(false)
      setNotice('留存策略已保存，后台清理已排队。')
    } catch (reason) {
      setError(errorMessage(reason, '无法保存留存策略。'))
    } finally {
      setBusy('')
    }
  }

  async function enforceNow() {
    if (!password) return
    setBusy('enforce')
    setError('')
    setNotice('')
    try {
      const outcome = await enforceRetentionSettings(password)
      const next = await getRetentionSettings()
      applyState(next)
      setPassword('')
      setConfirmEnforce(false)
      setNotice(`清理完成：${numberResult(outcome.event.result, 'conversations')} 个对话、${numberResult(outcome.event.result, 'runs')} 个运行、${numberResult(outcome.event.result, 'documents')} 个文件。`)
    } catch (reason) {
      setError(errorMessage(reason, '无法执行数据清理。'))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="min-w-0" aria-labelledby="retention-title">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-md bg-violet-50 text-violet-700"><ArchiveRestore className="size-4" /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold" id="retention-title">数据留存</h2>
            {state ? <Badge variant={state.customRetentionEnabled ? 'success' : 'secondary'}>{state.customRetentionEnabled ? '已启用' : '套餐未包含'}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-zinc-500">对话、运行记录与知识文件的自动清理周期。</p>
        </div>
      </div>

      {error ? <div className="mt-4 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</div> : null}
      {notice ? <div className="mt-4 border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status">{notice}</div> : null}

      {!state && !error ? <div className="mt-5 flex min-h-32 items-center justify-center border bg-white text-sm text-zinc-500"><Loader2 className="mr-2 size-4 animate-spin" />正在加载留存策略</div> : null}
      {state ? <div className="mt-5 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <form className="min-w-0 rounded-lg border bg-white p-5" onSubmit={savePolicy}>
          <div className="grid gap-4 md:grid-cols-3">
            <RetentionSelect disabled={!state.canManage || !state.customRetentionEnabled || Boolean(busy)} label="对话记录" onChange={setConversationDays} options={CONVERSATION_OPTIONS} value={conversationDays} />
            <RetentionSelect disabled={!state.canManage || !state.customRetentionEnabled || Boolean(busy)} label="运行与事件" onChange={setRunDays} options={RUN_OPTIONS} value={runDays} />
            <RetentionSelect disabled={!state.canManage || !state.customRetentionEnabled || Boolean(busy)} label="知识文件" onChange={setDocumentDays} options={DOCUMENT_OPTIONS} value={documentDays} />
          </div>

          <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-md border sm:grid-cols-4">
            <PreviewValue label="待清理对话" value={state.preview.conversations.toLocaleString('zh-CN')} />
            <PreviewValue label="待清理运行" value={state.preview.runs.toLocaleString('zh-CN')} />
            <PreviewValue label="待清理文件" value={state.preview.documents.toLocaleString('zh-CN')} />
            <PreviewValue label="文件容量" value={formatBytes(state.preview.documentBytes)} />
          </div>

          {!state.customRetentionEnabled ? <div className="mt-5 flex min-w-0 items-start gap-3 border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><div><p className="font-medium">Business 或 Enterprise 套餐可自定义留存周期</p><a className="mt-2 inline-block font-medium underline underline-offset-4" href="/app/billing">查看套餐</a></div></div> : null}
          {state.customRetentionEnabled && !state.canManage ? <p className="mt-5 border bg-zinc-50 p-4 text-sm text-zinc-600">当前角色只能查看留存策略。</p> : null}

          {state.canManage && state.customRetentionEnabled ? <>
            <Label className="mt-5 grid gap-2">当前密码<Input aria-label="留存设置当前密码" autoComplete="current-password" disabled={Boolean(busy)} onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Label>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {confirmEnforce ? <Button disabled={Boolean(busy) || !password} onClick={() => void enforceNow()} type="button" variant="destructive">{busy === 'enforce' ? <Loader2 className="animate-spin" /> : <Eraser />}确认立即清理</Button> : <Button disabled={Boolean(busy) || !password} onClick={() => setConfirmEnforce(true)} type="button" variant="outline"><Eraser />立即执行</Button>}
              {confirmEnforce ? <Button disabled={Boolean(busy)} onClick={() => setConfirmEnforce(false)} type="button" variant="ghost">取消</Button> : null}
              <Button disabled={Boolean(busy) || !password} type="submit">{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}保存策略</Button>
            </div>
          </> : null}
        </form>

        <div className="min-w-0">
          <div className="flex items-center gap-2"><Clock3 className="size-4 text-zinc-500" /><h3 className="text-base font-semibold">执行记录</h3></div>
          <div className="mt-3 overflow-hidden rounded-lg border bg-white">
            {state.events.length ? state.events.slice(0, 5).map((event) => <div className="border-b p-4 last:border-b-0" key={event.id}><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{event.eventType === 'policy_updated' ? '策略已更新' : '自动清理完成'}</p><Database className="size-4 shrink-0 text-zinc-400" /></div><p className="mt-1 text-xs text-zinc-500">{formatDateTime(event.createdAt)}</p>{event.eventType === 'enforcement_completed' ? <p className="mt-2 text-xs leading-5 text-zinc-500">清理 {numberResult(event.result, 'conversations')} 个对话、{numberResult(event.result, 'runs')} 个运行、{numberResult(event.result, 'documents')} 个文件</p> : null}</div>) : <p className="p-5 text-sm text-zinc-500">尚无策略变更或清理记录。</p>}
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">账单、用量、安全和留存审计不受此策略影响。</p>
        </div>
      </div> : null}
    </section>
  )
}

function RetentionSelect({ disabled, label, onChange, options, value }: {
  disabled: boolean
  label: string
  onChange: (value: number | null) => void
  options: Array<number | null>
  value: number | null
}) {
  return <Label className="grid gap-2">{label}<select aria-label={`${label}留存周期`} className="h-9 min-w-0 rounded-md border bg-white px-3 text-sm disabled:bg-zinc-100" disabled={disabled} onChange={(event) => onChange(event.target.value === 'forever' ? null : Number(event.target.value))} value={value ?? 'forever'}>{options.map((days) => <option key={days ?? 'forever'} value={days ?? 'forever'}>{days === null ? '永久保留' : `${days} 天`}</option>)}</select></Label>
}

function PreviewValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-r p-3 even:border-r-0 sm:border-b-0 sm:even:border-r sm:last:border-r-0"><p className="truncate text-xs text-zinc-500">{label}</p><p className="mt-1 truncate text-lg font-semibold">{value}</p></div>
}

function numberResult(result: Record<string, unknown>, key: string): number {
  const value = Number(result[key] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
