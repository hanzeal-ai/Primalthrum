import {
  ArrowRight,
  BookOpen,
  Check,
  Circle,
  Code2,
  Database,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  Terminal,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  ApiError,
  clearStoredSessionToken,
  createAgent,
  createDocument,
  createProviderConfig,
  generateAgentProject,
  getCurrentSession,
  getSetupStatus,
  indexDocument,
  isUnauthorizedError,
  listAgents,
  listDocuments,
  listProviderConfigs,
  loginAdmin,
  logoutAdmin,
  setupAdmin,
  streamAgentRun,
} from './api/client'
import type {
  AgentRecord,
  AuthUser,
  DocumentRecord,
  ProviderConfigRecord,
  RunStatus,
  StreamPayload,
} from './api/types'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Progress } from './components/ui/progress'
import { Separator } from './components/ui/separator'
import { Textarea } from './components/ui/textarea'
import './App.css'

type AuthMode = 'checking' | 'setup' | 'login' | 'ready'
type StepId = 'provider' | 'agent' | 'knowledge' | 'run' | 'source'
type LoadState = 'idle' | 'loading' | 'error'

interface TimelineEvent extends StreamPayload {
  id: number
  event: string
  receivedAt: string
}

interface ProviderFormState {
  name: string
  type: string
  provider: string
  model: string
  secret: string
}

interface AgentFormState {
  name: string
  description: string
  memoryProvider: string
  cacheProvider: string
  ragProvider: string
  enabledTools: string
  enabledSkills: string
}

interface DocumentFormState {
  filename: string
  collection: string
  content: string
}

interface AuthFormState {
  email: string
  password: string
}

const STEPS: Array<{
  id: StepId
  title: string
  description: string
  icon: typeof Shield
}> = [
  {
    id: 'provider',
    title: 'Provider',
    description: '保存模型配置',
    icon: Shield,
  },
  {
    id: 'agent',
    title: 'Agent',
    description: '创建研发 Agent',
    icon: Database,
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    description: '注册并索引资料',
    icon: BookOpen,
  },
  {
    id: 'run',
    title: 'Run',
    description: '流式运行验证',
    icon: Play,
  },
  {
    id: 'source',
    title: 'Source',
    description: '生成源码项目',
    icon: Code2,
  },
]

const DEFAULT_AUTH_FORM: AuthFormState = {
  email: 'admin@example.com',
  password: '',
}

const DEFAULT_PROVIDER_FORM: ProviderFormState = {
  name: 'openai-production',
  type: 'llm',
  provider: 'mock',
  model: 'mock-chat',
  secret: 'dev-secret-123456',
}

const DEFAULT_AGENT_FORM: AgentFormState = {
  name: 'Research Agent',
  description: 'Research assistant with memory, tools, skills, and optional RAG.',
  memoryProvider: 'sqlite',
  cacheProvider: 'memory',
  ragProvider: 'in-memory',
  enabledTools: 'file_reader, planner',
  enabledSkills: 'research, summarize',
}

const DEFAULT_DOCUMENT_FORM: DocumentFormState = {
  filename: 'research-brief.md',
  collection: 'research',
  content: [
    '# Research Brief',
    '',
    'Primalthrum helps operators create, configure, run, and export full Agent projects.',
    'The Agent should use evidence from this document when answering launch-readiness questions.',
  ].join('\n'),
}

const DEFAULT_RUN_GOAL = '请基于 Knowledge 里的资料，总结这个 Agent 是否已经可以用于演示。'

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code !== 'API_ERROR') {
    return `${error.message} [${error.code}]`
  }

  return error instanceof Error ? error.message : fallback
}

function statusLabel(status: RunStatus): string {
  if (status === 'running') return 'Running'
  if (status === 'done') return 'Complete'
  if (status === 'error') return 'Error'
  return 'Idle'
}

function sourceCommand(agent: AgentRecord | null): string {
  if (!agent || agent.status !== 'generated') {
    return '先完成第 5 步 Generate Source。'
  }

  return [
    `cd ${agent.path}`,
    '/Users/sanmws/Documents/Primalthrum/agent/.venv/bin/python -m src.main "验证这个 Agent 是否可用"',
  ].join('\n')
}

