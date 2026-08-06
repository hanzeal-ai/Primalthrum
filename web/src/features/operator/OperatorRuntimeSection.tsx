import type { OperatorAgentSummary, OperatorJobSummary } from './operatorTypes'
import { formatOperatorDate } from './operatorFormatters'
import { OperatorStatusBadge } from './OperatorStatusBadge'

export function OperatorRuntimeSection({ agents, jobs }: {
  agents: OperatorAgentSummary[]
  jobs: OperatorJobSummary[]
}) {
  return (
    <div className="grid gap-6">
      <section className="overflow-hidden rounded-md border bg-white">
        <Heading count={agents.length} title="Agent 运行状态" />
        <div className="overflow-x-auto"><table className="min-w-[820px] w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500"><tr>
            <th className="px-5 py-3 font-medium">Agent</th><th className="px-5 py-3 font-medium">Workspace</th>
            <th className="px-5 py-3 font-medium">状态</th><th className="px-5 py-3 font-medium">版本</th>
            <th className="px-5 py-3 font-medium">活跃部署</th><th className="px-5 py-3 font-medium">更新时间</th>
          </tr></thead>
          <tbody className="divide-y">{agents.map((agent) => <tr key={agent.id}>
            <td className="px-5 py-4 font-mono text-xs"><strong>{agent.agentRef}</strong></td>
            <td className="px-5 py-4">{agent.workspaceName} <span className="text-xs text-zinc-500">#{agent.workspaceId}</span></td>
            <td className="px-5 py-4"><OperatorStatusBadge status={agent.status} /></td>
            <td className="px-5 py-4 tabular-nums">{agent.versionCount}</td>
            <td className="px-5 py-4 tabular-nums">{agent.activeDeploymentCount}</td>
            <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(agent.updatedAt)}</td>
          </tr>)}</tbody>
        </table></div>
        {!agents.length && <Empty text="暂无 Agent" />}
      </section>

      <section className="overflow-hidden rounded-md border bg-white">
        <Heading count={jobs.length} title="后台任务" />
        <div className="overflow-x-auto"><table className="min-w-[820px] w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500"><tr>
            <th className="px-5 py-3 font-medium">任务</th><th className="px-5 py-3 font-medium">Workspace</th>
            <th className="px-5 py-3 font-medium">状态</th><th className="px-5 py-3 font-medium">尝试</th>
            <th className="px-5 py-3 font-medium">错误</th><th className="px-5 py-3 font-medium">更新时间</th>
          </tr></thead>
          <tbody className="divide-y">{jobs.map((job) => <tr key={job.id}>
            <td className="px-5 py-4"><strong>#{job.id}</strong><p className="mt-1 font-mono text-xs text-zinc-500">{job.type}</p></td>
            <td className="px-5 py-4">{job.workspaceName} <span className="text-xs text-zinc-500">#{job.workspaceId}</span></td>
            <td className="px-5 py-4"><OperatorStatusBadge status={job.status} /></td>
            <td className="px-5 py-4 tabular-nums">{job.attempts}/{job.maxAttempts}</td>
            <td className="px-5 py-4">{job.hasError ? '有错误记录' : '无'}</td>
            <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(job.updatedAt)}</td>
          </tr>)}</tbody>
        </table></div>
        {!jobs.length && <Empty text="暂无后台任务" />}
      </section>
    </div>
  )
}

function Heading({ count, title }: { count: number; title: string }) {
  return <div className="flex items-center justify-between border-b px-5 py-4"><h2 className="text-sm font-semibold">{title}</h2><span className="text-xs tabular-nums text-zinc-500">{count} 条</span></div>
}

function Empty({ text }: { text: string }) {
  return <div className="px-5 py-10 text-center text-sm text-zinc-500">{text}</div>
}
