import { CheckCircle2, CircleMinus } from 'lucide-react'

import type { OperatorCustomerUserSummary } from './operatorTypes'
import { formatOperatorDate } from './operatorFormatters'
import { OperatorStatusBadge } from './OperatorStatusBadge'

export function OperatorCustomerSection({ users }: { users: OperatorCustomerUserSummary[] }) {
  return (
    <section className="overflow-hidden rounded-md border bg-white">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">客户用户</h2>
          <p className="mt-1 text-xs text-zinc-500">仅展示去标识化账户与安全状态</p>
        </div>
        <span className="text-xs tabular-nums text-zinc-500">{users.length} 条</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[860px] w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="px-5 py-3 font-medium">用户引用</th>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">角色</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">安全</th>
              <th className="px-5 py-3 font-medium">最近活动</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((user) => (
              <tr key={`${user.userId}:${user.workspaceId}`}>
                <td className="px-5 py-4 font-mono text-xs">{user.userRef}</td>
                <td className="px-5 py-4">
                  <p className="font-medium">{user.workspaceName}</p>
                  <p className="mt-1 text-xs text-zinc-500">#{user.workspaceId}</p>
                </td>
                <td className="px-5 py-4">{user.role}</td>
                <td className="px-5 py-4"><OperatorStatusBadge status={user.status} /></td>
                <td className="px-5 py-4">
                  <SecurityState enabled={user.emailVerified} label="邮箱" />
                  <SecurityState enabled={user.mfaEnabled} label="MFA" />
                </td>
                <td className="px-5 py-4 text-zinc-600">
                  {user.lastSessionAt ? formatOperatorDate(user.lastSessionAt) : '尚未登录'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!users.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无客户用户</div>}
    </section>
  )
}

function SecurityState({ enabled, label }: { enabled: boolean; label: string }) {
  const Icon = enabled ? CheckCircle2 : CircleMinus
  return (
    <span className={`mr-3 inline-flex items-center gap-1 text-xs ${enabled ? 'text-emerald-700' : 'text-zinc-400'}`}>
      <Icon className="size-3.5" />{label}
    </span>
  )
}
