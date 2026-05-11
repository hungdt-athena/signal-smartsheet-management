'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'

const NAV_ITEMS = [
  { href: '/dashboard',  label: 'Dashboard',  locked: false },
  { href: '/operations', label: 'Operations', locked: false },
  { href: '/team',       label: 'Team',       locked: false },
  { href: '/youtube',    label: 'Videos',     locked: false },
]

export default function ManagerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

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
          {NAV_ITEMS.map(item => {
            const active = pathname === item.href
            if (item.locked) {
              return (
                <div key={item.href}
                  className="flex items-center justify-between px-4 py-2.5 rounded-xl font-bold text-sm cursor-not-allowed"
                  style={{ color: '#2A1F08', opacity: 0.35 }}>
                  <span>{item.label}</span>
                  <span className="text-xs font-extrabold px-1.5 py-0.5 rounded" style={{ background: '#8B6A3E', color: '#F5EDD8', fontSize: '0.6rem', letterSpacing: '0.05em' }}>SOON</span>
                </div>
              )
            }
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

        {/* Sign out */}
        <div className="p-4" style={{ borderTop: '2px solid #7A8C1E' }}>
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
