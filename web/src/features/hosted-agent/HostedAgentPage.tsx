import {
  ArrowLeft,
  Bot,
  FileText,
  Loader2,
  RefreshCcw,
  RotateCcw,
  Settings,
  Square,
  User,
  Volume2,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import {
  ApiError,
  createConversation,
  getAgentBySlug,
  getPublicAgentBySlug,
  listConversationMessages,
  listConversations,
  streamAgentRun,
  streamPublicAgentRun,
} from '../../api/client'
import type {
  AuthUser,
  ConversationMessageRecord,
  HostedAgentRecord,
  SourceReference,
  StreamPayload,
} from '../../api/types'
import { ChatComposer } from '../../components/chat/ChatComposer'
import { useSpeechPlayback } from '../../hooks/useSpeechPlayback'
import {
  prepareTextDocument,
  type PreparedTextDocument,
  validateDocumentBatch,
} from '../../lib/documents'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { WorkspaceSwitcher } from '../workspaces/WorkspaceSwitcher'
import { AgentVersionPanel } from './AgentVersionPanel'

interface HostedAgentPageProps {
  slug: string
  user?: AuthUser
  access?: 'authenticated' | 'public'
  unavailableFallback?: ReactNode
  onBack: () => void
  versionId?: number
}

interface ChatMessage {
  id: string
  role: 'assistant' | 'user'
  content: string
  sources?: SourceReference[]
  status?: 'streaming' | 'stopped' | 'error'
}

type Attachment = PreparedTextDocument

interface ActivityItem {
  id: string
  event: string
  payload: StreamPayload
}

export function HostedAgentPage({
  slug,
  user,
  access = 'authenticated',
  unavailableFallback,
  onBack,
  versionId,
}: HostedAgentPageProps) {
  const [agent, setAgent] = useState<HostedAgentRecord | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages(slug))
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const speechPlayback = useSpeechPlayback()

  useEffect(() => {
    let active = true

    async function loadAgent() {
      try {
        const record = access === 'public'
          ? await getPublicAgentBySlug(slug)
          : await getAgentBySlug(slug)
        if (!active) return
        setAgent(record)

        if (access === 'public') {
          setMessages((current) => current.length ? current : [welcomeMessage(record)])
          return
        }

        try {
          const conversations = await listConversations(record.id)
          const conversation = conversations[0] ?? await createConversation(record.id)
          const history = await listConversationMessages(conversation.id)
          if (!active) return
          setConversationId(conversation.id)
          setMessages(history.length ? history.map(toChatMessage) : [welcomeMessage(record)])
        } catch (historyError) {
          if (!active) return
          setMessages((current) => current.length ? current : [welcomeMessage(record)])
          setError(errorMessage(historyError, '服务端历史暂不可用，当前对话将保存在浏览器。'))
        }
      } catch (loadError) {
        if (active) setError(errorMessage(loadError, '无法打开这个 Agent。'))
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadAgent()
    return () => {
      active = false
    }
  }, [access, slug])

  useEffect(() => {
    if (messages.length) {
      window.localStorage.setItem(historyKey(slug), JSON.stringify(messages.filter((item) => item.status !== 'streaming')))
    }
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, slug])

  async function addAttachments(files: File[]) {
    setError('')
    try {
      const loaded = await Promise.all(files.map(prepareTextDocument))
      validateDocumentBatch(attachments, loaded)
      setAttachments((current) => [...current, ...loaded])
    } catch (attachmentError) {
      setError(errorMessage(attachmentError, '附件读取失败。'))
    }
  }

  async function submit(promptOverride?: string) {
    const prompt = (promptOverride ?? input).trim()
    if (!agent || !prompt || running) return

    const attachmentContext = attachments.length
      ? `\n\n附件内容：\n${attachments.map((file) => `--- ${file.name} ---\n${file.content}`).join('\n')}`
      : ''
    const assistantId = crypto.randomUUID()
    const controller = new AbortController()
    const idempotencyKey = crypto.randomUUID()
    let lastEventId = 0
    let streamError = ''

    abortRef.current = controller
    setInput('')
    setAttachments([])
    setError('')
    setActivities([])
    setRunning(true)
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: prompt },
      { id: assistantId, role: 'assistant', content: '', status: 'streaming' },
    ])

    try {
      const onEvent: Parameters<typeof streamAgentRun>[1]['onEvent'] = ({ id, event, data }) => {
        if (id) lastEventId = id
        if (event === 'message.delta' && data.delta) {
          setMessages((current) => current.map((item) => item.id === assistantId
            ? { ...item, content: item.content + data.delta }
            : item))
          return
        }

        if (event === 'message.completed') {
          setMessages((current) => current.map((item) => item.id === assistantId
            ? {
                ...item,
                content: item.content || data.message || '',
                sources: data.sources,
                status: undefined,
              }
            : item))
          return
        }

        if (event === 'agent.error' || event === 'agent.run.cancelled') {
          streamError = data.message || 'Agent 运行失败。'
          return
        }

        setActivities((current) => [...current, {
          id: crypto.randomUUID(),
          event,
          payload: data,
        }])
      }
      const streamInput = `${prompt}${attachmentContext}`
      let result: Awaited<ReturnType<typeof streamAgentRun>> | undefined
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const streamOptions: Parameters<typeof streamAgentRun>[1] = {
          signal: controller.signal,
          idempotencyKey,
          afterEventId: lastEventId || undefined,
          onEvent,
        }
        try {
          result = access === 'public'
            ? await streamPublicAgentRun(
                slug,
                { input: streamInput, conversationId: conversationId ?? undefined },
                streamOptions,
              )
            : await streamAgentRun(
                {
                  agentId: agent.id,
                  input: streamInput,
                  conversationId: conversationId ?? undefined,
                  versionId,
                },
                streamOptions,
              )
          break
        } catch (streamRequestError) {
          if (attempt === 2 || !shouldReconnect(streamRequestError, controller.signal)) {
            throw streamRequestError
          }
          await wait(150 * (attempt + 1), controller.signal)
        }
      }
      if (!result) throw new Error('Agent stream could not be resumed.')
      if (result.conversationId) setConversationId(result.conversationId)

      if (streamError) throw new Error(streamError)
      setMessages((current) => current.map((item) => item.id === assistantId
        ? { ...item, content: item.content || 'Agent 已完成运行。', status: undefined }
        : item))
    } catch (runError) {
      const stopped = runError instanceof DOMException && runError.name === 'AbortError'
      setMessages((current) => current.map((item) => item.id === assistantId
        ? {
            ...item,
            content: item.content || (stopped ? '已停止生成。' : '本次运行失败。'),
            status: stopped ? 'stopped' : 'error',
          }
        : item))
      if (!stopped) setError(errorMessage(runError, 'Agent 运行失败。'))
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  function retryLastMessage() {
    const latest = [...messages].reverse().find((item) => item.role === 'user')
    if (latest) void submit(latest.content)
  }

  async function clearConversation() {
    if (!agent) return
    if (access === 'public') {
      setConversationId(null)
      window.localStorage.removeItem(historyKey(slug))
      setMessages([welcomeMessage(agent)])
      setActivities([])
      setError('')
      return
    }
    try {
      const conversation = await createConversation(agent.id)
      setConversationId(conversation.id)
      window.localStorage.removeItem(historyKey(slug))
      setMessages([welcomeMessage(agent)])
      setActivities([])
      setError('')
    } catch (createError) {
      setError(errorMessage(createError, '新建对话失败。'))
    }
  }

  if (loading) {
    return <main className="grid min-h-screen place-items-center"><Loader2 className="size-5 animate-spin" /></main>
  }

  if (!agent) {
    if (unavailableFallback) return unavailableFallback
    return (
      <main className="grid min-h-screen place-items-center bg-zinc-50 p-6">
        <div className="text-center">
          <h1 className="text-lg font-semibold">Agent 无法打开</h1>
          <p className="mt-2 text-sm text-zinc-500">{error}</p>
          <Button className="mt-5" onClick={onBack} variant="outline"><ArrowLeft />返回创建器</Button>
        </div>
      </main>
    )
  }

  return (
    <main className="hosted-shell">
      <header className="hosted-header">
        <Button aria-label="返回创建器" onClick={onBack} size="icon" title="返回创建器" variant="ghost"><ArrowLeft /></Button>
        <div className="hosted-agent-icon"><Bot /></div>
        <div className="hosted-agent-identity">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
            <Badge variant="success">在线</Badge>
            {versionId ? <Badge variant="secondary">预览</Badge> : null}
          </div>
          <p className="truncate text-xs text-zinc-500">{agent.description || 'Primalthrum Agent'}</p>
        </div>
        {user ? <div className="hosted-workspace"><WorkspaceSwitcher user={user} /></div> : null}
        <div className="hosted-header-actions">
          {user ? (
            <Button
              aria-label="版本与部署"
              onClick={() => setVersionsOpen(true)}
              size="icon"
              title="版本与部署"
              variant="ghost"
            >
              <Settings />
            </Button>
          ) : null}
          <Button aria-label="新建对话" onClick={() => void clearConversation()} size="icon" title="新建对话" variant="ghost"><RotateCcw /></Button>
        </div>
      </header>

      {user && versionsOpen ? (
        <AgentVersionPanel
          agentId={agent.id}
          onClose={() => setVersionsOpen(false)}
          role={user.role}
        />
      ) : null}

      <section className="hosted-chat">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {messages.map((item) => (
            <div className={`hosted-message ${item.role === 'user' ? 'hosted-message-user' : ''}`} key={item.id}>
              <div className="hosted-avatar">{item.role === 'user' ? <User /> : <Bot />}</div>
              <div className="min-w-0">
                <div className="hosted-bubble">
                  {item.content || <span className="inline-flex items-center gap-2 text-zinc-500"><Loader2 className="size-3 animate-spin" />正在生成</span>}
                </div>
                {item.role === 'assistant' && item.content && item.status !== 'streaming' && speechPlayback.available ? (
                  <Button
                    aria-label={speechPlayback.activeId === item.id ? '停止朗读' : '朗读消息'}
                    className="mt-1 size-7"
                    onClick={() => speechPlayback.activeId === item.id
                      ? speechPlayback.stop()
                      : void speechPlayback.play(item.id, item.content)}
                    size="icon"
                    title={speechPlayback.activeId === item.id ? '停止朗读' : '朗读'}
                    variant="ghost"
                  >
                    {speechPlayback.activeId === item.id ? <Square /> : <Volume2 />}
                  </Button>
                ) : null}
                {item.status ? <p className="mt-1 text-xs text-zinc-400">{statusLabel(item.status)}</p> : null}
                {item.sources?.length ? (
                  <div className="hosted-sources">
                    <span>来源</span>
                    {item.sources.map((source) => source.url ? (
                      <a href={source.url} key={`${source.title}:${source.chunkId ?? ''}`} rel="noreferrer" target="_blank">
                        <FileText />{source.title}
                      </a>
                    ) : (
                      <span className="hosted-source" key={`${source.title}:${source.chunkId ?? ''}`}>
                        <FileText />{source.title}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {activities.length ? (
            <details className="hosted-activity">
              <summary><Wrench />运行活动（{activities.length}）</summary>
              <div className="mt-3 space-y-2">
                {activities.map((item) => (
                  <div className="flex gap-2 text-xs text-zinc-500" key={item.id}>
                    <span className="font-medium text-zinc-700">{item.payload.node || item.event}</span>
                    <span>{item.payload.message || item.event}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          {error ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <span>{error}</span>
              <Button disabled={running} onClick={retryLastMessage} size="sm" variant="outline"><RefreshCcw />重试</Button>
            </div>
          ) : null}
          {speechPlayback.error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {speechPlayback.error}
            </div>
          ) : null}
          <div ref={messageEndRef} />
        </div>
      </section>

      <footer className="hosted-composer-wrap">
        <div className="mx-auto w-full max-w-3xl">
          {attachments.length ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((file) => (
                <span className="inline-flex max-w-56 items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 text-xs" key={file.name}>
                  <FileText className="size-3" /><span className="truncate">{file.name}</span>
                </span>
              ))}
            </div>
          ) : null}
          <ChatComposer
            busy={running}
            disabled={running}
            onChange={setInput}
            onFiles={(files) => void addAttachments(files)}
            onStop={() => abortRef.current?.abort()}
            onSubmit={() => void submit()}
            placeholder={`给 ${agent.name} 发送消息...`}
            value={input}
          />
        </div>
      </footer>
    </main>
  )
}

function welcomeMessage(agent: HostedAgentRecord): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `你好，我是${agent.name}。请告诉我你现在需要完成什么。`,
  }
}

function historyKey(slug: string): string {
  return `primalthrum.hosted-history.${slug}`
}

function loadMessages(slug: string): ChatMessage[] {
  try {
    const saved = window.localStorage.getItem(historyKey(slug))
    return saved ? JSON.parse(saved) as ChatMessage[] : []
  } catch {
    return []
  }
}

function toChatMessage(message: ConversationMessageRecord): ChatMessage {
  return {
    id: String(message.id),
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    sources: message.sources,
  }
}

function statusLabel(status: NonNullable<ChatMessage['status']>): string {
  if (status === 'stopped') return '已停止'
  if (status === 'error') return '运行失败'
  return '正在生成'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function shouldReconnect(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false
  if (!(error instanceof ApiError)) return true
  return error.code === 'RUN_IN_PROGRESS' || error.status >= 500
}

function wait(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
