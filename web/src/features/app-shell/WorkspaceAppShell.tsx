import { BarChart3, CreditCard, LogOut, MessageSquare, Settings, Sparkles, Users } from 'lucide-react'
import type { ReactNode } from 'react'

import type { AuthUser } from '../../api/types'
import { Button } from '../../components/ui/button'
import { canReadBilling } from '../../lib/workspacePermissions'
import { WorkspaceSwitcher } from '../workspaces/WorkspaceSwitcher'

export type WorkspaceAppSection = 'builder' | 'team' | 'usage' | 'billing' | 'settings'

const NAV_ITEMS = [
  { key: 'builder', href: '/app', label: '创建 Agent', icon: MessageSquare },
  { key: 'team', href: '/app/team', label: '团队', icon: Users },
  { key: 'usage', href: '/app/usage', label: '用量', icon: BarChart3 },
  { key: 'billing', href: '/app/billing', label: '账单', icon: CreditCard },
  { key: 'settings', href: '/app/settings', label: '设置', icon: Settings },
] as const

interface WorkspaceAppShellProps {
  active: WorkspaceAppSection
  children: ReactNode
  description: string
  onLogout: () => Promise<void>
  title: string
  user: AuthUser
}

export function WorkspaceAppShell({
  active,
  children,
  description,
  onLogout,
  title,
  user,
}: WorkspaceAppShellProps) {
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950 lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="hidden min-h-screen border-r bg-white px-4 py-5 lg:flex lg:flex-col">
        <a className="flex items-center gap-3 px-2 text-sm font-semibold" href="/app">
          <span className="grid size-8 place-items-center rounded-md bg-blue-600 text-white"><Sparkles className="size-4" /></span>
          Primalthrum
        </a>
        <nav aria-label="Workspace 导航" className="mt-8 grid gap-1">
          {NAV_ITEMS.filter((item) => navigationAllowed(item.key, user)).map((item) => <NavigationItem active={active === item.key} item={item} key={item.key} />)}
        </nav>
        <div className="mt-auto border-t pt-4">
          <p className="truncate px-2 text-xs font-medium text-zinc-700" title={user.email}>{user.email}</p>
          <p className="mt-1 px-2 text-xs capitalize text-zinc-500">{user.role}</p>
          <Button className="mt-3 w-full justify-start" onClick={() => void onLogout()} variant="ghost">
            <LogOut />退出登录
          </Button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
          <div className="flex min-h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <a aria-label="Primalthrum" className="grid size-8 place-items-center rounded-md bg-blue-600 text-white lg:hidden" href="/app">
              <Sparkles className="size-4" />
            </a>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">{title}</h1>
              <p className="hidden truncate text-xs text-zinc-500 sm:block">{description}</p>
            </div>
            <WorkspaceSwitcher user={user} />
          </div>
          <nav aria-label="移动端 Workspace 导航" className="flex gap-1 overflow-x-auto border-t px-3 py-2 lg:hidden">
            {NAV_ITEMS.filter((item) => navigationAllowed(item.key, user)).map((item) => <NavigationItem active={active === item.key} compact item={item} key={item.key} />)}
          </nav>
        </header>
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </div>
      </div>
    </main>
  )
}

function navigationAllowed(section: WorkspaceAppSection, user: AuthUser): boolean {
  return section === 'builder' || section === 'team' || section === 'settings' || canReadBilling(user.role)
}

function NavigationItem({ active, compact = false, item }: {
  active: boolean
  compact?: boolean
  item: typeof NAV_ITEMS[number]
}) {
  const Icon = item.icon
  return (
    <a
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2 rounded-md text-sm font-medium transition-colors ${
        compact ? 'h-9 shrink-0 px-3' : 'h-10 px-3'
      } ${active ? 'bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950'}`}
      href={item.href}
    >
      <Icon className="size-4" />
      {item.label}
    </a>
  )
}
