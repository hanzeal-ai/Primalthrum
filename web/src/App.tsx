import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { streamAgentRun } from './api/client'
import type { RunStatus, StreamPayload } from './api/types'
import './App.css'

interface TimelineEvent extends StreamPayload {
  id: number
  event: string
  receivedAt: string
}

const DEFAULT_FORM = {
  agent: 'ResearchAgent',
  goal: 'Create a research agent that can plan tasks, collect evidence, and stream progress to the product UI.',
  tools: 'planner, memory, file_search',
}

function statusLabel(status: RunStatus): string {
  if (status === 'running') return 'Running'
  if (status === 'done') return 'Complete'
  if (status === 'error') return 'Error'
  return 'Idle'
}

export default function App() {
  const [form, setForm] = useState(DEFAULT_FORM)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [status, setStatus] = useState<RunStatus>('idle')
  const [summary, setSummary] = useState<StreamPayload>({})
  const abortRef = useRef<AbortController | null>(null)
  const eventIdRef = useRef(1)

  const latestMessage = events.at(-1)?.message ?? 'Ready to stream an agent run.'
  const hasOutput = events.length > 0

  const visibleArtifacts = useMemo(() => {
    return {
      tools: summary.tools ?? [],
      plan: summary.plan ?? [],
      artifacts: summary.artifacts ?? [],
      checks: summary.checks ?? [],
    }
  }, [summary])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'running') return

    const goal = form.goal.trim()
    const agent = form.agent.trim()
    const tools = form.tools.split(',').map((tool) => tool.trim()).filter(Boolean)

    if (!goal || !agent) {
      setStatus('error')
      setEvents([
        {
          id: eventIdRef.current++,
          event: 'agent.error',
          message: 'Agent name and goal are required.',
          status: 'error',
          receivedAt: new Date().toLocaleTimeString(),
        },
      ])
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('running')
    setEvents([])
    setSummary({})

    try {
      await streamAgentRun({ agent, goal, tools }, {
        signal: controller.signal,
        onEvent: (parsed) => {
          const nextEvent: TimelineEvent = {
            id: eventIdRef.current++,
            event: parsed.event,
            receivedAt: new Date().toLocaleTimeString(),
            ...parsed.data,
          }

          setEvents((current) => [...current, nextEvent])
          setSummary((current) => ({ ...current, ...parsed.data }))

          if (parsed.event === 'agent.done' || parsed.data.status === 'done') {
            setStatus('done')
          } else if (parsed.event === 'agent.error' || parsed.data.status === 'error') {
            setStatus('error')
          }
        },
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus('error')
        setEvents((current) => [
          ...current,
          {
            id: eventIdRef.current++,
            event: 'agent.error',
            message: error instanceof Error ? error.message : 'Stream failed.',
            status: 'error',
            receivedAt: new Date().toLocaleTimeString(),
          },
        ])
      }
    } finally {
      abortRef.current = null
      setStatus((current) => (current === 'running' ? 'idle' : current))
    }
  }

  function stopRun() {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus('idle')
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="product">Primalthrum</p>
          <h1>Agent R&D Console</h1>
        </div>
        <div className={`status ${status}`}>
          <span />
          {statusLabel(status)}
        </div>
      </header>

      <section className="shell">
        <form className="panel control-panel" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <h2>Run Configuration</h2>
            <p>{latestMessage}</p>
          </div>

          <label>
            <span>Agent</span>
            <input
              value={form.agent}
              onChange={(event) => setForm((current) => ({ ...current, agent: event.target.value }))}
              placeholder="ResearchAgent"
            />
          </label>

          <label>
            <span>Goal</span>
            <textarea
              value={form.goal}
              onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))}
              rows={6}
              placeholder="Describe the agent you want to initialize."
            />
          </label>

          <label>
            <span>Tools</span>
            <input
              value={form.tools}
              onChange={(event) => setForm((current) => ({ ...current, tools: event.target.value }))}
              placeholder="planner, memory, executor"
            />
          </label>

          <div className="actions">
            <button className="primary" type="submit" disabled={status === 'running'}>
              {status === 'running' ? 'Streaming' : 'Start Stream'}
            </button>
            <button className="secondary" type="button" onClick={stopRun} disabled={status !== 'running'}>
              Stop
            </button>
          </div>
        </form>

        <section className="panel timeline-panel" aria-live="polite">
          <div className="panel-heading inline">
            <div>
              <h2>Stream Timeline</h2>
              <p>{hasOutput ? `${events.length} events received` : 'No stream events yet'}</p>
            </div>
            <code>POST /api/stream</code>
          </div>

          <div className="timeline">
            {!hasOutput && (
              <div className="empty-state">
                <strong>Waiting for a run</strong>
                <span>Submit the configuration to watch LangGraph node updates arrive as SSE events.</span>
              </div>
            )}

            {events.map((item) => (
              <article className={`event-row ${item.status === 'error' ? 'error' : ''}`} key={item.id}>
                <div className="event-marker" />
                <div>
                  <div className="event-meta">
                    <span>{item.event}</span>
                    <span>{item.node ?? 'stream'}</span>
                    <time>{item.receivedAt}</time>
                  </div>
                  <p>{item.message ?? 'Node completed'}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="panel summary-panel">
          <div className="panel-heading">
            <h2>Run Artifacts</h2>
            <p>{summary.agent ?? form.agent}</p>
          </div>

          <SummaryList title="Tools" items={visibleArtifacts.tools} />
          <SummaryList title="Plan" items={visibleArtifacts.plan} />
          <SummaryList title="Artifacts" items={visibleArtifacts.artifacts} />
          <SummaryList title="Checks" items={visibleArtifacts.checks} />
        </aside>
      </section>
    </main>
  )
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="summary-group">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">Pending</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
