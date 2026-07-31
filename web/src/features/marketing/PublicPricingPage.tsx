import { Check, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { listPublicPlans } from '../../api/client'
import type { PublicPlanRecord } from '../../api/types'
import { Button } from '../../components/ui/button'
import { MarketingShell } from './MarketingShell'
import { usePrivacyConsent } from '../privacy/usePrivacyConsent'

const FEATURE_LABELS: Record<string, string> = {
  'agents.create': 'Agent 创建',
  seats: '团队席位',
  rag: '可选 RAG',
  voice: '语音输入与朗读',
  api: 'API 访问',
  publishing: '独立页面发布',
  'source.export': '源码导出',
  audit: '审计记录',
  sso: '企业 SSO',
  'retention.controls': '数据保留策略',
  'private.deployment': '私有化部署',
}

export function PublicPricingPage({ authenticated = false }: { authenticated?: boolean }) {
  const [plans, setPlans] = useState<PublicPlanRecord[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void listPublicPlans().then(setPlans).catch((reason) => {
      setError(reason instanceof Error ? reason.message : '套餐加载失败')
    })
  }, [])

  return (
    <MarketingShell authenticated={authenticated}>
      <main className="mx-auto min-h-[calc(100vh-64px)] w-full max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-blue-700">透明套餐</p>
          <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">按团队阶段选择，不锁定模型</h1>
          <p className="mt-5 text-lg text-zinc-600">平台额度覆盖运行、语音、RAG 与存储。Provider 成本和平台 credits 都保留可核对证据。</p>
        </div>
        {error ? <p className="mt-10 border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p> : null}
        {!plans.length && !error ? <div className="mt-16 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" /> 正在加载套餐</div> : null}
        <div className="mt-12 grid gap-px overflow-hidden border border-zinc-200 bg-zinc-200 md:grid-cols-2 xl:grid-cols-5">
          {plans.map((plan) => <PlanColumn key={plan.key} plan={plan} />)}
        </div>
        <p className="mt-6 text-sm text-zinc-500">月费以美元计价；企业方案、超额用量和支付税费以最终合同及结账页为准。</p>
      </main>
    </MarketingShell>
  )
}

function PlanColumn({ plan }: { plan: PublicPlanRecord }) {
  const privacy = usePrivacyConsent()
  const isPro = plan.key === 'pro'
  const contactSales = plan.monthlyPriceMinor === 0 && plan.key !== 'free'
  const enabled = plan.entitlements.filter((item) => item.enabled).slice(0, 7)
  return (
    <article className={`flex min-h-[540px] flex-col bg-white p-5 ${isPro ? 'outline outline-2 -outline-offset-2 outline-blue-600' : ''}`}>
      <div className="flex h-7 items-center justify-between gap-2">
        <h2 className="font-semibold">{plan.name}</h2>
        {isPro ? <span className="bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">推荐</span> : null}
      </div>
      <div className="mt-7 min-h-16">
        {contactSales ? <span className="text-2xl font-semibold">定制</span> : <><span className="text-3xl font-semibold">${plan.monthlyPriceMinor / 100}</span><span className="text-sm text-zinc-500"> / 月</span></>}
      </div>
      <p className="text-sm text-zinc-600">{contactSales ? '按合同配置额度' : `${plan.monthlyCreditGrant.toLocaleString()} credits / 月`}</p>
      <Button asChild className="mt-6 w-full" variant={isPro ? 'default' : 'outline'}>
        <a href={planHref(plan)} onClick={() => void privacy.track('plan_selected', { planKey: plan.key, source: 'pricing' })}>{planCta(plan)}</a>
      </Button>
      <div className="my-6 h-px bg-zinc-200" />
      <ul className="grid gap-3 text-sm">
        {enabled.map((item) => (
          <li className="flex items-start gap-2" key={item.feature}>
            <Check className="mt-0.5 size-4 shrink-0 text-blue-700" />
            <span>{featureLabel(item.feature, item.quantityLimit)}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

function planHref(plan: PublicPlanRecord) {
  if (plan.key === 'free') return '/signup?plan=free'
  if (plan.key === 'pro') return '/signup?plan=pro'
  return `/contact?plan=${encodeURIComponent(plan.key)}`
}

function planCta(plan: PublicPlanRecord) {
  if (plan.key === 'free') return '免费开始'
  if (plan.key === 'pro') return `${plan.trialDays} 天免费试用`
  return '联系销售'
}

function featureLabel(feature: string, limit: number | null) {
  const label = FEATURE_LABELS[feature] ?? feature
  if (limit === null) return label
  return `${label} · ${limit}`
}
