import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export default async function RootPage() {
  if (process.env.SKIP_AUTH === 'true') redirect('/dashboard')
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')
  if (session.user.role === 'admin' || session.user.role === 'moderator') redirect('/dashboard')
  redirect('/handover')
}
