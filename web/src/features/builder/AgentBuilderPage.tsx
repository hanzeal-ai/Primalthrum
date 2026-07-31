import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Database,
  FileText,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  RotateCcw,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  createAgent,
  createDocument,
  generateAgentProject,
  indexDocument,
  listProviderConfigs,
} from '../../api/client'
import type { AgentRecord, AuthUser, ProviderConfigRecord } from '../../api/types'
import { ChatComposer } from '../../components/chat/ChatComposer'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { WorkspaceSwitcher } from '../workspaces/WorkspaceSwitcher'
import { ProviderSettingsPanel } from '../providers/ProviderSettingsPanel'

type BuilderStage = 'describe' | 'model' | 'rag' | 'knowledge' | 'review' | 'creating' | 'created'

interface BuilderMessage {
  id: string
  role: 'assistant' | 'user' | 'system'
  content: string
}

interface DraftFile {
  name: string
  content: string
}

interface ModelChoice {
  label: string
  provider: string
  model: string
  providerConfigId?: number
}

interface BuilderDraft {
  stage: BuilderStage
  description: string
  model: ModelChoice | null
  ragProvider: 'none' | 'in-memory' | null
  files: DraftFile[]
  messages: BuilderMessage[]
  createdAgent: AgentRecord | null
}

interface AgentBuilderPageProps {
  user: AuthUser
  onLogout: () => Promise<void>
}

const STORAGE_KEY_PREFIX = 'primalthrum.builder-draft.v3'

const INITIAL_DRAFT: BuilderDraft = {
  stage: 'describe',
  description: '',
  model: null,
  ragProvider: null,
  files: [],
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content: '告诉我你希望这个 Agent 完成什么工作？你可以直接输入，也可以点击麦克风描述。',
    },
  ],
  createdAgent: null,
}

