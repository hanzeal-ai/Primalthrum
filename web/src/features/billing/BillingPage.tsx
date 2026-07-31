import { AlertCircle, ArrowUpRight, Check, CreditCard, Loader2, ReceiptText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  cancelBillingSubscription,
  changeBillingSubscription,
  createBillingCheckout,
  createBillingPortal,
  getBillingSummary,
  listPublicPlans,
} from '../../api/client'
import type { AuthUser, BillingSummary, PublicPlanRecord } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { canManageBilling } from '../../lib/workspacePermissions'
import { WorkspaceAppShell } from '../app-shell/WorkspaceAppShell'

interface BillingPageProps {
  navigate?: (url: string) => void
  onLogout: () => Promise<void>
  user: AuthUser
}

export function BillingPage({
  navigate = (url) => window.location.assign(url),
  onLogout,
  user,
}: BillingPageProps) {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [plans, setPlans] = useState<PublicPlanRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const canManage = canManageBilling(user.role)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [nextSummary, nextPlans] = await loadBillingPageData()
      setSummary(nextSummary)
      setPlans(nextPlans.filter((plan) => plan.status === 'active'))
    } catch (reason) {
      setError(errorMessage(reason, '无法加载账单信息。'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void loadBillingPageData()
      .then(([nextSummary, nextPlans]) => {
        if (!active) return
        setSummary(nextSummary)
        setPlans(nextPlans.filter((plan) => plan.status === 'active'))
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, '无法加载账单信息。'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const currentPlan = useMemo(
    () => plans.find((plan) => plan.key === summary?.entitlementSnapshot.planKey),
    [plans, summary],
  )

  async function choosePlan(plan: PublicPlanRecord) {
    if (!summary || plan.key === currentPlan?.key || plan.monthlyPriceMinor <= 0) return
    setAction(`plan:${plan.key}`)
    setError('')
    try {
      if (summary.subscription.providerSubscriptionRef) {
        await changeBillingSubscription(plan.key)
        await load()
      } else {
        const checkout = await createBillingCheckout(plan.key)
        navigate(checkout.checkoutUrl)
      }
    } catch (reason) {
      setError(errorMessage(reason, '无法更新套餐。'))
    } finally {
      setAction('')
    }
  }

  async function openPortal() {
    setAction('portal')
    setError('')
    try {
      const session = await createBillingPortal()
      navigate(session.url)
    } catch (reason) {
      setError(errorMessage(reason, '无法打开支付管理。'))
    } finally {
      setAction('')
    }
  }

  async function cancelSubscription() {
    setAction('cancel')
    setError('')
    try {
      await cancelBillingSubscription()
      setConfirmCancel(false)
      await load()
    } catch (reason) {
      setError(errorMessage(reason, '无法取消订阅。'))
    } finally {
      setAction('')
    }
  }

  return (
    <WorkspaceAppShell
      active="billing"
      description="套餐、订阅、支付方式与发票"
      onLogout={onLogout}
      title="账单与套餐"
      user={user}
    >
      {checkoutNotice()}
      {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}
      {loading ? <LoadingState /> : summary ? (
        <div className="grid gap-8">
          <section aria-labelledby="billing-overview-title">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-blue-700">当前订阅</p>
                <h2 className="mt-1 text-2xl font-semibold" id="billing-overview-title">
                  {currentPlan?.name ?? summary.entitlementSnapshot.planKey}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">{subscriptionDescription(summary)}</p>
              </div>
              <Badge variant={subscriptionVariant(summary.subscription.state)}>
                {subscriptionStateLabel(summary.subscription.state)}
              </Badge>
            </div>
            <div className="mt-5 grid gap-px overflow-hidden rounded-lg border bg-zinc-200 sm:grid-cols-3">
              <Metric label="可用 credits" value={summary.creditAccount.availableCredits.toLocaleString()} />
              <Metric label="已预留" value={summary.creditAccount.reservedCredits.toLocaleString()} />
              <Metric label="累计已用" value={summary.creditAccount.spentCredits.toLocaleString()} />
            </div>
          </section>

          <section aria-labelledby="plans-title">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold" id="plans-title">选择套餐</h2>
                <p className="mt-1 text-sm text-zinc-500">套餐权益与 credits 由服务端目录统一管理。</p>
              </div>
              {!canManage ? <p className="text-xs text-zinc-500">只有 Workspace Owner 或 Billing 可以管理订阅。</p> : null}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan) => {
                const current = plan.key === currentPlan?.key
                const contactSales = plan.monthlyPriceMinor <= 0 && plan.key !== 'free'
                return (
                  <article className={`rounded-lg border bg-white p-5 ${current ? 'border-blue-500 ring-1 ring-blue-500' : ''}`} key={plan.key}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">{plan.name}</h3>
                        <p className="mt-1 text-sm text-zinc-500">{plan.monthlyCreditGrant.toLocaleString()} credits / 月</p>
                      </div>
                      {current ? <Badge variant="success"><Check />当前套餐</Badge> : null}
                    </div>
                    <p className="mt-5 text-2xl font-semibold">{planPrice(plan)}</p>
                    <p className="mt-1 text-xs text-zinc-500">{plan.overageEnabled ? '支持超额用量' : '达到额度后停止计费操作'}</p>
                    {canManage && !current ? contactSales ? (
                      <Button asChild className="mt-5 w-full" variant="outline"><a href="/contact">联系销售</a></Button>
                    ) : plan.monthlyPriceMinor > 0 ? (
                      <Button className="mt-5 w-full" disabled={Boolean(action)} onClick={() => void choosePlan(plan)}>
                        {action === `plan:${plan.key}` ? <Loader2 className="animate-spin" /> : null}
                        {currentPlan?.key === 'free' ? `升级到 ${plan.name}` : `切换到 ${plan.name}`}
                      </Button>
                    ) : null : null}
                  </article>
                )
              })}
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]" aria-labelledby="invoices-title">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold" id="invoices-title">发票</h2>
              <div className="mt-4 overflow-hidden rounded-lg border bg-white">
                {summary.invoices.length ? summary.invoices.map((invoice) => (
                  <div className="grid gap-3 border-b p-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center" key={invoice.id}>
                    <div className="flex min-w-0 items-center gap-3">
                      <ReceiptText className="size-4 shrink-0 text-zinc-400" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{invoice.providerInvoiceRef}</p>
                        <p className="mt-1 text-xs text-zinc-500">{formatDate(invoice.createdAt)}</p>
                      </div>
                    </div>
                    <p className="text-sm font-medium">{formatMoney(invoice.amountDueMinor, invoice.currency)}</p>
                    {invoice.hostedInvoiceUrl ? (
                      <a className="inline-flex items-center gap-1 text-sm font-medium text-blue-700" href={invoice.hostedInvoiceUrl} rel="noreferrer" target="_blank">
                        查看<ArrowUpRight className="size-3.5" />
                      </a>
                    ) : <Badge variant="secondary">{invoice.status}</Badge>}
                  </div>
                )) : <EmptyState text="还没有发票。付费成功后，发票会出现在这里。" />}
              </div>
            </div>

            <aside className="rounded-lg border bg-white p-5">
              <div className="flex items-center gap-2"><CreditCard className="size-4" /><h2 className="font-semibold">支付管理</h2></div>
              <p className="mt-2 text-sm leading-6 text-zinc-500">支付卡信息由托管支付页面处理，Primalthrum 不保存卡号。</p>
              {canManage && summary.subscription.providerCustomerRef ? (
                <Button className="mt-5 w-full" disabled={Boolean(action)} onClick={() => void openPortal()} variant="outline">
                  {action === 'portal' ? <Loader2 className="animate-spin" /> : null}管理支付方式
                </Button>
              ) : null}
              {canManage && summary.subscription.providerSubscriptionRef && !summary.subscription.cancelAtPeriodEnd ? (
                confirmCancel ? (
                  <div className="mt-4 border-t pt-4">
                    <p className="text-xs leading-5 text-zinc-600">当前权益将保留到本计费周期结束。</p>
                    <Button className="mt-3 w-full" disabled={Boolean(action)} onClick={() => void cancelSubscription()} variant="destructive">
                      {action === 'cancel' ? <Loader2 className="animate-spin" /> : null}确认在周期末取消
                    </Button>
                    <Button className="mt-2 w-full" onClick={() => setConfirmCancel(false)} variant="ghost">返回</Button>
                  </div>
                ) : <Button className="mt-2 w-full" onClick={() => setConfirmCancel(true)} variant="ghost">取消订阅</Button>
              ) : null}
            </aside>
          </section>
        </div>
      ) : null}
    </WorkspaceAppShell>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-white p-4"><p className="text-xs text-zinc-500">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>
}

function LoadingState() {
  return <div className="grid min-h-72 place-items-center text-sm text-zinc-500"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在加载账单信息</span></div>
}

function EmptyState({ text }: { text: string }) {
  return <p className="p-6 text-sm text-zinc-500">{text}</p>
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="mb-5 flex items-center justify-between gap-4 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert"><span className="flex items-center gap-2"><AlertCircle className="size-4" />{message}</span><Button onClick={onRetry} size="sm" variant="outline">重试</Button></div>
}

function checkoutNotice() {
  const state = new URLSearchParams(window.location.search).get('checkout')
  if (state === 'success') return <div className="mb-5 border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">支付已提交，套餐将在支付回调确认后自动更新。</div>
  if (state === 'canceled') return <div className="mb-5 border border-zinc-200 bg-white p-4 text-sm text-zinc-600">Checkout 已取消，当前套餐没有变化。</div>
  return null
}

function subscriptionDescription(summary: BillingSummary): string {
  if (summary.subscription.trialEndsAt) return `试用至 ${formatDate(summary.subscription.trialEndsAt)}`
  if (summary.subscription.cancelAtPeriodEnd && summary.subscription.periodEndsAt) return `将在 ${formatDate(summary.subscription.periodEndsAt)} 结束`
  if (summary.subscription.periodEndsAt) return `当前周期至 ${formatDate(summary.subscription.periodEndsAt)}`
  return '当前套餐持续有效'
}

function subscriptionStateLabel(state: BillingSummary['subscription']['state']): string {
  return ({
    active: '正常', trialing: '试用中', past_due: '待付款', restricted: '受限',
    cancel_at_period_end: '待取消', canceled: '已取消', refunded: '已退款',
  })[state]
}

function subscriptionVariant(state: BillingSummary['subscription']['state']): 'success' | 'secondary' | 'destructive' {
  if (state === 'active' || state === 'trialing') return 'success'
  if (state === 'past_due' || state === 'restricted') return 'destructive'
  return 'secondary'
}

function planPrice(plan: PublicPlanRecord): string {
  if (plan.monthlyPriceMinor <= 0) return plan.key === 'free' ? '免费' : '联系销售'
  return `${formatMoney(plan.monthlyPriceMinor, plan.currency)} / 月`
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency.toUpperCase() }).format(amountMinor / 100)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function loadBillingPageData(): Promise<[BillingSummary, PublicPlanRecord[]]> {
  return Promise.all([getBillingSummary(), listPublicPlans()])
}
