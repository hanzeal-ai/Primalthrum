import { ShieldCheck } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { createSupportGrant, revokeSupportGrant } from './operatorClient'
import {
  formatOperatorDate,
  formatSupportContext,
  operatorSelectClassName,
} from './operatorFormatters'
import { canManageSupport, canUseSupport } from './operatorPermissions'
import type {
  OperatorUser,
  OperatorWorkspaceSummary,
  SupportAccessGrant,
  SupportGrantPermission,
} from './operatorTypes'

interface OperatorSupportSectionProps {
  grants: SupportAccessGrant[]
  onContext: (grantId: number) => Promise<void>
  onReload: () => Promise<void>
  operators: OperatorUser[]
  supportContext: Record<string, unknown> | null
  user: OperatorUser
  workspaces: OperatorWorkspaceSummary[]
}

export function OperatorSupportSection(props: OperatorSupportSectionProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="overflow-hidden rounded-md border bg-white">
        <div className="border-b px-5 py-4"><h2 className="text-sm font-semibold">支持授权</h2></div>
        <div className="divide-y">
          {props.grants.map((grant) => (
            <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto]" key={grant.id}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{grant.ticketRef}</span>
                  <Badge variant={grant.status === 'active' ? 'success' : 'secondary'}>{grant.status}</Badge>
                </div>
                <p className="mt-2 text-sm text-zinc-600">{grant.reason}</p>
                <p className="mt-2 text-xs text-zinc-500">
                  Workspace #{grant.workspaceId} · Operator #{grant.operatorUserId} · {formatOperatorDate(grant.expiresAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {canUseSupport(props.user.role) && grant.status === 'active' && grant.operatorUserId === props.user.id && (
                  <Button onClick={() => void props.onContext(grant.id)} size="sm" variant="outline">打开上下文</Button>
                )}
                {canManageSupport(props.user.role) && grant.status === 'active' && (
                  <Button
                    onClick={async () => {
                      await revokeSupportGrant(grant.id)
                      await props.onReload()
                    }}
                    size="sm"
                    variant="destructive"
                  >撤销</Button>
                )}
              </div>
            </div>
          ))}
          {!props.grants.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无支持授权</div>}
        </div>
      </section>
      <div className="grid content-start gap-5">
        {canManageSupport(props.user.role) && (
          <SupportGrantForm onCreated={props.onReload} operators={props.operators} workspaces={props.workspaces} />
        )}
        {props.supportContext && <SupportContextPanel context={props.supportContext} />}
      </div>
    </div>
  )
}

function SupportGrantForm({
  onCreated,
  operators,
  workspaces,
}: {
  onCreated: () => Promise<void>
  operators: OperatorUser[]
  workspaces: OperatorWorkspaceSummary[]
}) {
  const supportOperators = operators.filter((operator) => (
    operator.role === 'support' || operator.role === 'super_admin'
  ))
  const [workspaceId, setWorkspaceId] = useState('')
  const [operatorUserId, setOperatorUserId] = useState('')
  const [ticketRef, setTicketRef] = useState('')
  const [reason, setReason] = useState('')
  const [durationMinutes, setDurationMinutes] = useState('60')
  const [permissions, setPermissions] = useState<SupportGrantPermission[]>([
    'workspace.metadata.read',
  ])
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await createSupportGrant({
        workspaceId: Number(workspaceId),
        operatorUserId: Number(operatorUserId),
        permissions,
        reason,
        ticketRef,
        expiresAt: new Date(Date.now() + Number(durationMinutes) * 60_000).toISOString(),
      })
      setTicketRef('')
      setReason('')
      await onCreated()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '授权创建失败')
    }
  }

  const permissionOptions: Array<[SupportGrantPermission, string]> = [
    ['workspace.metadata.read', '基础信息'],
    ['workspace.agents.read', 'Agent 计数'],
    ['workspace.jobs.read', '任务状态'],
    ['workspace.billing.read', '账单摘要'],
  ]

  return (
    <Card className="rounded-md">
      <CardHeader><CardTitle className="text-sm">创建限时授权</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Label>
            Workspace
            <select className={operatorSelectClassName} onChange={(event) => setWorkspaceId(event.target.value)} required value={workspaceId}>
              <option value="">选择 Workspace</option>
              {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} (#{item.id})</option>)}
            </select>
          </Label>
          <Label>
            支持人员
            <select className={operatorSelectClassName} onChange={(event) => setOperatorUserId(event.target.value)} required value={operatorUserId}>
              <option value="">选择 Operator</option>
              {supportOperators.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}
            </select>
          </Label>
          <Label>工单号<Input onChange={(event) => setTicketRef(event.target.value)} required value={ticketRef} /></Label>
          <Label>授权理由<Input minLength={12} onChange={(event) => setReason(event.target.value)} required value={reason} /></Label>
          <Label>
            有效期
            <select className={operatorSelectClassName} onChange={(event) => setDurationMinutes(event.target.value)} value={durationMinutes}>
              <option value="30">30 分钟</option><option value="60">1 小时</option>
              <option value="120">2 小时</option><option value="240">4 小时</option>
            </select>
          </Label>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">权限范围</legend>
            {permissionOptions.map(([permission, label]) => (
              <label className="flex items-center gap-2 text-sm" key={permission}>
                <input
                  checked={permissions.includes(permission)}
                  disabled={permission === 'workspace.metadata.read'}
                  onChange={(event) => setPermissions((current) => (
                    event.target.checked
                      ? [...current, permission]
                      : current.filter((item) => item !== permission)
                  ))}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </fieldset>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <Button type="submit"><ShieldCheck />创建授权</Button>
        </form>
      </CardContent>
    </Card>
  )
}

function SupportContextPanel({ context }: { context: Record<string, unknown> }) {
  const rows = useMemo(() => Object.entries(context), [context])
  return (
    <section className="rounded-md border bg-white p-5">
      <h2 className="text-sm font-semibold">授权上下文</h2>
      <dl className="mt-4 grid gap-3">
        {rows.map(([key, value]) => (
          <div className="border-b pb-3" key={key}>
            <dt className="text-xs font-medium uppercase text-zinc-500">{key}</dt>
            <dd className="mt-1 break-words text-sm">{formatSupportContext(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
