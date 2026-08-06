import { Loader2, Scale, ShieldCheck, UnlockKeyhole } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import {
  createOperatorLegalHold,
  releaseOperatorLegalHold,
} from './operatorClient'
import { formatOperatorDate } from './operatorFormatters'
import type {
  LegalHoldBasis,
  OperatorUser,
  OperatorWorkspaceSummary,
  WorkspaceLegalHold,
} from './operatorTypes'

const BASES: Array<{ value: LegalHoldBasis; label: string }> = [
  { value: 'litigation', label: '诉讼' },
  { value: 'regulatory', label: '监管要求' },
  { value: 'investigation', label: '调查' },
  { value: 'tax', label: '税务' },
  { value: 'contractual', label: '合同义务' },
]

export function OperatorLegalHoldsSection({
  holds,
  onReload,
  user,
  workspaces,
}: {
  holds: WorkspaceLegalHold[]
  onReload: () => Promise<void>
  user: OperatorUser
  workspaces: OperatorWorkspaceSummary[]
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <LegalHoldList holds={holds} onReload={onReload} user={user} />
      <LegalHoldCreateForm onReload={onReload} workspaces={workspaces} />
    </div>
  )
}

function LegalHoldList({ holds, onReload, user }: {
  holds: WorkspaceLegalHold[]
  onReload: () => Promise<void>
  user: OperatorUser
}) {
  const [releaseId, setReleaseId] = useState<number | null>(null)
  const [releaseReason, setReleaseReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function release(hold: WorkspaceLegalHold) {
    setBusy(true)
    setError('')
    try {
      await releaseOperatorLegalHold(hold.id, {
        expectedRevision: hold.revision,
        releaseReason,
      })
      setReleaseId(null)
      setReleaseReason('')
      await onReload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '法务保全释放失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="overflow-hidden rounded-md border bg-white">
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div><h2 className="text-sm font-semibold">保全案件</h2><p className="mt-1 text-xs text-zinc-500">有效保全会暂停 Workspace 数据清理和相关成员账号删除</p></div>
        <Badge variant="outline">{holds.filter((hold) => hold.status === 'active').length} 个有效</Badge>
      </div>
      {error ? <p className="border-b bg-red-50 px-5 py-3 text-sm text-red-700" role="alert">{error}</p> : null}
      <div className="divide-y">
        {holds.map((hold) => {
          const selfPlaced = hold.createdByOperatorId === user.id
          const releasing = releaseId === hold.id
          return <article className="px-5 py-5" key={hold.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><strong className="break-all font-mono text-sm">{hold.externalCaseRef}</strong><Badge variant={hold.status === 'active' ? 'destructive' : 'secondary'}>{hold.status === 'active' ? '保全中' : '已释放'}</Badge><Badge variant="outline">rev {hold.revision}</Badge></div>
                <p className="mt-2 text-sm font-medium">{hold.workspaceName} <span className="text-zinc-400">#{hold.workspaceId}</span></p>
                <p className="mt-1 text-sm leading-6 text-zinc-600">{basisLabel(hold.basis)} · {hold.reason}</p>
                <p className="mt-2 text-xs text-zinc-500">{hold.holdRef} · Operator #{hold.createdByOperatorId} · {formatOperatorDate(hold.createdAt)}</p>
              </div>
              {hold.status === 'active' ? <Button disabled={selfPlaced} onClick={() => { setReleaseReason(''); setReleaseId(releasing ? null : hold.id) }} size="sm" title={selfPlaced ? '需要另一名授权 Operator 复核释放' : '释放保全'} variant="outline"><UnlockKeyhole />释放</Button> : <ShieldCheck className="size-5 text-emerald-600" />}
            </div>
            {selfPlaced && hold.status === 'active' ? <p className="mt-3 text-xs text-amber-700">创建者不能自行释放，请由另一名授权 Operator 复核。</p> : null}
            {releasing ? <div className="mt-4 border-t pt-4"><Label className="grid gap-2">释放依据<Textarea minLength={10} onChange={(event) => setReleaseReason(event.target.value)} placeholder="记录复核结论和释放依据" value={releaseReason} /></Label><div className="mt-3 flex justify-end gap-2"><Button disabled={busy} onClick={() => setReleaseId(null)} size="sm" variant="ghost">取消</Button><Button disabled={busy || releaseReason.trim().length < 10} onClick={() => void release(hold)} size="sm">{busy ? <Loader2 className="animate-spin" /> : <UnlockKeyhole />}确认释放</Button></div></div> : null}
          </article>
        })}
        {!holds.length ? <div className="px-5 py-14 text-center text-sm text-zinc-500">暂无法务保全案件</div> : null}
      </div>
    </section>
  )
}

function LegalHoldCreateForm({ onReload, workspaces }: {
  onReload: () => Promise<void>
  workspaces: OperatorWorkspaceSummary[]
}) {
  const [workspaceId, setWorkspaceId] = useState('')
  const [externalCaseRef, setExternalCaseRef] = useState('')
  const [basis, setBasis] = useState<LegalHoldBasis>('litigation')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await createOperatorLegalHold({
        workspaceId: Number(workspaceId),
        externalCaseRef,
        basis,
        reason,
      })
      setWorkspaceId('')
      setExternalCaseRef('')
      setReason('')
      await onReload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '法务保全创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="h-fit rounded-md border bg-white p-5">
      <div className="flex items-center gap-2"><Scale className="size-4 text-red-700" /><h2 className="text-sm font-semibold">放置法务保全</h2></div>
      <p className="mt-2 text-xs leading-5 text-zinc-500">提交后立即暂停该 Workspace 的留存清理，释放需要第二名授权 Operator。</p>
      <form className="mt-5 grid gap-4" onSubmit={create}>
        <Label className="grid gap-2">Workspace<select aria-label="保全 Workspace" className="h-9 rounded-md border bg-white px-3 text-sm" onChange={(event) => setWorkspaceId(event.target.value)} required value={workspaceId}><option value="">请选择</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} (#{workspace.id})</option>)}</select></Label>
        <Label className="grid gap-2">外部案件编号<Input minLength={3} onChange={(event) => setExternalCaseRef(event.target.value)} placeholder="例如 LEGAL-2026-001" required value={externalCaseRef} /></Label>
        <Label className="grid gap-2">保全依据<select aria-label="保全依据" className="h-9 rounded-md border bg-white px-3 text-sm" onChange={(event) => setBasis(event.target.value as LegalHoldBasis)} value={basis}>{BASES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Label>
        <Label className="grid gap-2">操作原因<Textarea minLength={10} onChange={(event) => setReason(event.target.value)} placeholder="记录授权来源、范围和操作理由" required value={reason} /></Label>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        <Button disabled={busy} type="submit">{busy ? <Loader2 className="animate-spin" /> : <Scale />}放置保全</Button>
      </form>
    </section>
  )
}

function basisLabel(basis: LegalHoldBasis): string {
  return BASES.find((item) => item.value === basis)?.label ?? basis
}
