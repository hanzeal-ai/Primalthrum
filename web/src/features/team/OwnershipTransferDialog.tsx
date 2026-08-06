import { Crown, Loader2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import type { WorkspaceMemberRecord } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

interface OwnershipTransferDialogProps {
  busy: boolean
  member: WorkspaceMemberRecord
  onCancel: () => void
  onConfirm: (input: { password: string; confirmTargetEmail: string }) => Promise<void>
}

export function OwnershipTransferDialog({
  busy,
  member,
  onCancel,
  onConfirm,
}: OwnershipTransferDialogProps) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const confirmed = confirmation.trim().toLowerCase() === member.email

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || !confirmed || busy) return
    void onConfirm({ password, confirmTargetEmail: confirmation.trim().toLowerCase() })
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-zinc-950/50 px-4 py-8" role="presentation">
      <section aria-labelledby="ownership-transfer-title" aria-modal="true" className="w-full max-w-lg bg-white p-6 shadow-2xl" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-700"><Crown className="size-5" /></span>
            <div className="min-w-0"><h2 className="text-xl font-semibold" id="ownership-transfer-title">转移 Workspace 所有权</h2><p className="mt-2 text-sm leading-6 text-zinc-600">{member.email} 将成为 Owner，你的角色将变为 Admin。</p></div>
          </div>
          <Button aria-label="关闭所有权转移" disabled={busy} onClick={onCancel} size="icon" variant="ghost"><X /></Button>
        </div>
        <form className="mt-6 grid gap-4" onSubmit={submit}>
          <Label className="grid gap-2">确认目标成员邮箱<Input aria-label="确认目标成员邮箱" autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} placeholder={member.email} value={confirmation} /></Label>
          <Label className="grid gap-2">当前密码<Input aria-label="所有权转移当前密码" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Label>
          <p className="border-l-2 border-amber-500 pl-3 text-sm leading-6 text-zinc-600">转移立即生效。只有新 Owner 能再次转移所有权或管理 Workspace 级商业设置。</p>
          <div className="mt-2 flex justify-end gap-2">
            <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">取消</Button>
            <Button disabled={busy || !password || !confirmed} type="submit" variant="destructive">{busy ? <Loader2 className="animate-spin" /> : <Crown />}确认转移</Button>
          </div>
        </form>
      </section>
    </div>
  )
}
