import { Activity } from 'lucide-react'

import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { formatProviderCost } from './operatorFormatters'
import type { OperatorOverviewResponse } from './operatorTypes'

export function OperatorOverviewSection({
  data,
}: {
  data: OperatorOverviewResponse | null
}) {
  if (!data) return <div className="py-12 text-center text-sm text-zinc-500">暂无平台概览</div>
  const metrics = [
    ['Workspaces', data.overview.workspaces],
    ['用户', data.overview.users],
    ['有效订阅', data.overview.activeSubscriptions],
    ['Agents', data.overview.agents],
    ['失败任务', data.overview.failedJobs],
    ['支付失败', data.overview.failedPayments],
    ['滥用拦截', data.overview.abuseEnforcements],
    ['有效支持授权', data.overview.activeSupportGrants],
  ] as const

  return (
    <div className="grid gap-6">
      <section aria-label="平台指标" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {metrics.map(([label, value]) => (
          <Card className="rounded-md" key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-zinc-500">{label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="border-y bg-white px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">系统健康</h2>
            <p className="mt-1 text-xs text-zinc-500">Server 与运行时实时就绪状态</p>
          </div>
          <Badge variant={data.readiness.status === 'ready' ? 'success' : 'destructive'}>
            {data.readiness.status}
          </Badge>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {data.readiness.checks.map((check) => (
            <div className="flex items-center justify-between border-b py-3 text-sm" key={check.name}>
              <span className="flex items-center gap-2">
                <Activity className="size-4 text-zinc-400" />{check.name}
              </span>
              <span className="tabular-nums text-zinc-500">{check.status} · {check.latencyMs} ms</span>
            </div>
          ))}
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-2">
        <MetricBand label="本月 Credits" value={data.overview.monthlyCredits.toLocaleString()} />
        <MetricBand label="本月 Provider 成本" value={formatProviderCost(data.overview.monthlyProviderCostMicros)} />
      </section>
    </div>
  )
}

function MetricBand({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-4 border-blue-500 bg-white px-5 py-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}
