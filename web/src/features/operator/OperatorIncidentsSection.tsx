import { MessageSquarePlus, RefreshCw, Save } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { OperatorIncidentCreateForm } from './OperatorIncidentCreateForm'
import {
  createOperatorIncidentEvent,
  getOperatorIncident,
  updateOperatorIncident,
} from './operatorClient'
import { formatOperatorDate, operatorSelectClassName } from './operatorFormatters'
import { canManageChangeControl } from './operatorPermissions'
import { OperatorStatusBadge } from './OperatorStatusBadge'
import type {
  OperatorIncidentDetail,
  OperatorIncidentEventType,
  OperatorIncidentSeverity,
  OperatorIncidentStatus,
  OperatorIncidentSummary,
  OperatorRole,
  OperatorUser,
  OperatorWorkspaceSummary,
} from './operatorTypes'

export function OperatorIncidentsSection({ incidents, onReload, operators, role, workspaces }: {
  incidents: OperatorIncidentSummary[]
  onReload: () => Promise<void>
  operators: OperatorUser[]
  role: OperatorRole
  workspaces: OperatorWorkspaceSummary[]
}) {
  const canManage = canManageChangeControl(role)
  const [detail, setDetail] = useState<OperatorIncidentDetail | null>(null)
  const [error, setError] = useState('')

  async function open(id: number) {
    setError('')
    try {
      setDetail(await getOperatorIncident(id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '事故详情加载失败')
    }
  }

  async function changed(next: OperatorIncidentDetail) {
    setDetail(next)
    await onReload()
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="grid content-start gap-5">
        {error && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
        <section className="overflow-hidden rounded-md border bg-white">
          <div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="text-sm font-semibold">事故列表</h2><p className="mt-1 text-xs text-zinc-500">未解决事故按等级与开始时间优先排列</p></div><span className="text-xs text-zinc-500">{incidents.length} 条</span></div>
          <div className="divide-y">{incidents.map((incident) => <button className="grid w-full gap-3 px-5 py-4 text-left hover:bg-zinc-50 sm:grid-cols-[1fr_auto]" key={incident.id} onClick={() => void open(incident.id)} type="button"><div><div className="flex flex-wrap items-center gap-2"><strong>{incident.incidentRef}</strong><Badge variant={incident.severity === 'sev1' || incident.severity === 'sev2' ? 'destructive' : 'secondary'}>{incident.severity.toUpperCase()}</Badge><OperatorStatusBadge status={incident.status} /></div><p className="mt-2 font-medium">{incident.title}</p><p className="mt-1 line-clamp-2 text-sm text-zinc-600">{incident.summary}</p></div><div className="text-xs text-zinc-500 sm:text-right"><p>{formatOperatorDate(incident.startedAt)}</p><p className="mt-1">{incident.eventCount} 条事件 · rev {incident.revision}</p></div></button>)}</div>
          {!incidents.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无事故</div>}
        </section>
        {detail && <IncidentDetail canManage={canManage} detail={detail} key={`${detail.id}:${detail.revision}:${detail.events.length}`} onChanged={changed} operators={operators} />}
      </div>
      {canManage && <OperatorIncidentCreateForm onCreated={changed} operators={operators} workspaces={workspaces} />}
    </div>
  )
}

function IncidentDetail({ canManage, detail, onChanged, operators }: {
  canManage: boolean
  detail: OperatorIncidentDetail
  onChanged: (incident: OperatorIncidentDetail) => Promise<void>
  operators: OperatorUser[]
}) {
  const [title, setTitle] = useState(detail.title)
  const [severity, setSeverity] = useState<OperatorIncidentSeverity>(detail.severity)
  const [status, setStatus] = useState<OperatorIncidentStatus>(detail.status)
  const [summary, setSummary] = useState(detail.summary)
  const [ownerOperatorId, setOwnerOperatorId] = useState(detail.ownerOperatorId ? String(detail.ownerOperatorId) : '')
  const [error, setError] = useState('')

  async function save() {
    setError('')
    try {
      await onChanged(await updateOperatorIncident(detail.id, {
        title,
        severity,
        status,
        impactScope: detail.impactScope,
        workspaceId: detail.workspaceId,
        summary,
        ownerOperatorId: ownerOperatorId ? Number(ownerOperatorId) : null,
        expectedRevision: detail.revision,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '事故更新失败')
    }
  }

  return (
    <section className="rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{detail.incidentRef} 详情</h2><p className="mt-1 text-xs text-zinc-500">{detail.impactScope}{detail.workspaceName ? ` · ${detail.workspaceName}` : ''}</p></div><Button aria-label="刷新事故详情" onClick={async () => onChanged(await getOperatorIncident(detail.id))} size="icon" variant="ghost"><RefreshCw /></Button></div>
      {canManage && <div className="mt-5 grid gap-4 rounded-md bg-zinc-50 p-4">
        <Label>标题<Input onChange={(event) => setTitle(event.target.value)} value={title} /></Label>
        <div className="grid gap-3 sm:grid-cols-3"><Label>等级<select className={operatorSelectClassName} onChange={(event) => setSeverity(event.target.value as OperatorIncidentSeverity)} value={severity}><option value="sev1">SEV1</option><option value="sev2">SEV2</option><option value="sev3">SEV3</option><option value="sev4">SEV4</option></select></Label><Label>状态<select className={operatorSelectClassName} onChange={(event) => setStatus(event.target.value as OperatorIncidentStatus)} value={status}><option value="investigating">Investigating</option><option value="identified">Identified</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select></Label><Label>负责人<select className={operatorSelectClassName} onChange={(event) => setOwnerOperatorId(event.target.value)} value={ownerOperatorId}><option value="">暂不指派</option>{operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.email}</option>)}</select></Label></div>
        <Label>摘要<textarea className="mt-1 min-h-24 w-full rounded-md border border-input bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => setSummary(event.target.value)} value={summary} /></Label>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <Button className="justify-self-start" onClick={() => void save()}><Save />保存事故</Button>
      </div>}
      <div className="mt-5 grid gap-3"><h3 className="text-sm font-semibold">事件时间线</h3>{detail.events.map((event) => <div className="border-l-2 border-zinc-200 pl-4 text-sm" key={event.id}><div className="flex flex-wrap items-center justify-between gap-2"><strong>{event.eventType}</strong><time className="text-xs text-zinc-500">{formatOperatorDate(event.createdAt)}</time></div><p className="mt-1 text-zinc-600">{event.message}</p></div>)}</div>
      {canManage && <IncidentEventForm incidentId={detail.id} onCreated={async () => onChanged(await getOperatorIncident(detail.id))} />}
    </section>
  )
}

function IncidentEventForm({ incidentId, onCreated }: { incidentId: number; onCreated: () => Promise<void> }) {
  const [eventType, setEventType] = useState<OperatorIncidentEventType>('note')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await createOperatorIncidentEvent(incidentId, { eventType, message })
      setMessage('')
      await onCreated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '事故事件创建失败')
    }
  }
  return <form className="mt-5 grid gap-3 border-t pt-5 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-end" onSubmit={(event) => void submit(event)}><Label>事件类型<select className={operatorSelectClassName} onChange={(event) => setEventType(event.target.value as OperatorIncidentEventType)} value={eventType}><option value="note">内部记录</option><option value="mitigation">缓解措施</option><option value="customer_update">客户更新</option></select></Label><Label>内容<Input minLength={3} onChange={(event) => setMessage(event.target.value)} required value={message} /></Label><Button type="submit"><MessageSquarePlus />添加</Button>{error && <p className="text-sm text-red-600 sm:col-span-3" role="alert">{error}</p>}</form>
}
