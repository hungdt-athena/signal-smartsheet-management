'use client'
import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Your account is not authorized. Contact your admin.',
  domain: 'Only @athena.studio accounts are allowed.',
  server: 'Server is temporarily unavailable. Please try again later.',
  default: 'Sign-in failed. Please try again.',
}

function LoginForm() {
  const params = useSearchParams()
  const error = params.get('error')
  const errorMsg = error ? (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.default) : null

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16,
        padding: 32, width: '100%', maxWidth: 380,
        boxShadow: 'var(--shadow-md)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9, background: 'var(--accent)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
            boxShadow: '0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent)',
          }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff' }} />
          </div>
          <div>
            <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Signal</h1>
            <p style={{ fontSize: 12, color: 'var(--faint)', margin: 0, marginTop: 2 }}>Smartsheet Management</p>
          </div>
        </div>

        {errorMsg && (
          <div style={{
            fontSize: 13, color: 'var(--bad)', background: 'var(--bad-weak)',
            border: '1px solid color-mix(in srgb, var(--bad) 25%, transparent)',
            padding: '10px 12px', borderRadius: 8, marginBottom: 16, fontWeight: 500,
          }}>
            {errorMsg}
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', fontSize: 13 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" opacity=".9"/>
            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity=".7"/>
            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" opacity=".5"/>
            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" opacity=".8"/>
          </svg>
          Sign in with Google
        </button>

        <p style={{ fontSize: 11, color: 'var(--faint)', textAlign: 'center', marginTop: 14 }}>
          Only @athena.studio accounts
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
