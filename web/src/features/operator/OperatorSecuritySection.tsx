import type { OperatorAbuseEventSummary } from './operatorTypes'
import { formatOperatorDate } from './operatorFormatters'
import { OperatorStatusBadge } from './OperatorStatusBadge'

export function OperatorSecuritySection({ events }: { events: OperatorAbuseEventSummary[] }) {
  return (
    <section className="overflow-hidden rounded-md border bg-white">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div><h2 className="text-sm font-semibold">滥用防护事件</h2><p className="mt-1 text-xs text-zinc-500">主体标识与请求元数据不会在运营界面暴露</p></div>
        <span className="text-xs tabular-nums text-zinc-500">{events.length} 条</span>
      </div>
      <div className="overflow-x-auto"><table className="min-w-[760px] w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500"><tr>
          <th className="px-5 py-3 font-medium">事件</th><th className="px-5 py-3 font-medium">规则</th>
          <th className="px-5 py-3 font-medium">动作</th><th className="px-5 py-3 font-medium">结果</th>
          <th className="px-5 py-3 font-medium">重试等待</th><th className="px-5 py-3 font-medium">时间</th>
        </tr></thead>
        <tbody className="divide-y">{events.map((event) => <tr key={event.id}>
          <td className="px-5 py-4 font-mono text-xs">{event.eventId}</td>
          <td className="px-5 py-4 font-mono text-xs">{event.ruleKey}</td>
          <td className="px-5 py-4">{event.action}</td>
          <td className="px-5 py-4"><OperatorStatusBadge status={event.outcome} /></td>
          <td className="px-5 py-4 tabular-nums">{event.retryAfterSeconds}s</td>
          <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(event.createdAt)}</td>
        </tr>)}</tbody>
      </table></div>
      {!events.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无滥用事件</div>}
    </section>
  )
}
