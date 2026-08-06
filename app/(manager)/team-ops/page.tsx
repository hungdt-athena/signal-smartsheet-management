'use client'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { AssignSetup } from '@/components/AssignSetup'
import { AssignHistory } from '@/components/AssignHistory'
import { ReassignPanel } from '@/components/ReassignPanel'
import { HandoverPanel } from '@/components/HandoverPanel'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import { ReportView } from '@/components/report/ReportView'

type Tab = 'assign' | 'reassign' | 'handover' | 'performance'
const TABS: { value: Tab; pageTitle: string }[] = [
  { value: 'assign', pageTitle: 'Assign' },
  { value: 'reassign', pageTitle: 'Reassign' },
  { value: 'handover', pageTitle: 'Handover' },
]
const BUCKET_LABELS: Record<Bucket, string> = { puzzle: 'Puzzle', arcade: 'Arcade', simulation: 'Simulation' }

export default function TeamOpsPage() {
  return (
    <Suspense>
      <TeamOpsInner />
    </Suspense>
  )
}

function TeamOpsInner() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  // Evaluators see all three ops tabs, but Reassign is read-only for them (history
  // scoped to runs they're involved in — see ReassignPanel). Performance (the
  // evaluator report) is admin-only — /api/report enforces the same guard;
  // 'unauthenticated' only happens under SKIP_AUTH local dev.
  const allowed: Tab[] = ['assign', 'reassign', 'handover']
  if (session?.user?.role === 'admin' || status === 'unauthenticated') allowed.push('performance')
  const tab = (searchParams.get('tab') as Tab) || 'assign'
  const active: Tab = allowed.includes(tab) ? tab : 'assign'

  // don't flash the wrong tab while the session (and thus the role) is loading
  if (tab === 'performance' && status === 'loading') return null
  // Performance renders its own page chrome (header, filters, sub-tabs)
  if (active === 'performance') return <ReportView />

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">{TABS.find(t => t.value === active)?.pageTitle ?? 'Team Operations'}</h1>
      </div>

      {active === 'assign' && <AssignTab />}
      {active === 'reassign' && <ReassignPanel />}
      {active === 'handover' && <HandoverPanel />}
    </div>
  )
}

// Assign tab: per-bucket roster (left, 60%) + assignment history (right, 40%).
// Evaluators see a read-only view scoped to their own Initial-list row.
function AssignTab() {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const userName = session?.user?.name || ''
  const [bucket, setBucket] = useState<Bucket>('puzzle')
  return (
    <div>
      <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
        {BUCKETS.map(b => (
          <button key={b} className={`seg-btn-premium${bucket === b ? ' active' : ''}`} onClick={() => setBucket(b)}>
            {BUCKET_LABELS[b]}
          </button>
        ))}
      </div>
      <div className="assign-grid">
        <AssignSetup bucket={bucket} isEvaluator={isEvaluator} userName={userName} />
        <div className="assign-right">
          <AssignHistory bucket={bucket} />
        </div>
      </div>
    </div>
  )
}
