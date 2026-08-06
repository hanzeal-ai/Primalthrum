import { Check, Clipboard, Crown, Loader2, MailPlus, Trash2, UserRound, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  createWorkspaceInvitation,
  getBillingSummary,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
} from '../../api/client'
import type {
  AuthUser,
  BillingSummary,
  CreatedWorkspaceInvitation,
  WorkspaceInvitationRecord,
  WorkspaceMemberRecord,
  WorkspaceRole,
} from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { canManageMembers, canReadBilling } from '../../lib/workspacePermissions'
import { WorkspaceAppShell } from '../app-shell/WorkspaceAppShell'
import { OwnershipTransferDialog } from './OwnershipTransferDialog'

const MEMBER_ROLES: Array<Exclude<WorkspaceRole, 'owner'>> = [
  'admin', 'developer', 'member', 'billing', 'viewer',
]

interface TeamPageProps {
  onLogout: () => Promise<void>
  onSessionRefresh: () => Promise<void>
  user: AuthUser
}

export function TeamPage({ onLogout, onSessionRefresh, user }: TeamPageProps) {
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([])
  const [invitations, setInvitations] = useState<WorkspaceInvitationRecord[]>([])
  const [billing, setBilling] = useState<BillingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, 'owner'>>('member')
  const [createdInvite, setCreatedInvite] = useState<CreatedWorkspaceInvitation | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const [transferTarget, setTransferTarget] = useState<WorkspaceMemberRecord | null>(null)
  const canManage = canManageMembers(user.role)

  useEffect(() => {
    let active = true
    void loadTeamData(user)
      .then((data) => {
        if (!active) return
        setMembers(data.members)
        setInvitations(data.invitations)
        setBilling(data.billing)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, '无法加载团队信息。'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [user])

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return
    setBusy('invite')
    setError('')
    setCopied(false)
    try {
      const created = await createWorkspaceInvitation(user.workspaceId, { email, role: inviteRole })
      setCreatedInvite(created)
      setInviteEmail('')
      setInvitations(await listWorkspaceInvitations(user.workspaceId))
    } catch (reason) {
      setError(errorMessage(reason, '无法创建邀请。'))
    } finally {
      setBusy('')
    }
  }

  async function changeRole(member: WorkspaceMemberRecord, role: Exclude<WorkspaceRole, 'owner'>) {
    setBusy(`member:${member.userId}`)
    setError('')
    try {
      const updated = await updateWorkspaceMemberRole(user.workspaceId, member.userId, role)
      setMembers((current) => current.map((item) => item.userId === updated.userId ? updated : item))
    } catch (reason) {
      setError(errorMessage(reason, '无法修改成员角色。'))
    } finally {
      setBusy('')
    }
  }

  async function removeMember(member: WorkspaceMemberRecord) {
    setBusy(`member:${member.userId}`)
    setError('')
    try {
      await removeWorkspaceMember(user.workspaceId, member.userId)
      setMembers((current) => current.filter((item) => item.userId !== member.userId))
      setConfirmRemove(null)
    } catch (reason) {
      setError(errorMessage(reason, '无法移除成员。'))
    } finally {
      setBusy('')
    }
  }

  async function revokeInvitation(invitation: WorkspaceInvitationRecord) {
    setBusy(`invite:${invitation.id}`)
    setError('')
    try {
      await revokeWorkspaceInvitation(user.workspaceId, invitation.id)
      setInvitations(await listWorkspaceInvitations(user.workspaceId))
      if (createdInvite?.id === invitation.id) setCreatedInvite(null)
    } catch (reason) {
      setError(errorMessage(reason, '无法撤销邀请。'))
    } finally {
      setBusy('')
    }
  }

  async function transferOwnership(input: { password: string; confirmTargetEmail: string }) {
    if (!transferTarget) return
    setBusy('ownership')
    setError('')
    try {
      await transferWorkspaceOwnership(user.workspaceId, {
        targetUserId: transferTarget.userId,
        ...input,
      })
      setTransferTarget(null)
      await onSessionRefresh()
    } catch (reason) {
      setError(errorMessage(reason, '无法转移 Workspace 所有权。'))
    } finally {
      setBusy('')
    }
  }

  async function copyInvite() {
    if (!createdInvite) return
    try {
      await navigator.clipboard.writeText(createdInvite.acceptUrl)
      setCopied(true)
    } catch {
      setError('浏览器无法写入剪贴板，请手动复制邀请链接。')
    }
  }

  const seatLimit = billing?.entitlementSnapshot.entitlements.seats?.quantityLimit ?? null
  const seatText = seatLimit === null ? `${members.length} 位成员` : `${members.length} / ${seatLimit} 席位`

  return (
    <WorkspaceAppShell active="team" description="成员、邀请、角色与席位" onLogout={onLogout} title="团队成员" user={user}>
      {error ? <div className="mb-5 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</div> : null}
      {loading ? <LoadingState /> : (
        <div className="grid min-w-0 gap-8">
          <section className="min-w-0" aria-labelledby="members-title">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div><p className="text-sm font-medium text-blue-700">{seatText}</p><h2 className="mt-1 text-2xl font-semibold" id="members-title">成员</h2></div>
              {!canManage ? <p className="text-xs text-zinc-500">只有 Owner 或 Admin 可以管理团队。</p> : null}
            </div>
            <div className="mt-4 overflow-hidden rounded-lg border bg-white">
              {members.map((member) => (
                <div className="grid min-w-0 gap-3 border-b p-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-center" key={member.id}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-600"><UserRound className="size-4" /></span>
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{member.email}</p><p className="mt-1 text-xs text-zinc-500">加入于 {formatDate(member.createdAt)}</p></div>
                  </div>
                  {canManage && member.role !== 'owner' && member.userId !== user.id ? (
                    <select aria-label={`调整 ${member.email} 的角色`} className="h-9 rounded-md border bg-white px-3 text-sm" disabled={busy === `member:${member.userId}`} onChange={(event) => void changeRole(member, event.target.value as Exclude<WorkspaceRole, 'owner'>)} value={member.role}>
                      {MEMBER_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                    </select>
                  ) : <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>{roleLabel(member.role)}</Badge>}
                  {canManage && member.role !== 'owner' && member.userId !== user.id ? (
                    <div className="flex justify-end gap-1">
                      {user.role === 'owner' ? <Button aria-label={`转移所有权给 ${member.email}`} disabled={Boolean(busy)} onClick={() => setTransferTarget(member)} size="icon" title="转移所有权" variant="ghost"><Crown /></Button> : null}
                      {confirmRemove === member.userId ? <><Button aria-label={`确认移除 ${member.email}`} disabled={Boolean(busy)} onClick={() => void removeMember(member)} size="icon" variant="destructive"><Check /></Button><Button aria-label="取消移除" onClick={() => setConfirmRemove(null)} size="icon" variant="ghost"><X /></Button></>
                        : <Button aria-label={`移除 ${member.email}`} onClick={() => setConfirmRemove(member.userId)} size="icon" title="移除成员" variant="ghost"><Trash2 /></Button>}
                    </div>
                  ) : <span />}
                </div>
              ))}
            </div>
          </section>

          {canManage ? <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]" aria-labelledby="invite-title">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><MailPlus className="size-4" /><h2 className="text-lg font-semibold" id="invite-title">邀请成员</h2></div>
              <p className="mt-1 text-sm text-zinc-500">创建一次性安全链接并发送给成员，链接 7 天有效。</p>
              <form className="mt-4 grid gap-4 rounded-lg border bg-white p-5" onSubmit={createInvitation}>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                  <Label className="grid gap-2">邮箱<Input aria-label="邀请邮箱" autoComplete="email" onChange={(event) => setInviteEmail(event.target.value)} placeholder="member@company.com" type="email" value={inviteEmail} /></Label>
                  <Label className="grid gap-2">角色<select aria-label="邀请角色" className="h-9 rounded-md border bg-white px-3 text-sm" onChange={(event) => setInviteRole(event.target.value as Exclude<WorkspaceRole, 'owner'>)} value={inviteRole}>{MEMBER_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></Label>
                </div>
                <div className="flex justify-end"><Button disabled={!inviteEmail.trim() || Boolean(busy)} type="submit">{busy === 'invite' ? <Loader2 className="animate-spin" /> : <MailPlus />}创建邀请</Button></div>
              </form>
              {createdInvite ? <div className="mt-4 border border-emerald-200 bg-emerald-50 p-4"><p className="text-sm font-medium text-emerald-800">邀请邮件已加入发送队列</p><p className="mt-1 text-xs text-emerald-700">也可以复制邀请链接，通过其他方式发送。</p><div className="mt-3 flex gap-2"><Input aria-label="邀请链接" readOnly value={createdInvite.acceptUrl} /><Button aria-label="复制邀请链接" onClick={() => void copyInvite()} size="icon" variant="outline">{copied ? <Check /> : <Clipboard />}</Button></div></div> : null}
            </div>

            <aside className="min-w-0">
              <h2 className="text-lg font-semibold">待处理邀请</h2>
              <div className="mt-4 overflow-hidden rounded-lg border bg-white">
                {invitations.length ? invitations.slice(0, 10).map((invitation) => {
                  const status = invitationStatus(invitation)
                  return <div className="border-b p-4 last:border-b-0" key={invitation.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{invitation.email}</p><p className="mt-1 text-xs text-zinc-500">{roleLabel(invitation.role)} · 至 {formatDate(invitation.expiresAt)}</p></div><Badge variant={status === '待接受' ? 'success' : 'secondary'}>{status}</Badge></div>{status === '待接受' ? <Button className="mt-3" disabled={Boolean(busy)} onClick={() => void revokeInvitation(invitation)} size="sm" variant="ghost">撤销邀请</Button> : null}</div>
                }) : <p className="p-5 text-sm text-zinc-500">没有邀请记录。</p>}
              </div>
            </aside>
          </section> : null}
        </div>
      )}
      {transferTarget ? <OwnershipTransferDialog busy={busy === 'ownership'} member={transferTarget} onCancel={() => setTransferTarget(null)} onConfirm={transferOwnership} /> : null}
    </WorkspaceAppShell>
  )
}

function LoadingState() {
  return <div className="grid min-h-72 place-items-center text-sm text-zinc-500"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在加载团队</span></div>
}

function loadTeamData(user: AuthUser): Promise<{
  members: WorkspaceMemberRecord[]
  invitations: WorkspaceInvitationRecord[]
  billing: BillingSummary | null
}> {
  return Promise.all([
    listWorkspaceMembers(user.workspaceId),
    canManageMembers(user.role) ? listWorkspaceInvitations(user.workspaceId) : Promise.resolve([]),
    canReadBilling(user.role) ? getBillingSummary() : Promise.resolve(null),
  ]).then(([members, invitations, billing]) => ({ members, invitations, billing }))
}

function invitationStatus(invitation: WorkspaceInvitationRecord): string {
  if (invitation.acceptedAt) return '已接受'
  if (invitation.revokedAt) return '已撤销'
  if (invitation.expiresAt <= new Date().toISOString()) return '已过期'
  return '待接受'
}

function roleLabel(role: WorkspaceRole): string {
  return ({ owner: 'Owner', admin: 'Admin', developer: 'Developer', member: 'Member', billing: 'Billing', viewer: 'Viewer' })[role]
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
