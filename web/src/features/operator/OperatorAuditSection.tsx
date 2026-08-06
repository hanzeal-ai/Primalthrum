import { formatOperatorDate } from './operatorFormatters'
import type { OperatorAuditRecord } from './operatorTypes'

export function OperatorAuditSection({ events }: { events: OperatorAuditRecord[] }) {
  return (
    <section className="overflow-hidden rounded-md border bg-white">
      <div className="border-b px-5 py-4"><h2 className="text-sm font-semibold">不可变审计事件</h2></div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500"><tr><th className="px-5 py-3">时间</th><th>事件</th><th>Operator</th><th>目标</th><th className="pr-5">元数据</th></tr></thead>
          <tbody className="divide-y">
            {events.map((event) => (
              <tr key={event.eventId}>
                <td className="whitespace-nowrap px-5 py-4 text-zinc-500">{formatOperatorDate(event.createdAt)}</td>
                <td className="font-medium">{event.eventType}</td>
                <td>#{event.operatorUserId ?? '-'}</td>
                <td>{event.targetType}{event.targetId ? ` #${event.targetId}` : ''}</td>
                <td className="max-w-md truncate pr-5 text-xs text-zinc-500" title={JSON.stringify(event.metadata)}>{JSON.stringify(event.metadata)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!events.length && <div className="px-5 py-12 text-center text-sm text-zinc-500">暂无审计事件</div>}
    </section>
  )
}