export function AgentBuilderPage({ user, onLogout }: AgentBuilderPageProps) {
  const [draft, setDraft] = useState<BuilderDraft>(() => loadDraft(user.workspaceId))
  const [input, setInput] = useState('')
  const [providers, setProviders] = useState<ProviderConfigRecord[]>([])
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.localStorage.setItem(storageKey(user.workspaceId), JSON.stringify(draft))
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [draft, user.workspaceId])

  useEffect(() => {
    void listProviderConfigs()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  const modelChoices = useMemo(() => configuredModels(providers), [providers])
  const completion = stageProgress(draft.stage)
  const agentName = inferAgentName(draft.description)

  function submitDescription() {
    const content = input.trim()
    if (!content) return

    setDraft((current) => ({
      ...current,
      description: content,
      stage: 'model',
      messages: [
        ...current.messages,
        message('user', content),
        message('assistant', `我理解了。接下来为“${inferAgentName(content)}”选择主要模型。`),
      ],
    }))
    setInput('')
  }

  function submitMessage() {
    const content = input.trim()
    if (!content) return

    if (draft.stage === 'describe') {
      submitDescription()
      return
    }

    if (draft.stage === 'knowledge') {
      setDraft((current) => ({
        ...current,
        description: `${current.description}\n\n补充要求：${content}`,
        messages: [
          ...current.messages,
          message('user', content),
          message('assistant', '补充要求已记录。你可以继续上传资料，或者进入配置确认。'),
        ],
      }))
      setInput('')
    }
  }

  function chooseModel(choice: ModelChoice) {
    setDraft((current) => ({
      ...current,
      model: choice,
      stage: 'rag',
      messages: [
        ...current.messages,
        message('user', `使用 ${choice.label}`),
        message('assistant', '是否需要让它从你的私有资料中检索并引用内容？'),
      ],
    }))
  }

  function chooseRag(ragProvider: 'none' | 'in-memory') {
    setDraft((current) => ({
      ...current,
      ragProvider,
      stage: 'knowledge',
      messages: [
        ...current.messages,
        message('user', ragProvider === 'none' ? '暂时不启用知识库' : '启用内置向量知识库'),
        message(
          'assistant',
          ragProvider === 'none'
            ? '好的。你仍然可以上传示例资料，或者直接跳过。'
            : '知识库已启用。上传 TXT、Markdown、JSON 或 CSV 资料，也可以暂时跳过。',
        ),
      ],
    }))
  }

  async function addFiles(files: File[]) {
    setError('')
    try {
      const loaded = await Promise.all(files.map(async (file) => ({
        name: file.name,
        content: await file.text(),
      })))
      setDraft((current) => ({
        ...current,
        files: [...current.files, ...loaded],
        messages: [
          ...current.messages,
          message('user', `已上传 ${loaded.map((file) => file.name).join('、')}`),
          message('assistant', '资料已加入草稿。确认配置后，我会创建 Agent 并完成索引。'),
        ],
      }))
    } catch (fileError) {
      setError(errorMessage(fileError, '读取文件失败。'))
    }
  }

  function continueToReview() {
    setDraft((current) => ({
      ...current,
      stage: 'review',
      messages: [
        ...current.messages,
        message('user', current.files.length ? '使用这些资料继续' : '暂时跳过文件'),
        message('assistant', '配置已准备好。确认后我会创建、生成并验证这个 Agent。'),
      ],
    }))
  }

  async function createConfiguredAgent() {
    if (!draft.model || !draft.ragProvider) return
    setError('')
    setDraft((current) => ({
      ...current,
      stage: 'creating',
      messages: [...current.messages, message('system', '正在创建 Agent 基础结构...')],
    }))

    try {
      const created = await createAgent({
        name: agentName,
        description: draft.description,
        memoryProvider: 'sqlite',
        cacheProvider: 'memory',
        ragProvider: draft.ragProvider,
        enabledTools: ['file_reader'],
        enabledSkills: ['research'],
        modelConfig: {
          default: {
            provider: draft.model.provider,
            model: draft.model.model,
            providerConfigId: draft.model.providerConfigId,
          },
          embedding: { provider: 'mock', model: 'mock-embedding' },
        },
      })

      for (const file of draft.files) {
        const document = await createDocument(created.id, {
          filename: file.name,
          content: file.content,
          collection: 'default',
        })
        await indexDocument(created.id, document.id)
      }

      await generateAgentProject(created.id)
      const readyAgent: AgentRecord = { ...created, status: 'generated' }
      setDraft((current) => ({
        ...current,
        stage: 'created',
        createdAgent: readyAgent,
        messages: [
          ...current.messages.filter((item) => item.role !== 'system'),
          message('system', 'Agent 基础结构、配置和资料索引已完成。'),
          message('assistant', `“${readyAgent.name}”已经创建完成，可以直接打开网页使用。`),
        ],
      }))
    } catch (createError) {
      setError(errorMessage(createError, '创建 Agent 失败。'))
      setDraft((current) => ({ ...current, stage: 'review' }))
    }
  }

  function resetDraft() {
    window.localStorage.removeItem(storageKey(user.workspaceId))
    setDraft(INITIAL_DRAFT)
    setInput('')
    setError('')
  }

  return (
    <main className="builder-shell">
      <NavigationRail
        onLogout={onLogout}
        onOpenProviderSettings={() => setProviderSettingsOpen(true)}
        onReset={resetDraft}
        user={user}
      />

      <section className="builder-conversation">
        <header className="builder-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold">创建我的 Agent</h1>
              <span className="size-2 rounded-full bg-emerald-500" />
            </div>
            <p className="mt-1 text-xs text-zinc-500">通过对话完成配置，不需要填写复杂表单</p>
          </div>
          <div className="flex items-center gap-1">
            <WorkspaceSwitcher user={user} />
            {canManageProviders(user.role) ? (
              <Button
                aria-label="Provider 设置"
                className="md:hidden"
                onClick={() => setProviderSettingsOpen(true)}
                size="icon"
                title="Provider 设置"
                variant="ghost"
              >
                <Settings />
              </Button>
            ) : null}
            <Button className="md:hidden" onClick={resetDraft} size="icon" variant="ghost" title="重新创建">
              <RotateCcw />
            </Button>
          </div>
        </header>

        <div className="builder-message-list">
          <div className="mx-auto w-full max-w-3xl space-y-6">
            {draft.messages.map((item) => <ConversationMessage key={item.id} message={item} />)}

            {draft.stage === 'model' ? (
              <ChoiceBlock title="选择主要模型">
                {modelChoices.map((choice) => (
                  <ChoiceButton key={`${choice.provider}:${choice.model}`} onClick={() => chooseModel(choice)}>
                    <span>
                      <strong>{choice.label}</strong>
                      <small>{choice.provider} / {choice.model}</small>
                    </span>
                    <ChevronRight />
                  </ChoiceButton>
                ))}
              </ChoiceBlock>
            ) : null}

            {draft.stage === 'rag' ? (
              <ChoiceBlock title="选择知识库方式">
                <ChoiceButton onClick={() => chooseRag('in-memory')}>
                  <Database />
                  <span><strong>启用内置向量库</strong><small>适合当前工作区快速验证</small></span>
                  <ChevronRight />
                </ChoiceButton>
                <ChoiceButton onClick={() => chooseRag('none')}>
                  <span><strong>暂时跳过</strong><small>之后可以在 Agent 设置中启用</small></span>
                  <ChevronRight />
                </ChoiceButton>
              </ChoiceBlock>
            ) : null}

            {draft.stage === 'knowledge' ? (
              <div className="inline-panel">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium">资料</h2>
                    <p className="mt-1 text-xs text-zinc-500">上传会随 Agent 一起索引，也可以先跳过。</p>
                  </div>
                  <Button onClick={continueToReview} size="sm" variant="outline">
                    {draft.files.length ? '使用资料继续' : '暂时跳过'}
                    <ChevronRight />
                  </Button>
                </div>
                {draft.files.length ? (
                  <div className="mt-4 grid gap-2">
                    {draft.files.map((file) => (
                      <div className="flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm" key={file.name}>
                        <FileText className="size-4 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <Check className="size-4 text-emerald-600" />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {draft.stage === 'review' ? (
              <div className="inline-panel">
                <h2 className="text-sm font-medium">确认 Agent 配置</h2>
                <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <SummaryItem label="名称" value={agentName} />
                  <SummaryItem label="模型" value={draft.model?.label ?? '未选择'} />
                  <SummaryItem label="记忆" value="SQLite 长期记忆" />
                  <SummaryItem label="知识库" value={ragLabel(draft.ragProvider)} />
                  <SummaryItem label="工具" value="文件读取" />
                  <SummaryItem label="资料" value={`${draft.files.length} 个文件`} />
                </div>
                <Button className="mt-5" onClick={() => void createConfiguredAgent()}>
                  <Sparkles />
                  创建 Agent
                </Button>
              </div>
            ) : null}

            {draft.stage === 'creating' ? (
              <div className="inline-panel flex items-center gap-3 text-sm">
                <Loader2 className="size-4 animate-spin" />
                正在生成运行图、配置和知识索引
              </div>
            ) : null}

            {draft.stage === 'created' && draft.createdAgent ? (
              <div className="inline-panel border-emerald-200 bg-emerald-50/60">
                <div className="flex items-start gap-3">
                  <div className="grid size-9 place-items-center rounded-md bg-emerald-600 text-white"><Check /></div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-medium">{draft.createdAgent.name}</h2>
                    <p className="mt-1 text-sm text-zinc-600">独立源码和网页入口已生成，可以直接开始对话。</p>
                  </div>
                </div>
                <Button
                  className="mt-5"
                  onClick={() => window.location.assign(`/a/${draft.createdAgent?.slug}`)}
                >
                  打开 Agent
                </Button>
              </div>
            ) : null}

            {error ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
            <div ref={messageEndRef} />
          </div>
        </div>

        <div className="builder-composer-wrap">
          <div className="mx-auto w-full max-w-3xl">
            <ChatComposer
              disabled={draft.stage !== 'describe' && draft.stage !== 'knowledge'}
              onChange={setInput}
              onFiles={draft.stage === 'knowledge' ? (files) => void addFiles(files) : undefined}
              onSubmit={submitMessage}
              placeholder={draft.stage === 'describe'
                ? '描述你想创建的 Agent...'
                : draft.stage === 'knowledge'
                  ? '补充 Agent 要求，或上传资料...'
                  : '请完成当前对话中的选择'}
              value={input}
            />
            <p className="mt-2 text-center text-[11px] text-zinc-400">Primalthrum 会在创建前展示最终配置</p>
          </div>
        </div>
      </section>

      <AgentStatusPanel agentName={agentName} completion={completion} draft={draft} />
      {providerSettingsOpen ? (
        <ProviderSettingsPanel
          onClose={() => setProviderSettingsOpen(false)}
          onProvidersChange={setProviders}
        />
      ) : null}
    </main>
  )
}

function NavigationRail({ user, onLogout, onOpenProviderSettings, onReset }: {
  user: AuthUser
  onLogout: () => Promise<void>
  onOpenProviderSettings: () => void
  onReset: () => void
}) {
  return (
    <aside className="builder-rail">
      <div className="grid size-9 place-items-center rounded-md bg-blue-600 text-white"><Sparkles /></div>
      <div className="mt-8 grid gap-2">
        <Button size="icon" title="新建 Agent" variant="outline" onClick={onReset}><Plus /></Button>
        <Button className="bg-blue-50 text-blue-700" size="icon" title="对话" variant="ghost"><MessageSquare /></Button>
        <Button size="icon" title="Agent" variant="ghost"><Bot /></Button>
        <Button size="icon" title="知识库" variant="ghost"><Database /></Button>
        {canManageProviders(user.role) ? (
          <Button aria-label="Provider 设置" onClick={onOpenProviderSettings} size="icon" title="Provider 设置" variant="ghost"><Settings /></Button>
        ) : null}
      </div>
      <div className="mt-auto grid gap-2">
        <div className="grid size-9 place-items-center rounded-full bg-zinc-200 text-xs font-semibold" title={user.email}>
          {user.email.slice(0, 2).toUpperCase()}
        </div>
        <Button onClick={() => void onLogout()} size="icon" title="退出登录" variant="ghost"><LogOut /></Button>
      </div>
    </aside>
  )
}

function ConversationMessage({ message: item }: { message: BuilderMessage }) {
  if (item.role === 'system') {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Check className="size-4 text-emerald-600" />
        {item.content}
      </div>
    )
  }

  return (
    <div className={`conversation-message ${item.role === 'user' ? 'conversation-message-user' : ''}`}>
      <div className={`conversation-avatar ${item.role === 'user' ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700'}`}>
        {item.role === 'user' ? '我' : <Bot />}
      </div>
      <p>{item.content}</p>
    </div>
  )
}

function ChoiceBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ml-12">
      <h2 className="mb-2 text-xs font-medium text-zinc-500">{title}</h2>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </div>
  )
}

function ChoiceButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="choice-button" onClick={onClick} type="button">
      {children}
    </button>
  )
}

function AgentStatusPanel({ agentName, completion, draft }: {
  agentName: string
  completion: number
  draft: BuilderDraft
}) {
  return (
    <aside className="builder-status">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Agent 状态</h2>
        <Badge variant={draft.stage === 'created' ? 'success' : 'secondary'}>
          {draft.stage === 'created' ? '已创建' : '配置中'}
        </Badge>
      </div>
      <div className="mt-6 flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-md bg-emerald-100 text-emerald-700"><Bot /></div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{agentName}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {draft.stage === 'describe' ? '等待描述' : draft.stage === 'created' ? '已可使用' : '正在准备'}
          </p>
        </div>
      </div>
      <div className="mt-6 space-y-4 border-y py-5 text-sm">
        <StatusLine icon={<Brain />} label="目标" value={draft.description ? '已理解' : '待描述'} />
        <StatusLine icon={<Sparkles />} label="模型" value={draft.model?.label ?? '待选择'} />
        <StatusLine icon={<Database />} label="知识库" value={ragLabel(draft.ragProvider)} />
        <StatusLine icon={<FileText />} label="资料" value={`${draft.files.length} 个`} />
      </div>
      <div className="mt-6">
        <div className="mb-2 flex justify-between text-xs"><span>配置完成</span><span>{completion}%</span></div>
        <Progress value={completion} />
      </div>
      <div className="mt-6 rounded-md bg-zinc-50 p-3 text-xs leading-5 text-zinc-500">
        选择会保存在当前浏览器。创建前可以重新开始，不会产生运行费用。
      </div>
    </aside>
  )
}

function StatusLine({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[18px_1fr_auto] items-center gap-2">
      <span className="text-zinc-400 [&_svg]:size-4">{icon}</span>
      <span className="text-zinc-500">{label}</span>
      <span className="max-w-28 truncate font-medium">{value}</span>
    </div>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return <div><span className="text-zinc-500">{label}</span><p className="mt-1 font-medium">{value}</p></div>
}

function configuredModels(providers: ProviderConfigRecord[]): ModelChoice[] {
  const choices = providers
    .filter((provider) => provider.type === 'llm')
    .map((provider) => {
      const providerName = String(provider.config.provider ?? 'mock')
      const modelName = String(provider.config.model ?? 'mock-chat')
      return {
        label: provider.name,
        provider: providerName,
        model: modelName,
        providerConfigId: provider.id,
      }
    })

  return choices.length ? choices : [{ label: 'Mock Chat（本地演示）', provider: 'mock', model: 'mock-chat' }]
}

function canManageProviders(role: string): boolean {
  return role === 'owner' || role === 'admin'
}

function loadDraft(workspaceId: number): BuilderDraft {
  try {
    const saved = window.localStorage.getItem(storageKey(workspaceId))
    return saved ? { ...INITIAL_DRAFT, ...JSON.parse(saved) as BuilderDraft } : INITIAL_DRAFT
  } catch {
    return INITIAL_DRAFT
  }
}

function storageKey(workspaceId: number): string {
  return `${STORAGE_KEY_PREFIX}.${workspaceId}`
}

function message(role: BuilderMessage['role'], content: string): BuilderMessage {
  return { id: crypto.randomUUID(), role, content }
}

function inferAgentName(description: string): string {
  const value = description.toLowerCase()
  if (value.includes('研究') || value.includes('research')) return '研究助手'
  if (value.includes('客服') || value.includes('support')) return '智能客服'
  if (value.includes('代码') || value.includes('开发') || value.includes('code')) return '研发助手'
  if (value.includes('合同') || value.includes('contract')) return '合同助手'
  return description ? '我的智能助手' : '未命名 Agent'
}

function ragLabel(value: BuilderDraft['ragProvider']): string {
  if (value === 'in-memory') return '内置向量库'
  if (value === 'none') return '未启用'
  return '待选择'
}

function stageProgress(stage: BuilderStage): number {
  return { describe: 10, model: 30, rag: 50, knowledge: 70, review: 90, creating: 95, created: 100 }[stage]
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
