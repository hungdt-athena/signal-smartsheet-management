import { redirect } from 'next/navigation'
import { isManagerRole } from '@/lib/roles'
import { getSession } from '@/lib/session'

export default async function RootPage() {
  if (process.env.SKIP_AUTH === 'true') redirect('/team-ops?tab=assign')
  const session = await getSession()
  if (!session) redirect('/login')
  if (isManagerRole(session.user.role)) redirect('/team-ops?tab=assign')
  // Evaluators (and any non-manager role) land on Evaluate — the first page
  // visible in their sidebar. Must stay in sync with the middleware fallback.
  redirect('/evaluations')
}
