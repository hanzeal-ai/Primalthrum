import { Building2, Check, Loader2, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { createWorkspace, listWorkspaces, switchWorkspace } from '../../api/client'
import type { AuthUser, WorkspaceRecord } from '../../api/types'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

interface WorkspaceSwitcherProps {
  user: AuthUser
}

export function WorkspaceSwitcher({ user }: WorkspaceSwitcherProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void listWorkspaces()
      .then(setWorkspaces)
      .catch((loadError) => setError(errorMessage(loadError)))
  }, [])

  async function selectWorkspace(workspaceId: number) {
    if (workspaceId === user.workspaceId || busy) return
    setBusy(true)
    setError('')
    try {
      await switchWorkspace(workspaceId)
      window.location.reload()
    } catch (switchError) {
      setError(errorMessage(switchError))
      setBusy(false)
    }
  }

  async function submitWorkspace() {
    const workspaceName = name.trim()
    if (!workspaceName || busy) return
    setBusy(true)
    setError('')
    try {
      await createWorkspace(workspaceName)
      window.location.reload()
    } catch (createError) {
      setError(errorMessage(createError))
      setBusy(false)
    }
  }

  return (
    <div className="workspace-switcher">
      <div className="flex items-center gap-1">
        <Building2 className="hidden size-4 text-zinc-400 sm:block" />
        <select
          aria-label="工作区"
          className="workspace-select"
          disabled={busy}
          onChange={(event) => void selectWorkspace(Number(event.target.value))}
          value={user.workspaceId}
        >
          {workspaces.length ? workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          )) : <option value={user.workspaceId}>当前工作区</option>}
        </select>
        <Button
          aria-label="新建工作区"
          disabled={busy}
          onClick={() => setCreating((current) => !current)}
          size="icon"
          title="新建工作区"
          variant="ghost"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
        </Button>
      </div>

      {creating ? (
        <div className="workspace-create-popover">
          <Input
            aria-label="工作区名称"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitWorkspace()
              if (event.key === 'Escape') setCreating(false)
            }}
            placeholder="工作区名称"
            value={name}
          />
          <Button aria-label="创建工作区" disabled={!name.trim() || busy} onClick={() => void submitWorkspace()} size="icon" title="创建工作区">
            <Check />
          </Button>
          <Button aria-label="取消" onClick={() => setCreating(false)} size="icon" title="取消" variant="ghost"><X /></Button>
        </div>
      ) : null}

      {error ? <div className="workspace-switcher-error">{error}</div> : null}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '工作区操作失败。'
}
