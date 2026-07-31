import { Activity, ArrowLeft, Loader2, RefreshCcw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { listCapabilities, updateCapabilitySetting } from '../../api/client'
import type { RuntimeCapabilityCatalog, RuntimeCapabilityRecord } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

interface CapabilitySettingsPanelProps {
  onBack: () => void
  onClose: () => void
}

const KIND_ORDER = ['llm', 'embedding', 'tool', 'skill', 'memory', 'cache', 'rag', 'stt', 'tts']

export function CapabilitySettingsPanel({ onBack, onClose }: CapabilitySettingsPanelProps) {
  const [catalog, setCatalog] = useState<RuntimeCapabilityCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setCatalog(await listCapabilities())
    } catch (loadError) {
      setError(errorMessage(loadError, '运行能力加载失败。'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timeout)
  }, [load])

  const groups = useMemo(() => {
    const entries = new Map<string, RuntimeCapabilityRecord[]>()
    for (const capability of catalog?.capabilities ?? []) {
      entries.set(capability.kind, [...(entries.get(capability.kind) ?? []), capability])
    }
    return KIND_ORDER
      .filter((kind) => entries.has(kind))
      .map((kind) => ({ kind, capabilities: entries.get(kind) ?? [] }))
  }, [catalog])

  async function toggle(capability: RuntimeCapabilityRecord) {
    const key = `${capability.kind}:${capability.name}`
    setBusyKey(key)
    setError('')
    try {
      const updated = await updateCapabilitySetting(
        capability.kind,
        capability.name,
        !capability.enabled,
      )
      setCatalog((current) => current ? {
        ...current,
        capabilities: current.capabilities.map((item) => (
          item.kind === updated.kind && item.name === updated.name ? updated : item
        )),
      } : current)
    } catch (toggleError) {
      setError(errorMessage(toggleError, '能力状态更新失败。'))
    } finally {
      setBusyKey('')
    }
  }

  return (
    <div aria-label="运行能力设置" className="version-panel-layer" role="dialog">
      <button aria-label="关闭运行能力设置" className="version-panel-backdrop" onClick={onClose} type="button" />
      <aside className="provider-panel">
        <header className="version-panel-header">
          <div className="flex min-w-0 items-center gap-2">
            <Button aria-label="返回模型 Provider" onClick={onBack} size="icon" title="返回" variant="ghost"><ArrowLeft /></Button>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">运行能力</h2>
              <p className="mt-1 truncate text-xs text-zinc-500">在两次 Run 之间安全启停</p>
            </div>
          </div>
          <div className="flex gap-1">
            <Button aria-label="刷新运行能力" onClick={() => void load()} size="icon" title="刷新" variant="ghost"><RefreshCcw /></Button>
            <Button aria-label="关闭运行能力设置" onClick={onClose} size="icon" title="关闭" variant="ghost"><X /></Button>
          </div>
        </header>

        <div className="version-panel-content">
          {error ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div> : null}
          {loading ? <div className="grid place-items-center py-12"><Loader2 className="size-5 animate-spin" /></div> : null}
          {!loading && groups.map((group) => (
            <section key={group.kind}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase text-zinc-500">{kindLabel(group.kind)}</h3>
                <span className="text-[11px] text-zinc-400">{group.capabilities.length}</span>
              </div>
              <div className="grid gap-2">
                {group.capabilities.map((capability) => {
                  const key = `${capability.kind}:${capability.name}`
                  const healthy = catalog?.health.find((item) => item.key === key)?.status === 'ok'
                  const planned = capability.status === 'planned'
                  return (
                    <article className="capability-item" key={key}>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-medium">{capability.name}</h4>
                          {planned ? <Badge variant="secondary">Planned</Badge> : (
                            <span className="flex items-center gap-1 text-[11px] text-emerald-700">
                              <Activity className="size-3" />{healthy ? '正常' : '待检查'}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{capability.description}</p>
                        {capability.dependencies.length ? (
                          <p className="mt-1 text-[11px] text-zinc-400">依赖 {capability.dependencies.join('、')}</p>
                        ) : null}
                      </div>
                      <button
                        aria-checked={capability.enabled}
                        aria-label={`${capability.enabled ? '禁用' : '启用'} ${capability.kind}:${capability.name}`}
                        className={`capability-switch ${capability.enabled ? 'capability-switch-on' : ''}`}
                        disabled={planned || Boolean(busyKey)}
                        onClick={() => void toggle(capability)}
                        role="switch"
                        type="button"
                      >
                        <span />
                      </button>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    llm: 'LLM', embedding: 'Embedding', tool: 'Tools', skill: 'Skills',
    memory: 'Memory', cache: 'Cache', rag: 'RAG', stt: 'Speech to text', tts: 'Text to speech',
  }
  return labels[kind] ?? kind
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