export default function App() {
  const [authMode, setAuthMode] = useState<AuthMode>('checking')
  const [authForm, setAuthForm] = useState<AuthFormState>(DEFAULT_AUTH_FORM)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authMessage, setAuthMessage] = useState('Checking session')
  const [activeStep, setActiveStep] = useState<StepId>('provider')
  const [providerForm, setProviderForm] = useState<ProviderFormState>(DEFAULT_PROVIDER_FORM)
  const [agentForm, setAgentForm] = useState<AgentFormState>(DEFAULT_AGENT_FORM)
  const [documentForm, setDocumentForm] = useState<DocumentFormState>(DEFAULT_DOCUMENT_FORM)
  const [runGoal, setRunGoal] = useState(DEFAULT_RUN_GOAL)
  const [providers, setProviders] = useState<ProviderConfigRecord[]>([])
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [message, setMessage] = useState('按步骤完成右侧流程。')
  const abortRef = useRef<AbortController | null>(null)
  const eventIdRef = useRef(1)

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const indexedDocuments = documents.filter((document) => document.indexStatus === 'indexed')
  const completedSteps = useMemo(() => ({
    provider: providers.length > 0,
    agent: agents.length > 0,
    knowledge: indexedDocuments.length > 0,
    run: events.some((event) => event.event === 'agent.run.completed' || event.status === 'done'),
    source: Boolean(selectedAgent && selectedAgent.status === 'generated'),
  }), [agents.length, events, indexedDocuments.length, providers.length, selectedAgent])
  const completedCount = Object.values(completedSteps).filter(Boolean).length
  const progress = (completedCount / STEPS.length) * 100

  useEffect(() => {
    void initializeAuth()
  }, [])

  useEffect(() => {
    if (authMode !== 'ready') return
    void refreshWorkspace()
    // Workspace refresh is intentionally triggered only when auth enters ready state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authMode])

  async function initializeAuth() {
    setAuthMode('checking')
    try {
      const setupStatus = await getSetupStatus()
      if (setupStatus.needsSetup) {
        setAuthMode('setup')
        setAuthMessage('创建第一个管理员账号。')
        return
      }

      const session = await getCurrentSession()
      setAuthUser(session.user)
      setAuthMode('ready')
      setAuthMessage(`已登录：${session.user.email}`)
    } catch (error) {
      clearStoredSessionToken()
      setAuthUser(null)
      setAuthMode('login')
      setAuthMessage(isUnauthorizedError(error) ? '请登录继续。' : formatError(error, '无法检查登录状态。'))
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = authForm.email.trim()
    const password = authForm.password
    if (!email || password.length < 12) {
      setAuthMessage('邮箱必填，密码至少 12 位。')
      return
    }

    setAuthMessage(authMode === 'setup' ? '正在创建管理员...' : '正在登录...')
    try {
      const response = authMode === 'setup'
        ? await setupAdmin({ email, password })
        : await loginAdmin({ email, password })
      setAuthUser(response.user)
      setAuthMode('ready')
      setAuthMessage(`已登录：${response.user.email}`)
    } catch (error) {
      setAuthMessage(formatError(error, '认证失败。'))
    }
  }

  async function handleLogout() {
    await logoutAdmin()
    clearStoredSessionToken()
    setAuthUser(null)
    setAuthMode('login')
    setAuthMessage('已退出。')
  }

  function handleRequestError(error: unknown, fallback: string): string {
    if (isUnauthorizedError(error)) {
      clearStoredSessionToken()
      setAuthUser(null)
      setAuthMode('login')
      return '登录已过期，请重新登录。'
    }

    return formatError(error, fallback)
  }

  async function refreshWorkspace() {
    setLoadState('loading')
    try {
      const [nextProviders, nextAgents] = await Promise.all([
        listProviderConfigs(),
        listAgents(),
      ])
      setProviders(nextProviders)
      setAgents(nextAgents)

      const nextSelected = selectedAgentId
        ? nextAgents.find((agent) => agent.id === selectedAgentId)
        : nextAgents[0]
      setSelectedAgentId(nextSelected?.id ?? null)

      if (nextSelected) {
        const nextDocuments = await listDocuments(nextSelected.id)
        setDocuments(nextDocuments)
      } else {
        setDocuments([])
      }

      setLoadState('idle')
      setMessage('工作区已同步。')
    } catch (error) {
      setLoadState('error')
      setMessage(handleRequestError(error, '同步工作区失败。'))
    }
  }

  async function selectAgent(agentId: number) {
    setSelectedAgentId(agentId)
    setLoadState('loading')
    try {
      setDocuments(await listDocuments(agentId))
      setLoadState('idle')
    } catch (error) {
      setLoadState('error')
      setMessage(handleRequestError(error, '加载 Agent 文档失败。'))
    }
  }

  async function handleSaveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!providerForm.name.trim() || !providerForm.type.trim() || !providerForm.provider.trim()) {
      setMessage('Provider 的 name、type、provider 必填。')
      return
    }

    setLoadState('loading')
    try {
      await createProviderConfig({
        name: providerForm.name.trim(),
        type: providerForm.type.trim(),
        config: {
          provider: providerForm.provider.trim(),
          model: providerForm.model.trim(),
        },
        secret: providerForm.secret,
      })
      const nextProviders = await listProviderConfigs()
      setProviders(nextProviders)
      setActiveStep('agent')
      setMessage('Provider 已保存，可以创建 Agent。')
      setLoadState('idle')
    } catch (error) {
      setLoadState('error')
      setMessage(handleRequestError(error, '保存 Provider 失败。'))
    }
  }

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!agentForm.name.trim()) {
      setMessage('Agent 名称必填。')
      return
    }

    setLoadState('loading')
    try {
      const created = await createAgent({
        name: agentForm.name.trim(),
        description: agentForm.description.trim(),
        memoryProvider: agentForm.memoryProvider,
        cacheProvider: agentForm.cacheProvider,
        ragProvider: agentForm.ragProvider,
        enabledTools: splitList(agentForm.enabledTools),
        enabledSkills: splitList(agentForm.enabledSkills),
        modelConfig: {
          default: { provider: providerForm.provider, model: providerForm.model },
          embedding: { provider: 'mock', model: 'mock-embedding' },
        },
      })
      const nextAgents = await listAgents()
      setAgents(nextAgents)
      setSelectedAgentId(created.id)
      setDocuments([])
      setActiveStep('knowledge')
      setMessage(`Agent 已创建：${created.name}`)
      setLoadState('idle')
    } catch (error) {
      setLoadState('error')
      setMessage(handleRequestError(error, '创建 Agent 失败。'))
    }
  }

  async function handleCreateDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedAgentId) {
      setMessage('请先选择或创建 Agent。')
      return
    }
    if (!documentForm.filename.trim() || !documentForm.content.trim()) {
      setMessage('文档 filename 和 content 必填。')
      return
    }

    setLoadState('loading')
    try {
      const created = await createDocument(selectedAgentId, {
        filename: documentForm.filename.trim(),
        collection: documentForm.collection.trim(),
        content: documentForm.content,
      })
      const indexed = await indexDocument(selectedAgentId, created.id)
      const nextDocuments = await listDocuments(selectedAgentId)
      setDocuments(nextDocuments)
      setActiveStep('run')
      setMessage(`文档已注册并索引：${indexed.filename}`)
      setLoadState('idle')
    } catch (error) {
      setLoadState('error')
      setMessage(handleRequestError(error, '注册或索引文档失败。'))
    }
  }

  async function handleRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedAgentId) {
      setMessage('请先选择 Agent。')
      return
    }
    if (!runGoal.trim()) {
      setMessage('Run goal 必填。')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setRunStatus('running')
    setEvents([])
    setMessage('Agent 正在运行...')

    try {
      await streamAgentRun(
        { agentId: selectedAgentId, input: runGoal.trim() },
        {
          signal: controller.signal,
          onEvent: (parsed) => {
            const nextEvent: TimelineEvent = {
              id: eventIdRef.current++,
              event: parsed.event,
              receivedAt: new Date().toLocaleTimeString(),
              ...parsed.data,
            }
            setEvents((current) => [...current, nextEvent])
            if (
              parsed.event === 'agent.run.completed'
              || parsed.data.status === 'done'
            ) {
              setRunStatus('done')
              setActiveStep('source')
              setMessage('运行完成，可以生成源码。')
            } else if (parsed.event === 'agent.error' || parsed.data.status === 'error') {
              setRunStatus('error')
            }
          },
        },
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        setRunStatus('error')
        setEvents((current) => [
          ...current,
          {
            id: eventIdRef.current++,
            event: 'agent.error',
            message: handleRequestError(error, '运行失败。'),
            status: 'error',
            receivedAt: new Date().toLocaleTimeString(),
          },
        ])
      }
    } finally {
      abortRef.current = null
      setRunStatus((current) => (current === 'running' ? 'idle' : current))
    }
  }

  function stopRun() {
    abortRef.current?.abort()
    abortRef.current = null
    setRunStatus('idle')
    setMessage('运行已停止。')
  }

  async function handleGenerateSource() {
    if (!selectedAgentId) {
      setMessage('请先选择 Agent。')
      return
    }

    setLoadState('loading')
    try {
      const generated = await generateAgentProject(selectedAgentId)
      const nextAgents = await listAgents()
      setAgents(nextAgents)
      setMessage(`源码已生成：${generated.path}`)
      setLoadState('idle')
    } catch (error) {
      setLoadState('error')
      setMessage(handleRequestError(error, '生成源码失败。'))
    }
  }

  if (authMode !== 'ready') {
    return (
      <main className="min-h-screen bg-zinc-50 p-4 text-zinc-950 md:p-8">
        <Card className="mx-auto mt-20 max-w-md">
          <CardHeader>
            <CardTitle>{authMode === 'setup' ? 'Create Admin' : 'Admin Login'}</CardTitle>
            <CardDescription>{authMessage}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={handleAuthSubmit}>
              <Label>
                Email
                <Input
                  autoComplete="email"
                  disabled={authMode === 'checking'}
                  onChange={(event) => setAuthForm((current) => ({
                    ...current,
                    email: event.target.value,
                  }))}
                  type="email"
                  value={authForm.email}
                />
              </Label>
              <Label>
                Password
                <Input
                  autoComplete={authMode === 'setup' ? 'new-password' : 'current-password'}
                  disabled={authMode === 'checking'}
                  minLength={12}
                  onChange={(event) => setAuthForm((current) => ({
                    ...current,
                    password: event.target.value,
                  }))}
                  type="password"
                  value={authForm.password}
                />
              </Label>
              <Button disabled={authMode === 'checking'} type="submit">
                {authMode === 'checking' ? <Loader2 className="animate-spin" /> : null}
                {authMode === 'setup' ? 'Create Admin' : 'Sign In'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 md:flex-row md:items-center md:justify-between md:px-6">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">Primalthrum 1.0</Badge>
              <Badge variant={completedCount === STEPS.length ? 'success' : 'secondary'}>
                {completedCount}/{STEPS.length} complete
              </Badge>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
              Agent 创建与验证向导
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              按步骤保存 Provider、创建 Agent、添加知识、运行验证、生成源码。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{authUser?.email}</Badge>
            <Button onClick={() => void refreshWorkspace()} size="sm" variant="outline">
              <RefreshCw />
              Refresh
            </Button>
            <Button onClick={() => void handleLogout()} size="sm" variant="ghost">
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 md:px-6 xl:grid-cols-[300px_1fr_320px]">
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Progress</CardTitle>
              <CardDescription>{message}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={progress} />
              <div className="grid gap-2">
                {STEPS.map((step, index) => {
                  const Icon = step.icon
                  const complete = completedSteps[step.id]
                  const active = activeStep === step.id

                  return (
                    <button
                      className={[
                        'step-item',
                        active ? 'step-item-active' : '',
                        complete ? 'step-item-complete' : '',
                      ].join(' ')}
                      key={step.id}
                      onClick={() => setActiveStep(step.id)}
                      type="button"
                    >
                      <span className="step-index">
                        {complete ? <Check /> : <span>{index + 1}</span>}
                      </span>
                      <Icon className="size-4" />
                      <span className="min-w-0 flex-1 text-left">
                        <strong>{step.title}</strong>
                        <small>{step.description}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </aside>

        <section className="min-w-0">
          {activeStep === 'provider' ? (
            <ProviderStep
              form={providerForm}
              loading={loadState === 'loading'}
              providers={providers}
              setForm={setProviderForm}
              onSubmit={handleSaveProvider}
            />
          ) : null}

          {activeStep === 'agent' ? (
            <AgentStep
              agents={agents}
              form={agentForm}
              loading={loadState === 'loading'}
              selectedAgent={selectedAgent}
              setForm={setAgentForm}
              onSelectAgent={(agentId) => void selectAgent(agentId)}
              onSubmit={handleCreateAgent}
            />
          ) : null}

          {activeStep === 'knowledge' ? (
            <KnowledgeStep
              documents={documents}
              form={documentForm}
              loading={loadState === 'loading'}
              selectedAgent={selectedAgent}
              setForm={setDocumentForm}
              onSubmit={handleCreateDocument}
            />
          ) : null}

          {activeStep === 'run' ? (
            <RunStep
              events={events}
              goal={runGoal}
              runStatus={runStatus}
              selectedAgent={selectedAgent}
              setGoal={setRunGoal}
              onStop={stopRun}
              onSubmit={handleRun}
            />
          ) : null}

          {activeStep === 'source' ? (
            <SourceStep
              loading={loadState === 'loading'}
              selectedAgent={selectedAgent}
              onGenerate={() => void handleGenerateSource()}
            />
          ) : null}
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">当前 Agent</CardTitle>
              <CardDescription>
                {selectedAgent ? '已选择，可以继续后续步骤。' : '还没有选择 Agent。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {selectedAgent ? (
                <>
                  <div className="rounded-md border bg-white p-3">
                    <div className="font-medium">{selectedAgent.name}</div>
                    <div className="mt-1 text-muted-foreground">{selectedAgent.slug}</div>
                  </div>
                  <StatusRow label="状态" value={selectedAgent.status} />
                  <StatusRow label="文档" value={`${documents.length} registered`} />
                  <StatusRow label="已索引" value={`${indexedDocuments.length} indexed`} />
                  <StatusRow label="运行" value={statusLabel(runStatus)} />
                </>
              ) : (
                <EmptyHint title="没有 Agent" message="先完成第 2 步创建 Agent。" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">如何判断成功</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <CheckLine done={completedSteps.agent} text="Agent 出现在列表里" />
              <CheckLine done={completedSteps.knowledge} text="Knowledge 至少 1 个 indexed 文档" />
              <CheckLine done={completedSteps.run} text="Stream Timeline 出现 completed 事件" />
              <CheckLine done={completedSteps.source} text="源码路径已生成" />
            </CardContent>
          </Card>
        </aside>
      </div>
    </main>
  )
}

function ProviderStep({
  form,
  providers,
  loading,
  setForm,
  onSubmit,
}: {
  form: ProviderFormState
  providers: ProviderConfigRecord[]
  loading: boolean
  setForm: (updater: (current: ProviderFormState) => ProviderFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 1. 保存 Provider Config</CardTitle>
        <CardDescription>
          先保存模型配置。开发环境可以用 mock，后期再换真实 LLM。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-5" onSubmit={onSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <Label>
              Name
              <Input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </Label>
            <Label>
              Type
              <Input
                value={form.type}
                onChange={(event) => setForm((current) => ({ ...current, type: event.target.value }))}
              />
            </Label>
            <Label>
              Provider
              <Input
                value={form.provider}
                onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))}
              />
            </Label>
            <Label>
              Model
              <Input
                value={form.model}
                onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
              />
            </Label>
          </div>
          <Label>
            Secret
            <Input
              value={form.secret}
              onChange={(event) => setForm((current) => ({ ...current, secret: event.target.value }))}
              type="password"
            />
          </Label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              已保存 {providers.length} 个 Provider Config。
            </div>
            <Button disabled={loading} type="submit">
              {loading ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              保存并进入 Agent
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function AgentStep({
  form,
  agents,
  selectedAgent,
  loading,
  setForm,
  onSubmit,
  onSelectAgent,
}: {
  form: AgentFormState
  agents: AgentRecord[]
  selectedAgent: AgentRecord | null
  loading: boolean
  setForm: (updater: (current: AgentFormState) => AgentFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onSelectAgent: (agentId: number) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 2. 创建或选择 Agent</CardTitle>
        <CardDescription>
          创建后会进入 draft 状态；第 5 步可以生成独立源码项目。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-2">
          {agents.length === 0 ? (
            <EmptyHint title="还没有 Agent" message="填写下方表单创建第一个 Agent。" />
          ) : (
            agents.map((agent) => (
              <button
                className={agent.id === selectedAgent?.id ? 'agent-choice selected' : 'agent-choice'}
                key={agent.id}
                onClick={() => onSelectAgent(agent.id)}
                type="button"
              >
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.slug}</small>
                </span>
                <Badge variant={agent.status === 'generated' ? 'success' : 'secondary'}>
                  {agent.status}
                </Badge>
              </button>
            ))
          )}
        </div>

        <Separator />

        <form className="grid gap-5" onSubmit={onSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <Label>
              Name
              <Input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </Label>
            <Label>
              RAG Provider
              <Input
                value={form.ragProvider}
                onChange={(event) => setForm((current) => ({ ...current, ragProvider: event.target.value }))}
              />
            </Label>
            <Label>
              Memory Provider
              <Input
                value={form.memoryProvider}
                onChange={(event) => setForm((current) => ({ ...current, memoryProvider: event.target.value }))}
              />
            </Label>
            <Label>
              Cache Provider
              <Input
                value={form.cacheProvider}
                onChange={(event) => setForm((current) => ({ ...current, cacheProvider: event.target.value }))}
              />
            </Label>
          </div>
          <Label>
            Description
            <Textarea
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            />
          </Label>
          <div className="grid gap-4 md:grid-cols-2">
            <Label>
              Tools
              <Input
                value={form.enabledTools}
                onChange={(event) => setForm((current) => ({ ...current, enabledTools: event.target.value }))}
              />
            </Label>
            <Label>
              Skills
              <Input
                value={form.enabledSkills}
                onChange={(event) => setForm((current) => ({ ...current, enabledSkills: event.target.value }))}
              />
            </Label>
          </div>
          <Button className="justify-self-end" disabled={loading} type="submit">
            {loading ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            创建并进入 Knowledge
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function KnowledgeStep({
  selectedAgent,
  documents,
  form,
  loading,
  setForm,
  onSubmit,
}: {
  selectedAgent: AgentRecord | null
  documents: DocumentRecord[]
  form: DocumentFormState
  loading: boolean
  setForm: (updater: (current: DocumentFormState) => DocumentFormState) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 3. 注册并索引 Knowledge</CardTitle>
        <CardDescription>
          当前 Agent：{selectedAgent?.name ?? '未选择'}。提交后会自动注册并 Index。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-2">
          {documents.length === 0 ? (
            <EmptyHint title="还没有文档" message="添加一段知识，验证 RAG 路径是否工作。" />
          ) : (
            documents.map((document) => (
              <div className="document-choice" key={document.id}>
                <FileText className="size-4" />
                <span>
                  <strong>{document.filename}</strong>
                  <small>{document.collection}</small>
                </span>
                <Badge variant={document.indexStatus === 'indexed' ? 'success' : 'secondary'}>
                  {document.indexStatus}
                </Badge>
              </div>
            ))
          )}
        </div>

        <Separator />

        <form className="grid gap-5" onSubmit={onSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <Label>
              Filename
              <Input
                value={form.filename}
                onChange={(event) => setForm((current) => ({ ...current, filename: event.target.value }))}
              />
            </Label>
            <Label>
              Collection
              <Input
                value={form.collection}
                onChange={(event) => setForm((current) => ({ ...current, collection: event.target.value }))}
              />
            </Label>
          </div>
          <Label>
            Content
            <Textarea
              className="min-h-52 font-mono text-xs"
              value={form.content}
              onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
            />
          </Label>
          <Button className="justify-self-end" disabled={!selectedAgent || loading} type="submit">
            {loading ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            注册、索引并进入 Run
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function RunStep({
  selectedAgent,
  goal,
  events,
  runStatus,
  setGoal,
  onSubmit,
  onStop,
}: {
  selectedAgent: AgentRecord | null
  goal: string
  events: TimelineEvent[]
  runStatus: RunStatus
  setGoal: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onStop: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 4. 运行 Agent 验证可用性</CardTitle>
        <CardDescription>
          当前 Agent：{selectedAgent?.name ?? '未选择'}。看到 completed 事件就说明平台运行链路可用。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form className="grid gap-4" onSubmit={onSubmit}>
          <Label>
            Goal
            <Textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
          </Label>
          <div className="flex justify-end gap-2">
            <Button disabled={runStatus !== 'running'} onClick={onStop} type="button" variant="outline">
              Stop
            </Button>
            <Button disabled={!selectedAgent || runStatus === 'running'} type="submit">
              {runStatus === 'running' ? <Loader2 className="animate-spin" /> : <Play />}
              Start Stream
            </Button>
          </div>
        </form>

        <div className="timeline-box">
          {events.length === 0 ? (
            <EmptyHint title="还没有运行事件" message="点击 Start Stream 后，这里会显示 LangGraph 节点进度。" />
          ) : (
            events.map((event) => (
              <div className="timeline-event" key={event.id}>
                <Circle className={event.status === 'error' ? 'text-red-500' : 'text-zinc-400'} />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{event.event}</Badge>
                    <span className="text-xs text-muted-foreground">{event.receivedAt}</span>
                  </div>
                  <p>{event.message ?? event.node ?? 'Node completed'}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function SourceStep({
  selectedAgent,
  loading,
  onGenerate,
}: {
  selectedAgent: AgentRecord | null
  loading: boolean
  onGenerate: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 5. 生成源码并本地验证</CardTitle>
        <CardDescription>
          生成后会写入 <code>generated-agents/&lt;agent-slug&gt;</code>，可以直接运行 Python 命令验证。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {selectedAgent ? (
          <div className="rounded-md border bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">{selectedAgent.name}</div>
                <div className="mt-1 text-sm text-muted-foreground">{selectedAgent.path}</div>
              </div>
              <Badge variant={selectedAgent.status === 'generated' ? 'success' : 'secondary'}>
                {selectedAgent.status}
              </Badge>
            </div>
          </div>
        ) : (
          <EmptyHint title="没有 Agent" message="先完成第 2 步。" />
        )}

        <Button className="justify-self-start" disabled={!selectedAgent || loading} onClick={onGenerate}>
          {loading ? <Loader2 className="animate-spin" /> : <Code2 />}
          Generate Source
        </Button>

        <div className="rounded-md border bg-zinc-950 p-4 text-zinc-50">
          <div className="mb-3 flex items-center gap-2 text-sm text-zinc-300">
            <Terminal className="size-4" />
            本地验证命令
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-6">
            {sourceCommand(selectedAgent)}
          </pre>
        </div>
      </CardContent>
    </Card>
  )
}

function EmptyHint({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-md border border-dashed bg-zinc-50 p-4 text-sm">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-muted-foreground">{message}</div>
    </div>
  )
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline">{value}</Badge>
    </div>
  )
}

function CheckLine({ done, text }: { done: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2">
      {done ? <Check className="size-4 text-emerald-600" /> : <Circle className="size-4 text-zinc-300" />}
      <span className={done ? 'text-zinc-900' : ''}>{text}</span>
    </div>
  )
}
