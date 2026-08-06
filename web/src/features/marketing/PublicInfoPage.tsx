import { Activity, BookOpen, LockKeyhole, Mail } from 'lucide-react'

import { MarketingShell } from './MarketingShell'

const CONTENT: Record<string, { title: string; summary: string; sections: Array<{ title: string; body: string }> }> = {
  security: {
    title: '安全与信任', summary: '以租户隔离、最小权限和可核对证据约束 Agent 的每次运行。',
    sections: [
      { title: 'Workspace 隔离', body: 'Agent、文档、Provider 配置、运行、计费和团队成员都以服务端 Workspace 范围查询。' },
      { title: '密钥保护', body: 'Provider 密钥写入本地加密 Secret Vault，API 和界面只返回脱敏引用。' },
      { title: '运行审计', body: '工具调用、版本发布、用量计价、额度结算和支付事件保留持久化证据。' },
    ],
  },
  docs: {
    title: '产品文档', summary: '从创建 Agent 到发布、计费和运行治理的操作入口。',
    sections: [
      { title: '创建', body: '在工作台描述目标，依次选择模型、RAG、Embedding 和资料；平台会生成源码与配置。' },
      { title: '验证与发布', body: '创建后直接打开 Preview，通过版本面板发布到独立 Agent 页面，并可回滚历史版本。' },
      { title: '配置能力', body: 'Provider 与能力设置按 Workspace 保存；LLM、Embedding、STT、TTS 和 RAG 可以独立切换。' },
    ],
  },
  contact: {
    title: '联系团队', summary: '企业采购、私有化部署和产品支持通过邮件进入人工处理。',
    sections: [{ title: '商务与支持', body: '发送邮件至 hello@primalthrum.ai，并注明团队规模、目标场景和部署要求。' }],
  },
  status: {
    title: '服务状态', summary: '本页面展示当前产品版本的公开运行边界。',
    sections: [{ title: '当前环境', body: 'Web、Node API 与 Python Agent 提供独立健康检查；生产状态页和外部探测将在部署阶段接入。' }],
  },
  'legal/privacy': {
    title: '隐私说明', summary: '说明当前产品如何处理 Workspace 数据与 Provider 凭据。',
    sections: [
      { title: '数据处理', body: 'Agent 配置、对话、文档、运行和计费证据仅用于提供产品功能。Provider 凭据由服务端 Secret Vault 保存。' },
      { title: '产品分析', body: '产品分析默认关闭。只有明确授权后，平台才以匿名标识记录页面和注册漏斗；不会记录邮箱、提示词、文档或 Agent 对话内容。' },
      { title: '你的选择', body: '你可以通过页脚撤回产品分析，并在设置中导出账号数据；Workspace Owner 可导出租户数据。账号删除提供宽限期，并受共享所有权和有效订阅约束。' },
      { title: '保留与删除', body: '账号删除会清除客户内容和凭据，同时以匿名形式保留税务、计费、反欺诈和安全证据。具体法定期限、处理者信息和地区条款必须在公开上线前完成法务审核。' },
    ],
  },
  'legal/terms': {
    title: '服务条款', summary: '商业使用、付费、可接受使用和责任边界的发布前版本。',
    sections: [{ title: '发布状态', body: '当前条款为产品占位说明，不构成最终商业合同。正式收款前必须完成法务审核并固定版本与生效日期。' }],
  },
}

const ICONS: Record<string, typeof LockKeyhole> = { security: LockKeyhole, docs: BookOpen, contact: Mail, status: Activity }

export function PublicInfoPage({ authenticated = false, slug }: { authenticated?: boolean; slug: string }) {
  const content = CONTENT[slug] ?? CONTENT.docs
  const Icon = ICONS[slug] ?? BookOpen
  return (
    <MarketingShell authenticated={authenticated}>
      <main className="mx-auto min-h-[calc(100vh-64px)] w-full max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
        <Icon className="size-7 text-blue-700" />
        <h1 className="mt-6 text-4xl font-semibold sm:text-5xl">{content.title}</h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-600">{content.summary}</p>
        <div className="mt-12 divide-y divide-zinc-200 border-y border-zinc-200">
          {content.sections.map((section) => (
            <section className="grid gap-3 py-8 sm:grid-cols-[180px_1fr] sm:gap-8" key={section.title}>
              <h2 className="font-semibold">{section.title}</h2>
              <p className="leading-7 text-zinc-600">{section.body}</p>
            </section>
          ))}
        </div>
      </main>
    </MarketingShell>
  )
}
