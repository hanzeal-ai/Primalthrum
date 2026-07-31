import {
  ExternalLink,
  GitBranch,
  Loader2,
  Plus,
  RefreshCcw,
  Rocket,
  RotateCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  createAgentVersion,
  listAgentDeployments,
  listAgentVersions,
  publishAgentVersion,
  rollbackAgentVersion,
} from '../../api/client'
import type { AgentDeploymentRecord, AgentVersionRecord } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

interface AgentVersionPanelProps {
  agentId: number
  role: string
  onClose: () => void
}

export function AgentVersionPanel({ agentId, role, onClose }: AgentVersionPanelProps) {
  const [versions, setVersions] = useState<AgentVersionRecord[]>([])
  const [deployments, setDeployments] = useState<AgentDeploymentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyVersionId, setBusyVersionId] = useState<number | 'create' | null>(null)
  const [error, setError] = useState('')
  const canWrite = role !== 'viewer'
  const canPublish = role === 'owner' || role === 'admin'

  const load = useCallback(async () => {
    setError('')
    try {
      const [nextVersions, nextDeployments] = await Promise.all([
        listAgentVersions(agentId),
        listAgentDeployments(agentId),
      ])
      setVersions(nextVersions)
      setDeployments(nextDeployments)
    } catch (loadError) {
      setError(errorMessage(loadError, '版本信息加载失败。'))
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timeout)
  }, [load])

  const activeProduction = useMemo(
    () => deployments.find((item) => item.environment === 'production' && item.status === 'active'),
    [deployments],
  )

  async function mutate(
    key: number | 'create',
    operation: () => Promise<unknown>,
  ) {
    setBusyVersionId(key)
    setError('')
    try {
      await operation()
      await load()
    } catch (mutationError) {
      setError(errorMessage(mutationError, '版本操作失败。'))
    } finally {
      setBusyVersionId(null)
    }
  }

  return (
    <div aria-label="版本与部署" className="version-panel-layer" role="dialog">
      <button aria-label="关闭版本面板" className="version-panel-backdrop" onClick={onClose} type="button" />
      <aside className="version-panel">
        <header className="version-panel-header">
          <div>
            <div className="flex items-center gap-2"><GitBranch className="size-4" /><h2 className="text-sm font-semibold">版本与部署</h2></div>
            <p className="mt-1 text-xs text-zinc-500">预览验证后再发布到生产环境</p>
          </div>
          <div className="flex gap-1">
            <Button aria-label="刷新版本" onClick={() => void load()} size="icon" title="刷新" variant="ghost"><RefreshCcw /></Button>
            <Button aria-label="关闭版本面板" onClick={onClose} size="icon" title="关闭" variant="ghost"><X /></Button>
          </div>
        </header>

        <div className="version-panel-content">
          {canWrite ? (
            <Button
              disabled={busyVersionId !== null}
              onClick={() => void mutate('create', () => createAgentVersion(agentId))}
              size="sm"
              variant="outline"
            >
              {busyVersionId === 'create' ? <Loader2 className="animate-spin" /> : <Plus />}
              创建预览版本
            </Button>
          ) : null}

          {error ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div> : null}
          {loading ? <div className="grid place-items-center py-12"><Loader2 className="size-5 animate-spin" /></div> : null}

          {!loading && !versions.length ? (
            <p className="py-12 text-center text-sm text-zinc-500">还没有版本</p>
          ) : null}

          <div className="grid gap-3">
            {versions.map((version) => {
              const production = activeProduction?.versionId === version.id
              const preview = deployments.find((item) => (
                item.versionId === version.id
                && item.environment === 'preview'
                && item.status === 'active'
              ))
              return (
                <article className="version-item" key={version.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">版本 {version.versionNumber}</h3>
                        {production ? <Badge variant="success">生产环境</Badge> : null}
                        {preview ? <Badge variant="secondary">可预览</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">{formatDate(version.createdAt)} · {version.checksum.slice(0, 8)}</p>
                    </div>
                    <Badge variant={version.status === 'published' ? 'outline' : 'secondary'}>
                      {version.status === 'published' ? '已发布' : '预览'}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {preview ? (
                      <Button onClick={() => window.open(preview.urlPath, '_blank', 'noopener,noreferrer')} size="sm" variant="outline">
                        <ExternalLink />打开预览
                      </Button>
                    ) : null}
                    {canPublish && version.status === 'preview' ? (
                      <Button
                        disabled={busyVersionId !== null}
                        onClick={() => void mutate(version.id, () => publishAgentVersion(agentId, version.id))}
                        size="sm"
                      >
                        {busyVersionId === version.id ? <Loader2 className="animate-spin" /> : <Rocket />}
                        发布
                      </Button>
                    ) : null}
                    {canPublish && version.status === 'published' && !production ? (
                      <Button
                        disabled={busyVersionId !== null}
                        onClick={() => void mutate(version.id, () => rollbackAgentVersion(agentId, version.id))}
                        size="sm"
                        variant="outline"
                      >
                        {busyVersionId === version.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                        回滚到此版本
                      </Button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      </aside>
    </div>
  )
}

function formatDate(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(normalized))
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
