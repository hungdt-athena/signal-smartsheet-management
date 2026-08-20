import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isManagerRole } from '@/lib/roles'

export default async function RootPage() {
  if (process.env.SKIP_AUTH === 'true') redirect('/team-ops?tab=assign')
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')
  if (isManagerRole(session.user.role)) redirect('/team-ops?tab=assign')
  // Evaluators (and any non-manager role) land on Evaluate — the first page
  // visible in their sidebar. Must stay in sync with the middleware fallback.
  redirect('/evaluations')
}
