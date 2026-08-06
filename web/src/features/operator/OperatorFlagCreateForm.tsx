import { Flag } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { createOperatorFeatureFlag } from './operatorClient'

export function OperatorFlagCreateForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [rolloutPercentage, setRolloutPercentage] = useState('0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await createOperatorFeatureFlag({
        key,
        description,
        enabled,
        killSwitch: false,
        rolloutPercentage: Number(rolloutPercentage),
      })
      setKey('')
      setDescription('')
      setEnabled(false)
      setRolloutPercentage('0')
      await onCreated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '功能开关创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-md border bg-white p-5">
      <h2 className="text-sm font-semibold">创建功能开关</h2>
      <form className="mt-4 grid gap-4" onSubmit={(event) => void submit(event)}>
        <Label>Key<Input onChange={(event) => setKey(event.target.value)} pattern="[a-z](?:[a-z0-9._]|-)+" placeholder="hosted.voice_v2" required value={key} /></Label>
        <Label>说明<Input minLength={12} onChange={(event) => setDescription(event.target.value)} required value={description} /></Label>
        <Label>初始灰度比例<Input max="100" min="0" onChange={(event) => setRolloutPercentage(event.target.value)} required type="number" value={rolloutPercentage} /></Label>
        <label className="flex items-center gap-2 text-sm"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />创建后启用</label>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <Button disabled={busy} type="submit"><Flag />{busy ? '创建中' : '创建开关'}</Button>
      </form>
    </section>
  )
}
