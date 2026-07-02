'use client'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AssignSetup } from '@/components/AssignSetup'
import { AssignHistory } from '@/components/AssignHistory'
import { ReassignPanel } from '@/components/ReassignPanel'
import { HandoverPanel } from '@/components/HandoverPanel'
import { BUCKETS, type Bucket } from '@/lib/buckets'

type Tab = 'assign' | 'reassign' | 'handover'
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
  const tab = (searchParams.get('tab') as Tab) || 'assign'
  const isTab = TABS.some(t => t.value === tab)
  const active: Tab = isTab ? tab : 'assign'

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

// Assign tab: per-bucket roster (top) + assignment history (below).
function AssignTab() {
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
      <AssignSetup bucket={bucket} />
      <AssignHistory bucket={bucket} />
    </div>
  )
}
