'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'

interface NavItem { href: string; label: string; adminOnly?: boolean }

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',       label: 'Dashboard'  },
  { href: '/operations',      label: 'Operations', adminOnly: true },
  { href: '/team',            label: 'Team',       adminOnly: true },
  { href: '/handover-puzzle', label: 'Handover'    },
  { href: '/youtube',         label: 'Videos'      },
  { href: '/admin',           label: 'Admin',      adminOnly: true },
]

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const role = session?.user?.role
  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || ''

  const visibleItems = NAV_ITEMS.filter(item => !item.adminOnly || role === 'admin')

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100vh', overflow: 'hidden' }}>
      <aside style={{ width: 288, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#BF9A6E', borderRight: '3px solid #5A6A10' }}>

        {/* Logo */}
        <div className="p-5 pb-4" style={{ borderBottom: '2.5px solid #7A8C1E' }}>
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/athena-orange-logo.png" alt="Athena" style={{ height: 40, width: 'auto', objectFit: 'contain' }} />
            <div>
              <p className="font-extrabold text-base leading-tight" style={{ color: '#2A1F08' }}>Signal</p>
              <p className="font-bold text-xs" style={{ color: '#5A6A10' }}>Smartsheet Management</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1.5">
          {visibleItems.map(item => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link key={item.href} href={item.href}>
                <div className="flex items-center px-4 py-2.5 rounded-xl font-bold text-sm transition-all"
                  style={active
                    ? { background: '#7A8C1E', color: '#fff', border: '2px solid #5A6A10' }
                    : { color: '#2A1F08', opacity: 0.85 }}>
                  {item.label}
                </div>
              </Link>
            )
          })}
        </nav>

        {/* User info + Sign out */}
        <div className="p-4" style={{ borderTop: '2px solid #7A8C1E' }}>
          {userName && (
            <p className="text-xs font-semibold mb-2 truncate" style={{ color: '#2A1F08', opacity: 0.7 }}>
              {userName}
              {role && (
                <span style={{
                  marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                  background: role === 'admin' ? '#FEF3C7' : '#E0E7FF',
                  color: role === 'admin' ? '#92400E' : '#3730A3',
                }}>
                  {role}
                </span>
              )}
            </p>
          )}
          <button onClick={() => signOut({ callbackUrl: '/login' })}
            className="text-xs font-bold opacity-50 hover:opacity-100 transition-opacity"
            style={{ color: '#2A1F08' }}>
            Sign out →
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {children}
      </main>
    </div>
  )
}
