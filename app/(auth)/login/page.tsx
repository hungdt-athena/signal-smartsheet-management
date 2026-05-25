'use client'
import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Your account is not authorized. Contact your admin.',
  domain: 'Only @athena.studio accounts are allowed.',
  default: 'Sign-in failed. Please try again.',
}

function LoginForm() {
  const params = useSearchParams()
  const error = params.get('error')
  const errorMsg = error ? (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.default) : null

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#F5EDD8' }}>
      <div style={{ background: '#FAF5EC', border: '2px solid #D4C4A0', borderRadius: 12, padding: 32, width: '100%', maxWidth: 380, boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
        <div className="flex items-center gap-3 mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo/athena-orange-logo.png" alt="Athena" style={{ height: 36, width: 'auto' }} />
          <div>
            <h1 className="font-extrabold text-lg" style={{ color: '#2A1F08' }}>Signal</h1>
            <p className="font-bold text-xs" style={{ color: '#5A6A10' }}>Smartsheet Management</p>
          </div>
        </div>
        {errorMsg && (
          <p style={{ fontSize: 12, color: '#b91c1c', background: '#FEE2E2', padding: '8px 12px', borderRadius: 8, marginBottom: 16, fontWeight: 600 }}>
            {errorMsg}
          </p>
        )}
        <button
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: '#5A3E1B', color: '#fff', border: 'none', borderRadius: 8,
            padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity="0.8"/>
            <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" opacity="0.6"/>
            <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" opacity="0.9"/>
          </svg>
          Sign in with Google
        </button>
        <p style={{ fontSize: 10, color: '#9CA3AF', textAlign: 'center', marginTop: 12 }}>
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
