'use client'
import { signOut } from 'next-auth/react'
import { useSession } from 'next-auth/react'

export default function EvaluatorLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-3 flex justify-between items-center">
        <h1 className="font-bold text-gray-900">Signal</h1>
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>{session?.user?.name}</span>
          <button onClick={() => signOut({ callbackUrl: '/login' })} className="hover:text-gray-700">Sign out</button>
        </div>
      </header>
      <main className="max-w-xl mx-auto p-6">{children}</main>
    </div>
  )
}
