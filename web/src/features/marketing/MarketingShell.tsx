import { Bot, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../../components/ui/button'
import { usePrivacyConsent } from '../privacy/usePrivacyConsent'

interface MarketingShellProps {
  authenticated?: boolean
  children: ReactNode
}

export function MarketingShell({ authenticated = false, children }: MarketingShellProps) {
  const privacy = usePrivacyConsent()
  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
          <a className="flex items-center gap-2.5 font-semibold" href="/">
            <span className="grid size-8 place-items-center rounded-md bg-zinc-950 text-white">
              <Bot className="size-4" />
            </span>
            Primalthrum
          </a>
          <nav aria-label="主导航" className="hidden items-center gap-6 text-sm text-zinc-600 md:flex">
            <a className="hover:text-zinc-950" href="/#product">产品</a>
            <a className="hover:text-zinc-950" href="/#platform">平台</a>
            <a className="hover:text-zinc-950" href="/pricing">定价</a>
            <a className="hover:text-zinc-950" href="/security">安全</a>
            <a className="hover:text-zinc-950" href="/docs">文档</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {authenticated ? (
              <Button asChild size="sm">
                <a href="/app">打开工作台 <ExternalLink /></a>
              </Button>
            ) : (
              <>
                <Button asChild className="hidden sm:inline-flex" size="sm" variant="ghost">
                  <a href="/login">登录</a>
                </Button>
                <Button asChild size="sm">
                  <a href="/signup?plan=pro">免费试用</a>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>
      {children}
      <footer className="border-t border-zinc-200 bg-zinc-50">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1fr_auto] lg:px-8">
          <div>
            <div className="font-semibold text-zinc-950">Primalthrum</div>
            <p className="mt-2 max-w-md text-zinc-500">从一句需求到可发布、可计费、可治理的生产级 Agent。</p>
          </div>
          <nav aria-label="页脚导航" className="grid grid-cols-2 gap-x-8 gap-y-3 text-zinc-600 sm:grid-cols-5">
            <a href="/status">服务状态</a>
            <a href="/contact">联系我们</a>
            <a href="/legal/privacy">隐私</a>
            <a href="/legal/terms">条款</a>
            <button className="text-left hover:text-zinc-950" onClick={privacy.openPreferences} type="button">Cookie 设置</button>
          </nav>
        </div>
      </footer>
    </div>
  )
}
