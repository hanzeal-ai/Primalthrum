import { Badge } from '../../components/ui/badge'
import { formatProviderCost } from './operatorFormatters'
import type { OperatorWorkspaceSummary } from './operatorTypes'

export function OperatorWorkspacesSection({
  workspaces,
}: {
  workspaces: OperatorWorkspaceSummary[]
}) {
  return (
    <section className="overflow-hidden rounded-md border bg-white">
      <div className="border-b px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold">Workspace 运营状态</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr><th className="px-5 py-3">Workspace</th><th>套餐</th><th>成员</th><th>Agents</th><th>失败任务</th><th>Credits</th><th>成本</th></tr>
          </thead>
          <tbody className="divide-y">
            {workspaces.map((workspace) => (
              <tr key={workspace.id}>
                <td className="px-5 py-4">
                  <p className="font-medium">{workspace.name}</p>
                  <p className="mt-1 text-xs text-zinc-500">#{workspace.id} · {workspace.slug}</p>
                </td>
                <td><Badge variant="outline">{workspace.planKey} · {workspace.subscriptionState}</Badge></td>
                <td className="tabular-nums">{workspace.memberCount}</td>
                <td className="tabular-nums">{workspace.agentCount}</td>
                <td className={workspace.failedJobCount ? 'font-medium text-red-600' : 'text-zinc-500'}>{workspace.failedJobCount}</td>
                <td className="tabular-nums">{workspace.periodCredits.toLocaleString()}</td>
                <td className="pr-5 tabular-nums">{formatProviderCost(workspace.periodProviderCostMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!workspaces.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无 Workspace</div>}
    </section>
  )
}
