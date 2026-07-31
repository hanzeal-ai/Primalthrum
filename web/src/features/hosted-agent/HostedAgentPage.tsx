import {
  ArrowLeft,
  Bot,
  FileText,
  Loader2,
  RefreshCcw,
  RotateCcw,
  User,
  Wrench,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { getAgentBySlug, streamAgentRun } from '../../api/client'
import type { AgentRecord, AuthUser, StreamPayload } from '../../api/types'
import { ChatComposer } from '../../components/chat/ChatComposer'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

interface HostedAgentPageProps {
  slug: string
  user: AuthUser
  onBack: () => void
}

interface ChatMessage {
  id: string
  role: 'assistant' | 'user'
  content: string
  status?: 'streaming' | 'stopped' | 'error'
}

interface Attachment {
  name: string
  content: string
}

interface ActivityItem {
  id: string
  event: string
  payload: StreamPayload
}

export function HostedAgentPage({ slug, user, onBack }: HostedAgentPageProps) {
  const [agent, setAgent] = useState<AgentRecord | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages(slug))
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void getAgentBySlug(slug)
      .then((record) => {
        setAgent(record)
        setMessages((current) => current.length ? current : [welcomeMessage(record)])
      })
      .catch((loadError) => setError(errorMessage(loadError, '无法打开这个 Agent。')))
      .finally(() => setLoading(false))
  }, [slug])

  useEffect(() => {
    if (messages.length) {
      window.localStorage.setItem(historyKey(slug), JSON.stringify(messages.filter((item) => item.status !== 'streaming')))
    }
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, slug])

  async function addAttachments(files: File[]) {
    const loaded = await Promise.all(files.map(async (file) => ({
      name: file.name,
      content: await file.text(),
    })))
    setAttachments((current) => [...current, ...loaded])
  }

  async function submit(promptOverride?: string) {
    const prompt = (promptOverride ?? input).trim()
    if (!agent || !prompt || running) return

    const attachmentContext = attachments.length
      ? `\n\n附件内容：\n${attachments.map((file) => `--- ${file.name} ---\n${file.content}`).join('\n')}`
      : ''
    const assistantId = crypto.randomUUID()
    const controller = new AbortController()
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
      await streamAgentRun(
        { agentId: agent.id, input: `${prompt}${attachmentContext}` },
        {
          signal: controller.signal,
          onEvent: ({ event, data }) => {
            if (event === 'message.delta' && data.delta) {
              setMessages((current) => current.map((item) => item.id === assistantId
                ? { ...item, content: item.content + data.delta }
                : item))
              return
            }

            if (event === 'message.completed') {
              setMessages((current) => current.map((item) => item.id === assistantId
                ? { ...item, content: item.content || data.message || '', status: undefined }
                : item))
              return
            }

            if (event === 'agent.error') {
              streamError = data.message || 'Agent 运行失败。'
              return
            }

            setActivities((current) => [...current, {
              id: crypto.randomUUID(),
              event,
              payload: data,
            }])
          },
        },
      )

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

  function clearConversation() {
    if (!agent) return
    window.localStorage.removeItem(historyKey(slug))
    setMessages([welcomeMessage(agent)])
    setActivities([])
    setError('')
  }

  if (loading) {
    return <main className="grid min-h-screen place-items-center"><Loader2 className="size-5 animate-spin" /></main>
  }

  if (!agent) {
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
        <div className="grid size-9 place-items-center rounded-md bg-blue-600 text-white"><Bot /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
            <Badge variant="success">在线</Badge>
          </div>
          <p className="truncate text-xs text-zinc-500">{agent.description || 'Primalthrum Agent'}</p>
        </div>
        <span className="hidden text-xs text-zinc-500 sm:block">{user.email}</span>
        <Button aria-label="清空对话" onClick={clearConversation} size="icon" title="清空对话" variant="ghost"><RotateCcw /></Button>
      </header>

      <section className="hosted-chat">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {messages.map((item) => (
            <div className={`hosted-message ${item.role === 'user' ? 'hosted-message-user' : ''}`} key={item.id}>
              <div className="hosted-avatar">{item.role === 'user' ? <User /> : <Bot />}</div>
              <div className="min-w-0">
                <div className="hosted-bubble">
                  {item.content || <span className="inline-flex items-center gap-2 text-zinc-500"><Loader2 className="size-3 animate-spin" />正在生成</span>}
                </div>
                {item.status ? <p className="mt-1 text-xs text-zinc-400">{statusLabel(item.status)}</p> : null}
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

function welcomeMessage(agent: AgentRecord): ChatMessage {
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

function statusLabel(status: NonNullable<ChatMessage['status']>): string {
  if (status === 'stopped') return '已停止'
  if (status === 'error') return '运行失败'
  return '正在生成'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
