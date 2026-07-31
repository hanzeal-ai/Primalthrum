import { LockKeyhole } from 'lucide-react'

import type { AuthUser } from '../../api/types'
import { Button } from '../../components/ui/button'
import { WorkspaceAppShell, type WorkspaceAppSection } from './WorkspaceAppShell'

interface WorkspaceAccessDeniedPageProps {
  active: WorkspaceAppSection
  onLogout: () => Promise<void>
  user: AuthUser
}

export function WorkspaceAccessDeniedPage({ active, onLogout, user }: WorkspaceAccessDeniedPageProps) {
  return (
    <WorkspaceAppShell
      active={active}
      description="当前 Workspace 角色不包含此权限"
      onLogout={onLogout}
      title="访问受限"
      user={user}
    >
      <section className="mx-auto grid min-h-[60vh] max-w-lg place-items-center text-center">
        <div>
          <span className="mx-auto grid size-11 place-items-center rounded-md bg-zinc-200 text-zinc-700"><LockKeyhole className="size-5" /></span>
          <h2 className="mt-5 text-xl font-semibold">你没有账单读取权限</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-500">请联系 Workspace Owner 调整角色，或返回 Agent 创建页面继续工作。</p>
          <Button asChild className="mt-6"><a href="/app">返回 Agent</a></Button>
        </div>
      </section>
    </WorkspaceAppShell>
  )
}
