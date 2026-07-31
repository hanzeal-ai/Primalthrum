import { AlertTriangle, BarChart3, Loader2, Save } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  getBillingSummary,
  getBillingUsage,
  listBillingCostAlerts,
  updateBillingCostControls,
} from '../../api/client'
import type {
  AuthUser,
  BillingCostAlert,
  BillingSummary,
  BillingUsageSummary,
} from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Progress } from '../../components/ui/progress'
import { canManageBilling } from '../../lib/workspacePermissions'
import { WorkspaceAppShell } from '../app-shell/WorkspaceAppShell'

interface UsagePageProps {
  onLogout: () => Promise<void>
  user: AuthUser
}

interface CostControlForm {
  monthlyCreditLimit: string
  monthlyProviderCost: string
  hardLimit: boolean
  overageEnabled: boolean
}

export function UsagePage({ onLogout, user }: UsagePageProps) {
  const [usage, setUsage] = useState<BillingUsageSummary | null>(null)
  const [billing, setBilling] = useState<BillingSummary | null>(null)
  const [alerts, setAlerts] = useState<BillingCostAlert[]>([])
  const [controls, setControls] = useState<CostControlForm>(EMPTY_CONTROLS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const canManage = canManageBilling(user.role)

  useEffect(() => {
    let active = true
    void loadUsagePageData()
      .then((data) => {
        if (!active) return
        const [nextUsage, nextBilling, nextAlerts] = data
        setUsage(nextUsage)
        setBilling(nextBilling)
        setAlerts(nextAlerts)
        setControls(controlsFromUsage(nextUsage))
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, '无法加载用量信息。'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  async function saveControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!usage) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const updated = await updateBillingCostControls({
        monthlyCreditLimit: parseOptionalInteger(controls.monthlyCreditLimit, '月度 credits 上限'),
        monthlyProviderCostMicrosLimit: parseOptionalMoneyMicros(controls.monthlyProviderCost),
        hardLimit: controls.hardLimit,
        overageEnabled: controls.overageEnabled,
        alertThresholds: usage.controls.alertThresholds,
      })
      setUsage({ ...usage, controls: updated })
      setSaved(true)
    } catch (reason) {
      setError(errorMessage(reason, '无法保存成本控制。'))
    } finally {
      setSaving(false)
    }
  }

  const creditTotal = billing
    ? billing.creditAccount.availableCredits + billing.creditAccount.reservedCredits + billing.creditAccount.spentCredits
    : 0
  const creditPercent = creditTotal && billing
    ? Math.round((billing.creditAccount.spentCredits / creditTotal) * 100)
    : 0

  return (
    <WorkspaceAppShell
      active="usage"
      description="查看计量证据并控制月度成本"
      onLogout={onLogout}
      title="用量与成本"
      user={user}
    >
      {error ? <div className="mb-5 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</div> : null}
      {loading ? <LoadingState /> : usage && billing ? (
        <div className="grid gap-8">
          <section aria-labelledby="usage-overview-title">
            <div>
              <p className="text-sm font-medium text-blue-700">{formatPeriod(usage.periodStartsAt, usage.periodEndsAt)}</p>
              <h2 className="mt-1 text-2xl font-semibold" id="usage-overview-title">本月用量</h2>
            </div>
            <div className="mt-5 grid gap-px overflow-hidden rounded-lg border bg-zinc-200 sm:grid-cols-3">
              <Metric label="已计费 credits" value={usage.creditsCharged.toLocaleString()} />
              <Metric label="Provider 成本" value={formatProviderCost(usage.providerCostMicros)} />
              <Metric label="计量事件" value={usage.eventCount.toLocaleString()} />
            </div>
            <div className="mt-4 rounded-lg border bg-white p-5">
              <div className="flex items-end justify-between gap-4">
                <div><p className="text-sm font-medium">套餐 credits</p><p className="mt-1 text-xs text-zinc-500">已使用 {billing.creditAccount.spentCredits.toLocaleString()}，剩余 {billing.creditAccount.availableCredits.toLocaleString()}</p></div>
                <p className="text-sm font-semibold">{creditPercent}%</p>
              </div>
              <Progress className="mt-3" value={creditPercent} />
            </div>
          </section>

          <section aria-labelledby="meter-title">
            <div className="flex items-center gap-2"><BarChart3 className="size-4" /><h2 className="text-lg font-semibold" id="meter-title">按计量项</h2></div>
            <div className="mt-4 overflow-hidden rounded-lg border bg-white">
              <div className="hidden grid-cols-[minmax(0,1fr)_repeat(3,minmax(120px,auto))] gap-4 border-b bg-zinc-50 px-4 py-3 text-xs font-medium text-zinc-500 md:grid">
                <span>计量项</span><span className="text-right">数量</span><span className="text-right">Credits</span><span className="text-right">Provider 成本</span>
              </div>
              {usage.byMeter.length ? usage.byMeter.map((meter) => (
                <div className="grid gap-2 border-b px-4 py-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_repeat(3,minmax(120px,auto))] md:items-center md:gap-4" key={meter.meter}>
                  <div><p className="text-sm font-medium">{meterLabel(meter.meter)}</p><p className="mt-1 text-xs text-zinc-500">{meter.meter}</p></div>
                  <DataPoint label="数量" value={meter.quantity.toLocaleString()} />
                  <DataPoint label="Credits" value={meter.creditsCharged.toLocaleString()} />
                  <DataPoint label="Provider 成本" value={formatProviderCost(meter.providerCostMicros)} />
                </div>
              )) : <p className="p-6 text-sm text-zinc-500">本周期还没有可计费事件。</p>}
            </div>
          </section>

          <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]" aria-labelledby="controls-title">
            <div>
              <h2 className="text-lg font-semibold" id="controls-title">成本控制</h2>
              <p className="mt-1 text-sm text-zinc-500">在执行 Provider 操作前检查预计用量，避免意外支出。</p>
              {canManage ? (
                <form className="mt-4 grid gap-5 rounded-lg border bg-white p-5" onSubmit={saveControls}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Label className="grid gap-2">月度 credits 上限
                      <Input inputMode="numeric" min="0" onChange={(event) => setControls({ ...controls, monthlyCreditLimit: event.target.value })} placeholder="不限制" type="number" value={controls.monthlyCreditLimit} />
                    </Label>
                    <Label className="grid gap-2">月度 Provider 成本上限
                      <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500">$</span><Input aria-label="月度 Provider 成本上限" className="pl-7" inputMode="decimal" min="0" onChange={(event) => setControls({ ...controls, monthlyProviderCost: event.target.value })} placeholder="不限制" step="0.01" type="number" value={controls.monthlyProviderCost} /></div>
                    </Label>
                  </div>
                  <label className="flex items-start gap-3 text-sm"><input checked={controls.hardLimit} className="mt-1 size-4" onChange={(event) => setControls({ ...controls, hardLimit: event.target.checked })} type="checkbox" /><span><strong className="block font-medium">达到上限时停止执行</strong><small className="mt-1 block text-xs text-zinc-500">在调用 Provider 前拒绝预计会超限的操作。</small></span></label>
                  <label className="flex items-start gap-3 text-sm"><input checked={controls.overageEnabled} className="mt-1 size-4" onChange={(event) => setControls({ ...controls, overageEnabled: event.target.checked })} type="checkbox" /><span><strong className="block font-medium">允许超额用量</strong><small className="mt-1 block text-xs text-zinc-500">仅在套餐和支付状态同时允许时生效。</small></span></label>
                  <div className="flex items-center justify-between gap-3 border-t pt-4">
                    <p className="text-xs text-zinc-500">阈值提醒：{usage.controls.alertThresholds.join('%、')}%</p>
                    <Button disabled={saving} type="submit">{saving ? <Loader2 className="animate-spin" /> : <Save />}{saved ? '已保存' : '保存成本控制'}</Button>
                  </div>
                </form>
              ) : <div className="mt-4 rounded-lg border bg-white p-5 text-sm text-zinc-600">只有 Workspace Owner 或 Billing 可以修改成本控制。</div>}
            </div>

            <aside>
              <h2 className="text-lg font-semibold">用量提醒</h2>
              <div className="mt-4 overflow-hidden rounded-lg border bg-white">
                {alerts.length ? alerts.map((alert) => (
                  <div className="flex gap-3 border-b p-4 last:border-b-0" key={alert.id}>
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <div><p className="text-sm font-medium">{alert.thresholdPercent}% {metricLabel(alert.metric)} 阈值</p><p className="mt-1 text-xs text-zinc-500">{formatDateTime(alert.createdAt)}</p><Badge className="mt-2" variant="secondary">{alert.status}</Badge></div>
                  </div>
                )) : <p className="p-5 text-sm text-zinc-500">当前周期没有触发提醒。</p>}
              </div>
            </aside>
          </section>
        </div>
      ) : null}
    </WorkspaceAppShell>
  )
}

const EMPTY_CONTROLS: CostControlForm = {
  monthlyCreditLimit: '', monthlyProviderCost: '', hardLimit: true, overageEnabled: false,
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-white p-4"><p className="text-xs text-zinc-500">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>
}

function DataPoint({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4 text-sm md:block md:text-right"><span className="text-xs text-zinc-500 md:hidden">{label}</span><span>{value}</span></div>
}

function LoadingState() {
  return <div className="grid min-h-72 place-items-center text-sm text-zinc-500"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在加载用量</span></div>
}

function meterLabel(meter: string): string {
  return ({
    'llm.input_tokens': '模型输入', 'llm.output_tokens': '模型输出',
    'embedding.tokens': 'Embedding', 'stt.seconds': '语音识别',
    'tts.characters': '语音合成', 'tool.calls': 'Tool 调用',
    'rag.retrievals': 'RAG 检索', 'storage.bytes': '存储',
    'hosted.messages': '托管消息', 'api.requests': 'API 请求',
  })[meter] ?? meter
}

function metricLabel(metric: string): string {
  return metric === 'provider_cost_micros' ? 'Provider 成本' : 'Credits'
}

function nullableNumber(value: number | null): string {
  return value === null ? '' : String(value)
}

function parseOptionalInteger(value: string, label: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}必须是非负整数。`)
  return parsed
}

function parseOptionalMoneyMicros(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Provider 成本上限必须是非负金额。')
  return Math.round(parsed * 1_000_000)
}

function formatProviderCost(micros: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(micros / 1_000_000)
}

function formatPeriod(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' })
  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function loadUsagePageData(): Promise<[
  BillingUsageSummary,
  BillingSummary,
  BillingCostAlert[],
]> {
  return Promise.all([getBillingUsage(), getBillingSummary(), listBillingCostAlerts()])
}

function controlsFromUsage(usage: BillingUsageSummary): CostControlForm {
  return {
    monthlyCreditLimit: nullableNumber(usage.controls.monthlyCreditLimit),
    monthlyProviderCost: nullableNumber(
      usage.controls.monthlyProviderCostMicrosLimit === null
        ? null
        : usage.controls.monthlyProviderCostMicrosLimit / 1_000_000,
    ),
    hardLimit: usage.controls.hardLimit,
    overageEnabled: usage.controls.overageEnabled,
  }
}
