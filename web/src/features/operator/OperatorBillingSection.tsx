import type {
  OperatorPaymentSummary,
  OperatorSubscriptionSummary,
  OperatorUsageSummary,
} from './operatorTypes'
import { formatOperatorDate, formatProviderCost } from './operatorFormatters'
import { OperatorStatusBadge } from './OperatorStatusBadge'

interface OperatorBillingSectionProps {
  payments: OperatorPaymentSummary
  subscriptions: OperatorSubscriptionSummary[]
  usage: OperatorUsageSummary[]
}

export function OperatorBillingSection(props: OperatorBillingSectionProps) {
  return (
    <div className="grid gap-6">
      <section className="overflow-hidden rounded-md border bg-white">
        <SectionHeading count={props.subscriptions.length} title="订阅" />
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500"><tr>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">套餐</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">提供商</th>
              <th className="px-5 py-3 font-medium">当前周期</th>
              <th className="px-5 py-3 font-medium">续订</th>
            </tr></thead>
            <tbody className="divide-y">
              {props.subscriptions.map((item) => <tr key={item.workspaceId}>
                <td className="px-5 py-4"><strong>{item.workspaceName}</strong><p className="mt-1 text-xs text-zinc-500">#{item.workspaceId}</p></td>
                <td className="px-5 py-4 uppercase">{item.planKey}{item.pendingPlanKey && <p className="mt-1 text-xs text-amber-700">待切换 {item.pendingPlanKey}</p>}</td>
                <td className="px-5 py-4"><OperatorStatusBadge status={item.state} /></td>
                <td className="px-5 py-4">{item.provider || '内部账本'}</td>
                <td className="px-5 py-4 text-xs text-zinc-600">{formatOperatorDate(item.periodStartsAt)}<br />{item.periodEndsAt ? formatOperatorDate(item.periodEndsAt) : '持续有效'}</td>
                <td className="px-5 py-4">{item.cancelAtPeriodEnd ? '周期末取消' : '自动续订'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <Empty visible={!props.subscriptions.length} text="暂无订阅" />
      </section>

      <section className="overflow-hidden rounded-md border bg-white">
        <SectionHeading count={props.usage.length} title="本月用量" />
        <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500"><tr>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">计量项</th>
              <th className="px-5 py-3 font-medium">数量</th>
              <th className="px-5 py-3 font-medium">Credits</th>
              <th className="px-5 py-3 font-medium">Provider 成本</th>
              <th className="px-5 py-3 font-medium">最近发生</th>
            </tr></thead>
            <tbody className="divide-y">
              {props.usage.map((item) => <tr key={`${item.workspaceId}:${item.meter}`}>
                <td className="px-5 py-4"><strong>{item.workspaceName}</strong><p className="mt-1 text-xs text-zinc-500">#{item.workspaceId}</p></td>
                <td className="px-5 py-4 font-mono text-xs">{item.meter}</td>
                <td className="px-5 py-4 tabular-nums">{item.quantity.toLocaleString()}</td>
                <td className="px-5 py-4 tabular-nums">{item.creditsCharged.toLocaleString()}</td>
                <td className="px-5 py-4 tabular-nums">{formatProviderCost(item.providerCostMicros)}</td>
                <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(item.lastOccurredAt)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <Empty visible={!props.usage.length} text="本月暂无计费用量" />
      </section>

      <PaymentSection payments={props.payments} />
    </div>
  )
}

function PaymentSection({ payments }: { payments: OperatorPaymentSummary }) {
  return (
    <section className="overflow-hidden rounded-md border bg-white">
      <SectionHeading count={payments.invoices.length + payments.refunds.length + payments.webhookFailures.length} title="支付事件" />
      <div className="overflow-x-auto">
        <table className="min-w-[820px] w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500"><tr>
            <th className="px-5 py-3 font-medium">类型</th>
            <th className="px-5 py-3 font-medium">Workspace</th>
            <th className="px-5 py-3 font-medium">状态</th>
            <th className="px-5 py-3 font-medium">金额 / 事件</th>
            <th className="px-5 py-3 font-medium">时间</th>
          </tr></thead>
          <tbody className="divide-y">
            {payments.invoices.map((item) => <tr key={`invoice:${item.id}`}>
              <td className="px-5 py-4">Invoice #{item.id}</td>
              <td className="px-5 py-4">{item.workspaceName} <span className="text-xs text-zinc-500">#{item.workspaceId}</span></td>
              <td className="px-5 py-4"><OperatorStatusBadge status={item.status} /></td>
              <td className="px-5 py-4 tabular-nums">{formatMoney(item.amountDueMinor, item.currency)}</td>
              <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(item.createdAt)}</td>
            </tr>)}
            {payments.refunds.map((item) => <tr key={`refund:${item.id}`}>
              <td className="px-5 py-4">Refund #{item.id}</td>
              <td className="px-5 py-4">{item.workspaceName} <span className="text-xs text-zinc-500">#{item.workspaceId}</span></td>
              <td className="px-5 py-4"><OperatorStatusBadge status={item.status} /></td>
              <td className="px-5 py-4 tabular-nums">-{formatMoney(item.amountMinor, item.currency)}</td>
              <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(item.createdAt)}</td>
            </tr>)}
            {payments.webhookFailures.map((item) => <tr key={`webhook:${item.id}`}>
              <td className="px-5 py-4">Webhook #{item.id}</td>
              <td className="px-5 py-4">{item.workspaceId ? `#${item.workspaceId}` : '未关联'}</td>
              <td className="px-5 py-4"><OperatorStatusBadge status={item.status} /></td>
              <td className="px-5 py-4 font-mono text-xs">{item.eventType} · {item.attempts} 次</td>
              <td className="px-5 py-4 text-zinc-600">{formatOperatorDate(item.receivedAt)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <Empty visible={!payments.invoices.length && !payments.refunds.length && !payments.webhookFailures.length} text="暂无支付事件" />
    </section>
  )
}

function SectionHeading({ count, title }: { count: number; title: string }) {
  return <div className="flex items-center justify-between border-b px-5 py-4"><h2 className="text-sm font-semibold">{title}</h2><span className="text-xs tabular-nums text-zinc-500">{count} 条</span></div>
}

function Empty({ text, visible }: { text: string; visible: boolean }) {
  return visible ? <div className="px-5 py-10 text-center text-sm text-zinc-500">{text}</div> : null
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency.toUpperCase() }).format(amountMinor / 100)
}
