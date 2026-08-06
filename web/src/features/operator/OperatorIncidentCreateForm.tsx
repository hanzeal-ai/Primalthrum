import { Siren } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { createOperatorIncident } from './operatorClient'
import { operatorSelectClassName } from './operatorFormatters'
import type {
  OperatorIncidentDetail,
  OperatorIncidentScope,
  OperatorIncidentSeverity,
  OperatorUser,
  OperatorWorkspaceSummary,
} from './operatorTypes'

export function OperatorIncidentCreateForm({ onCreated, operators, workspaces }: {
  onCreated: (incident: OperatorIncidentDetail) => Promise<void>
  operators: OperatorUser[]
  workspaces: OperatorWorkspaceSummary[]
}) {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<OperatorIncidentSeverity>('sev3')
  const [impactScope, setImpactScope] = useState<OperatorIncidentScope>('platform')
  const [workspaceId, setWorkspaceId] = useState('')
  const [summary, setSummary] = useState('')
  const [ownerOperatorId, setOwnerOperatorId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const incident = await createOperatorIncident({
        title,
        severity,
        impactScope,
        workspaceId: impactScope === 'workspace' ? Number(workspaceId) : null,
        summary,
        startedAt: new Date().toISOString(),
        ownerOperatorId: ownerOperatorId ? Number(ownerOperatorId) : null,
      })
      setTitle('')
      setSummary('')
      await onCreated(incident)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '事故创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-md border bg-white p-5">
      <h2 className="text-sm font-semibold">创建事故</h2>
      <form className="mt-4 grid gap-4" onSubmit={(event) => void submit(event)}>
        <Label>标题<Input minLength={5} onChange={(event) => setTitle(event.target.value)} required value={title} /></Label>
        <div className="grid grid-cols-2 gap-3">
          <Label>等级<select className={operatorSelectClassName} onChange={(event) => setSeverity(event.target.value as OperatorIncidentSeverity)} value={severity}><option value="sev1">SEV1</option><option value="sev2">SEV2</option><option value="sev3">SEV3</option><option value="sev4">SEV4</option></select></Label>
          <Label>范围<select className={operatorSelectClassName} onChange={(event) => setImpactScope(event.target.value as OperatorIncidentScope)} value={impactScope}><option value="platform">平台</option><option value="multi_workspace">多个 Workspace</option><option value="workspace">单个 Workspace</option></select></Label>
        </div>
        {impactScope === 'workspace' && <Label>Workspace<select className={operatorSelectClassName} onChange={(event) => setWorkspaceId(event.target.value)} required value={workspaceId}><option value="">选择 Workspace</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} (#{workspace.id})</option>)}</select></Label>}
        <Label>负责人<select className={operatorSelectClassName} onChange={(event) => setOwnerOperatorId(event.target.value)} value={ownerOperatorId}><option value="">暂不指派</option>{operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.email}</option>)}</select></Label>
        <Label>摘要<textarea className="mt-1 min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" minLength={12} onChange={(event) => setSummary(event.target.value)} required value={summary} /></Label>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <Button disabled={busy} type="submit"><Siren />{busy ? '创建中' : '创建事故'}</Button>
      </form>
    </section>
  )
}
