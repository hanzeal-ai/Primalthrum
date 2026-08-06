import {
  Building2,
  ClipboardList,
  Headphones,
  LayoutDashboard,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserCog,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { OperatorAuditSection } from './OperatorAuditSection'
import {
  getOperatorOverview,
  getSupportContext,
  listOperatorAudit,
  listOperators,
  listOperatorWorkspaces,
  listSupportGrants,
} from './operatorClient'
import { operatorRoleLabel } from './operatorFormatters'
import { OperatorOverviewSection } from './OperatorOverviewSection'
import {
  canManageSupport,
  operatorSectionAllowed,
  type OperatorSection,
} from './operatorPermissions'
import { OperatorSupportSection } from './OperatorSupportSection'
import type {
  OperatorAuditRecord,
  OperatorOverviewResponse,
  OperatorRole,
  OperatorUser,
  OperatorWorkspaceSummary,
  SupportAccessGrant,
} from './operatorTypes'
import { OperatorUsersSection } from './OperatorUsersSection'
import { OperatorWorkspacesSection } from './OperatorWorkspacesSection'

const NAV_ITEMS = [
  { key: 'overview', label: '概览', icon: LayoutDashboard },
  { key: 'workspaces', label: 'Workspaces', icon: Building2 },
  { key: 'support', label: '支持访问', icon: Headphones },
  { key: 'operators', label: 'Operators', icon: UserCog },
  { key: 'audit', label: '审计', icon: ClipboardList },
] as const

interface OperatorConsolePageProps {
  onLogout: () => Promise<void>
  user: OperatorUser
}

export function OperatorConsolePage({ onLogout, user }: OperatorConsolePageProps) {
  const [section, setSection] = useState<OperatorSection>(sectionFromUrl(user.role))
  const [overview, setOverview] = useState<OperatorOverviewResponse | null>(null)
  const [workspaces, setWorkspaces] = useState<OperatorWorkspaceSummary[]>([])
  const [operators, setOperators] = useState<OperatorUser[]>([])
  const [grants, setGrants] = useState<SupportAccessGrant[]>([])
  const [audit, setAudit] = useState<OperatorAuditRecord[]>([])
  const [supportContext, setSupportContext] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  const loadSection = useCallback(async (target: OperatorSection) => {
    setBusy(true)
    setError('')
    try {
      if (target === 'overview') setOverview(await getOperatorOverview())
      if (target === 'workspaces') setWorkspaces(await listOperatorWorkspaces())
      if (target === 'operators') setOperators(await listOperators())
      if (target === 'audit') setAudit(await listOperatorAudit())
      if (target === 'support') {
        const [loadedGrants, loadedWorkspaces, loadedOperators] = await Promise.all([
          listSupportGrants(),
          canManageSupport(user.role) ? listOperatorWorkspaces() : Promise.resolve([]),
          canManageSupport(user.role) ? listOperators() : Promise.resolve([]),
        ])
        setGrants(loadedGrants)
        setWorkspaces(loadedWorkspaces)
        setOperators(loadedOperators)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '运营数据加载失败')
    } finally {
      setBusy(false)
    }
  }, [user.role])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSection(section) }, 0)
    return () => window.clearTimeout(timer)
  }, [loadSection, section])

  function navigate(target: OperatorSection) {
    setSection(target)
    setSupportContext(null)
    window.history.replaceState(null, '', `/operator?view=${target}`)
  }

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="hidden min-h-screen border-r bg-zinc-950 px-4 py-5 text-zinc-100 lg:flex lg:flex-col">
        <a className="flex items-center gap-3 px-2 text-sm font-semibold" href="/operator">
          <span className="grid size-8 place-items-center rounded-md bg-blue-500 text-white"><ShieldCheck className="size-4" /></span>
          Primalthrum Ops
        </a>
        <nav aria-label="Operator 导航" className="mt-8 grid gap-1">
          {NAV_ITEMS.filter((item) => operatorSectionAllowed(user.role, item.key)).map((item) => (
            <OperatorNavItem active={section === item.key} item={item} key={item.key} onSelect={navigate} />
          ))}
        </nav>
        <div className="mt-auto border-t border-zinc-800 pt-4">
          <p className="truncate px-2 text-xs font-medium" title={user.email}>{user.email}</p>
          <p className="mt-1 px-2 text-xs text-zinc-400">{operatorRoleLabel(user.role)}</p>
          <Button className="mt-3 w-full justify-start text-zinc-300 hover:bg-zinc-800 hover:text-white" onClick={() => void onLogout()} variant="ghost">
            <LogOut />退出登录
          </Button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
          <div className="flex min-h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <a aria-label="Primalthrum Operator" className="grid size-8 place-items-center rounded-md bg-zinc-950 text-white lg:hidden" href="/operator">
              <ShieldCheck className="size-4" />
            </a>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">{NAV_ITEMS.find((item) => item.key === section)?.label}</h1>
              <p className="hidden truncate text-xs text-zinc-500 sm:block">平台运营控制面</p>
            </div>
            <Badge variant="outline">{operatorRoleLabel(user.role)}</Badge>
            <Button aria-label="刷新" onClick={() => void loadSection(section)} size="icon" title="刷新" variant="ghost">
              <RefreshCw />
            </Button>
          </div>
          <nav aria-label="移动端 Operator 导航" className="flex gap-1 overflow-x-auto border-t px-3 py-2 lg:hidden">
            {NAV_ITEMS.filter((item) => operatorSectionAllowed(user.role, item.key)).map((item) => (
              <OperatorNavItem active={section === item.key} compact item={item} key={item.key} onSelect={navigate} />
            ))}
          </nav>
        </header>

        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {error && <div className="mb-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</div>}
          {busy ? (
            <div className="flex min-h-64 items-center justify-center gap-3 text-sm text-zinc-500">
              <Loader2 className="animate-spin" />正在加载
            </div>
          ) : (
            <OperatorSection
              audit={audit}
              grants={grants}
              onContext={async (grantId) => {
                try {
                  setSupportContext((await getSupportContext(grantId)).context)
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : '支持上下文加载失败')
                }
              }}
              onReload={() => loadSection(section)}
              operators={operators}
              overview={overview}
              section={section}
              supportContext={supportContext}
              user={user}
              workspaces={workspaces}
            />
          )}
        </div>
      </div>
    </main>
  )
}

