'use client'
import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'

function SIcon({ d, size = 17 }: { d: string | string[]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {Array.isArray(d)
        ? d.map((p, i) => <path key={i} d={p} />)
        : <path d={d} />}
    </svg>
  )
}

const ICONS: Record<string, string | string[]> = {
  grid:   'M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z',
  pulse:  'M3 12h4l2 6 4-14 2 8h6',
  users:  ['M16 18v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6', 'M22 18v-2a4 4 0 0 0-3-3.9', 'M16 2.1A4 4 0 0 1 16 10'],
  swap:   'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  video:  'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  clipboard: ['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z'],
  table:  ['M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18'],
}

interface NavItem { href: string; label: string; icon: keyof typeof ICONS; adminOnly?: boolean; roles?: string[]; children?: { href: string; label: string }[] }

const NAV_ITEMS: NavItem[] = [
  { href: '/smartsheet',      label: 'Smartsheet',  icon: 'table',  adminOnly: true, children: [
    { href: '/dashboard',       label: 'Dashboard' },
    { href: '/operations',      label: 'Operations' },
    { href: '/team',            label: 'Team' },
    { href: '/handover-puzzle', label: 'Handover' },
  ]},
  { href: '/evaluations',     label: 'Evaluations', icon: 'clipboard', children: [
    { href: '/evaluations?cat=puzzle', label: 'Puzzle' },
    { href: '/evaluations?cat=arcade', label: 'Arcade' },
    { href: '/evaluations?cat=simulation', label: 'Simulation' },
  ]},
  { href: '/youtube',         label: 'Videos',     icon: 'video',  roles: ['admin', 'moderator', 'evaluator'], children: [
    { href: '/youtube?tab=youtube', label: 'YouTube' },
    { href: '/youtube?tab=short_list', label: 'Short List' },
    { href: '/youtube?tab=record_video', label: 'Record Video' },
  ]},
  { href: '/admin',           label: 'Admin',      icon: 'shield', adminOnly: true },
]

// useSearchParams requires a Suspense boundary for static prerendering.
export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <ManagerLayoutInner>{children}</ManagerLayoutInner>
    </Suspense>
  )
}

function ManagerLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { data: session } = useSession()
  const role     = session?.user?.role
  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || ''
  const initials = userName.split(' ').map((s: string) => s[0] ?? '').join('').slice(0, 2).toUpperCase() || 'U'

  const visibleItems = NAV_ITEMS.filter(item => {
    if (item.roles) return item.roles.includes(role ?? '')
    if (item.adminOnly) return role === 'admin' || role === 'moderator'
    return true
  })

  return (
    <div className="app">
      <aside className="sb">
        {/* Brand */}
        <div className="sb-brand">
          <div className="sb-mark"><span /></div>
          <div>
            <p className="sb-name">Signal</p>
            <p className="sb-tag">Smartsheet Ops</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="sb-nav">
          {[
            { section: 'Workspace', items: visibleItems.filter(i => i.href !== '/admin') },
            { section: 'System', items: visibleItems.filter(i => i.href === '/admin') },
          ].filter(g => g.items.length > 0).map(group => (
            <div key={group.section}>
              <div className="sb-section">{group.section}</div>
              {group.items.map(item => {
                const childPaths = item.children?.map(c => new URL(c.href, 'http://x').pathname) ?? []
                const childActive = childPaths.some(cp => pathname === cp || pathname.startsWith(cp + '/'))
                const selfActive = pathname === item.href || pathname.startsWith(item.href + '/')
                const currentCat = searchParams.get('cat') || 'puzzle'
                // Parent of an active child gets accent text only — the child's
                // pill carries the highlight, keeping one level visually "selected".
                const itemClass = item.children
                  ? 'sb-item' + ((selfActive || childActive) ? ' parent-active' : '')
                  : 'sb-item' + (selfActive ? ' active' : '')
                return (
                  <div key={item.href} className="sb-group">
                    <Link href={item.children ? item.children[0].href : item.href} className={itemClass}>
                      <span className="sb-ico">
                        <SIcon d={ICONS[item.icon]} size={17} />
                      </span>
                      <span>{item.label}</span>
                    </Link>
                    {item.children && (
                      <div className="sb-children">
                        {item.children.map(sub => {
                          const subUrl = new URL(sub.href, 'http://x')
                          const subPath = subUrl.pathname
                          const subCat = subUrl.searchParams.get('cat') || ''
                          const subTab = subUrl.searchParams.get('tab') || ''
                          const currentTab = searchParams.get('tab') || ''
                          const subActive = subCat
                            ? currentCat === subCat && pathname.startsWith(item.href)
                            : subTab
                              ? currentTab === subTab && pathname.startsWith(item.href)
                              : pathname === subPath || pathname.startsWith(subPath + '/')
                          return (
                            <Link key={sub.href} href={sub.href}
                              className={'sb-sub' + (subActive ? ' active' : '')}>
                              {sub.label}
                            </Link>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="sb-foot">
          <div className="sb-user">
            <div className="sb-avatar">{initials}</div>
            <div>
              <p className="sb-user-name">{userName}</p>
              <p className="sb-user-role">{role ?? 'user'} · signal</p>
            </div>
          </div>
          <button className="btn btn-sm btn-ghost"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => signOut({ callbackUrl: '/login' })}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="content">
        {children}
      </div>
    </div>
  )
}
