'use client'
import { signOut } from 'next-auth/react'
import { useSession } from 'next-auth/react'

export default function EvaluatorLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession()

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '0 24px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7, background: 'var(--accent)',
            display: 'grid', placeItems: 'center',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />
          </div>
          <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em' }}>Signal</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>{session?.user?.name}</span>
          <button className="btn btn-sm btn-ghost"
            onClick={() => signOut({ callbackUrl: '/login' })}>
            Sign out
          </button>
        </div>
      </header>
      <main style={{ maxWidth: 540, margin: '0 auto', padding: '32px 24px' }}>{children}</main>
    </div>
  )
}
