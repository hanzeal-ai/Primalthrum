import { ArrowRight, ArrowUp, AudioLines, Blocks, Database, FileSearch, ShieldCheck, Wrench } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { MarketingShell } from './MarketingShell'
import { usePrivacyConsent } from '../privacy/usePrivacyConsent'

const CAPABILITIES = [
  { icon: Blocks, title: '模型可替换', body: '按 Workspace 配置 LLM、Embedding、STT 与 TTS，运行时解析密钥。' },
  { icon: FileSearch, title: 'RAG 可选', body: '不开启、使用内置索引，或接入目标向量库，均由 Agent 独立配置。' },
  { icon: Wrench, title: 'Tool 与 Skill', body: '通过注册表启停能力，危险调用保留审批和审计证据。' },
  { icon: Database, title: 'Memory 与 Cache', body: '会话、长期记忆和缓存分别治理，支持后续替换存储实现。' },
  { icon: AudioLines, title: '文字与语音', body: '创建器和生成后的 Agent 都提供同一套文字、录音与朗读体验。' },
  { icon: ShieldCheck, title: '商业级治理', body: '多租户权限、版本发布、额度结算、成本上限和用量证据内置。' },
]

export function PublicHomePage({ authenticated = false }: { authenticated?: boolean }) {
  const [prompt, setPrompt] = useState('')
  const privacy = usePrivacyConsent()

  function startBuilding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const description = prompt.trim()
    if (!description) return
    void privacy.track('agent_intent_started', { source: 'home', authenticated })
    window.sessionStorage.setItem('primalthrum.pending-agent-prompt', description)
    window.location.assign(authenticated ? '/app' : '/signup?plan=pro')
  }

  return (
    <MarketingShell authenticated={authenticated}>
      <main>
        <section className="marketing-hero" id="product">
          <img
            alt="Primalthrum Agent 对话创建器产品界面"
            className="marketing-hero-image"
            src="/product-builder.jpg"
          />
          <div className="marketing-hero-overlay" />
          <div className="relative mx-auto flex h-full w-full max-w-7xl flex-col justify-center px-4 pb-28 pt-16 sm:px-6 lg:px-8">
            <p className="mb-4 text-sm font-medium text-blue-700">可发布的 Agent 工作台</p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] sm:text-6xl lg:text-7xl">Primalthrum</h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-700 sm:text-xl">
              直接描述你要的 Agent。平台通过对话完成模型、知识库、工具和记忆配置，并生成可立即打开使用的独立页面。
            </p>
            <form className="mt-8 flex w-full max-w-2xl items-center gap-2 border border-zinc-300 bg-white p-2 shadow-xl shadow-zinc-950/10" onSubmit={startBuilding}>
              <Input
                aria-label="描述你想创建的 Agent"
                className="h-12 flex-1 border-0 bg-transparent px-3 shadow-none focus-visible:ring-0"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="例如：创建一个能引用公司资料回答售前问题的 Agent"
                value={prompt}
              />
              <Button aria-label="开始创建" className="size-11 shrink-0 p-0" title="开始创建" type="submit">
                <ArrowUp />
              </Button>
            </form>
            <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-600">
              <span>7 天 Pro 试用</span><span>无需信用卡</span><span>随时切换模型与 RAG</span>
            </div>
          </div>
        </section>

        <section className="border-y border-zinc-200 bg-zinc-950 py-8 text-white">
          <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-6 px-4 text-center sm:px-6 md:grid-cols-4 lg:px-8">
            <Metric value="10+" label="核心用量计量项" />
            <Metric value="6" label="Workspace 权限角色" />
            <Metric value="3" label="发布环境与版本状态" />
            <Metric value="1" label="统一流式运行接口" />
          </div>
        </section>

        <section className="py-20" id="platform">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-blue-700">完整 Agent 运行层</p>
              <h2 className="mt-3 text-3xl font-semibold sm:text-4xl">每项能力都能选择、替换和审计</h2>
              <p className="mt-4 text-zinc-600">不是一次性 Demo 生成器。每个 Agent 都保留配置、源码、版本、运行和成本证据。</p>
            </div>
            <div className="mt-12 grid border-l border-t border-zinc-200 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(({ icon: Icon, title, body }) => (
                <article className="min-h-48 border-b border-r border-zinc-200 p-6" key={title}>
                  <Icon className="size-5 text-blue-700" />
                  <h3 className="mt-8 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-zinc-200 bg-zinc-50 py-20">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-8 px-4 sm:px-6 md:flex-row md:items-center lg:px-8">
            <div>
              <h2 className="text-3xl font-semibold">先创建一个真正能运行的 Agent</h2>
              <p className="mt-3 text-zinc-600">从 Pro 试用开始，配置和源码都属于你的 Workspace。</p>
            </div>
            <Button asChild className="h-11 px-6" size="lg">
              <a href="/signup?plan=pro">开始免费试用 <ArrowRight /></a>
            </Button>
          </div>
        </section>
      </main>
    </MarketingShell>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div><div className="text-2xl font-semibold">{value}</div><div className="mt-1 text-xs text-zinc-400">{label}</div></div>
}
