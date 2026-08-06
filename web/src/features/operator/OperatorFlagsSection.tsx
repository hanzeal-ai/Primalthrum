import { History, Save, ShieldOff } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { OperatorFlagCreateForm } from './OperatorFlagCreateForm'
import { OperatorFlagOverrideForm } from './OperatorFlagOverrideForm'
import {
  listOperatorFeatureFlagEvents,
  revokeOperatorFeatureFlagOverride,
  updateOperatorFeatureFlag,
} from './operatorClient'
import { formatOperatorDate } from './operatorFormatters'
import { canManageChangeControl } from './operatorPermissions'
import type {
  OperatorFeatureFlag,
  OperatorFeatureFlagEvent,
  OperatorRole,
  OperatorWorkspaceSummary,
} from './operatorTypes'

export function OperatorFlagsSection({ flags, onReload, role, workspaces }: {
  flags: OperatorFeatureFlag[]
  onReload: () => Promise<void>
  role: OperatorRole
  workspaces: OperatorWorkspaceSummary[]
}) {
  const canManage = canManageChangeControl(role)
  const [events, setEvents] = useState<OperatorFeatureFlagEvent[]>([])
  const [historyKey, setHistoryKey] = useState('')

  async function openHistory(flag: OperatorFeatureFlag) {
    setHistoryKey(flag.key)
    setEvents(await listOperatorFeatureFlagEvents(flag.id))
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid content-start gap-5">
        <section className="overflow-hidden rounded-md border bg-white">
          <div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="text-sm font-semibold">功能开关</h2><p className="mt-1 text-xs text-zinc-500">Kill Switch 始终覆盖灰度与 Workspace Override</p></div><span className="text-xs text-zinc-500">{flags.length} 条</span></div>
          <div className="divide-y">
            {flags.map((flag) => <FlagControl canManage={canManage} flag={flag} key={flag.id} onHistory={() => openHistory(flag)} onReload={onReload} />)}
            {!flags.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无功能开关</div>}
          </div>
        </section>
        {historyKey && <FlagHistory events={events} flagKey={historyKey} />}
      </div>
      {canManage && <div className="grid content-start gap-5"><OperatorFlagCreateForm onCreated={onReload} /><OperatorFlagOverrideForm flags={flags} onCreated={onReload} workspaces={workspaces} /></div>}
    </div>
  )
}

function FlagControl({ canManage, flag, onHistory, onReload }: {
  canManage: boolean
  flag: OperatorFeatureFlag
  onHistory: () => Promise<void>
  onReload: () => Promise<void>
}) {
  const [description, setDescription] = useState(flag.description)
  const [enabled, setEnabled] = useState(flag.enabled)
  const [killSwitch, setKillSwitch] = useState(flag.killSwitch)
  const [rolloutPercentage, setRolloutPercentage] = useState(String(flag.rolloutPercentage))
  const [error, setError] = useState('')

  async function save() {
    setError('')
    try {
      await updateOperatorFeatureFlag(flag.id, {
        description,
        enabled,
        killSwitch,
        rolloutPercentage: Number(rolloutPercentage),
        expectedRevision: flag.revision,
      })
      await onReload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '功能开关更新失败')
    }
  }

  return (
    <article className="px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex flex-wrap items-center gap-2"><strong className="font-mono text-sm">{flag.key}</strong>{flag.killSwitch ? <Badge variant="destructive">紧急关闭</Badge> : flag.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="secondary">停用</Badge>}<Badge variant="outline">rev {flag.revision}</Badge></div><p className="mt-2 text-sm text-zinc-600">{flag.description}</p></div>
        <Button onClick={() => void onHistory()} size="sm" variant="ghost"><History />历史</Button>
      </div>
      {canManage && <div className="mt-4 grid gap-3 rounded-md bg-zinc-50 p-4 md:grid-cols-[minmax(180px,1fr)_100px_auto_auto_auto] md:items-end">
        <label className="text-xs font-medium text-zinc-600">说明<Input className="mt-1" onChange={(event) => setDescription(event.target.value)} value={description} /></label>
        <label className="text-xs font-medium text-zinc-600">灰度 %<Input className="mt-1" max="100" min="0" onChange={(event) => setRolloutPercentage(event.target.value)} type="number" value={rolloutPercentage} /></label>
        <label className="flex h-9 items-center gap-2 text-sm"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />启用</label>
        <label className="flex h-9 items-center gap-2 text-sm text-red-700"><input checked={killSwitch} onChange={(event) => setKillSwitch(event.target.checked)} type="checkbox" /><ShieldOff className="size-4" />Kill</label>
        <Button onClick={() => void save()} size="sm"><Save />保存</Button>
      </div>}
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      {!!flag.overrides.length && <div className="mt-4 grid gap-2">{flag.overrides.map((override) => <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs" key={override.id}><span>{override.workspaceName} (#{override.workspaceId}) · {override.enabled ? '启用' : '停用'} · {override.reason}</span>{override.active ? canManage && <Button onClick={async () => { await revokeOperatorFeatureFlagOverride(flag.id, override.id, override.revision); await onReload() }} size="sm" variant="ghost">撤销</Button> : <Badge variant="secondary">已撤销</Badge>}</div>)}</div>}
    </article>
  )
}

function FlagHistory({ events, flagKey }: { events: OperatorFeatureFlagEvent[]; flagKey: string }) {
  return <section className="rounded-md border bg-white p-5"><h2 className="text-sm font-semibold">{flagKey} 变更历史</h2><div className="mt-4 grid gap-3">{events.map((event) => <div className="flex items-center justify-between gap-4 border-b pb-3 text-sm" key={event.id}><span>{event.action} · Operator #{event.operatorUserId}</span><time className="text-xs text-zinc-500">{formatOperatorDate(event.createdAt)}</time></div>)}</div></section>
}
