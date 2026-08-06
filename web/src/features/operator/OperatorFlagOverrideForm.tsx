import { ShieldPlus } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { createOperatorFeatureFlagOverride } from './operatorClient'
import { operatorSelectClassName } from './operatorFormatters'
import type { OperatorFeatureFlag, OperatorWorkspaceSummary } from './operatorTypes'

export function OperatorFlagOverrideForm({ flags, onCreated, workspaces }: {
  flags: OperatorFeatureFlag[]
  onCreated: () => Promise<void>
  workspaces: OperatorWorkspaceSummary[]
}) {
  const [flagId, setFlagId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await createOperatorFeatureFlagOverride(Number(flagId), {
        workspaceId: Number(workspaceId),
        enabled,
        reason,
      })
      setReason('')
      await onCreated()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Workspace Override 创建失败')
    }
  }

  return (
    <section className="rounded-md border bg-white p-5">
      <h2 className="text-sm font-semibold">Workspace Override</h2>
      <form className="mt-4 grid gap-4" onSubmit={(event) => void submit(event)}>
        <Label>功能开关<select className={operatorSelectClassName} onChange={(event) => setFlagId(event.target.value)} required value={flagId}><option value="">选择开关</option>{flags.map((flag) => <option key={flag.id} value={flag.id}>{flag.key}</option>)}</select></Label>
        <Label>Workspace<select className={operatorSelectClassName} onChange={(event) => setWorkspaceId(event.target.value)} required value={workspaceId}><option value="">选择 Workspace</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} (#{workspace.id})</option>)}</select></Label>
        <Label>理由<Input minLength={12} onChange={(event) => setReason(event.target.value)} required value={reason} /></Label>
        <label className="flex items-center gap-2 text-sm"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />为此 Workspace 启用</label>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <Button type="submit"><ShieldPlus />创建 Override</Button>
      </form>
    </section>
  )
}