function OperatorSection(props: {
  audit: OperatorAuditRecord[]
  grants: SupportAccessGrant[]
  onContext: (grantId: number) => Promise<void>
  onReload: () => Promise<void>
  operators: OperatorUser[]
  overview: OperatorOverviewResponse | null
  section: OperatorSection
  supportContext: Record<string, unknown> | null
  user: OperatorUser
  workspaces: OperatorWorkspaceSummary[]
}) {
  if (props.section === 'overview') return <OperatorOverviewSection data={props.overview} />
  if (props.section === 'workspaces') return <OperatorWorkspacesSection workspaces={props.workspaces} />
  if (props.section === 'support') return <OperatorSupportSection {...props} />
  if (props.section === 'operators') return <OperatorUsersSection {...props} />
  return <OperatorAuditSection events={props.audit} />
}

function OperatorNavItem({ active, compact = false, item, onSelect }: {
  active: boolean
  compact?: boolean
  item: typeof NAV_ITEMS[number]
  onSelect: (section: OperatorSection) => void
}) {
  const Icon = item.icon
  const colors = active
    ? compact ? 'bg-zinc-100 text-zinc-950' : 'bg-zinc-800 text-white'
    : compact ? 'text-zinc-600 hover:bg-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2 rounded-md text-sm font-medium transition-colors ${compact ? 'h-9 shrink-0 px-3' : 'h-10 px-3'} ${colors}`}
      onClick={() => onSelect(item.key)}
      type="button"
    >
      <Icon className="size-4" />{item.label}
    </button>
  )
}

function sectionFromUrl(role: OperatorRole): OperatorSection {
  const candidate = new URLSearchParams(window.location.search).get('view') as OperatorSection | null
  return candidate && operatorSectionAllowed(role, candidate) ? candidate : 'overview'
}
