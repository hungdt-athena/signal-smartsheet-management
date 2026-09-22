'use client'
import { Suspense, useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { AssignSetup } from '@/components/AssignSetup'
import { AssignHistory } from '@/components/AssignHistory'
import { ReassignPanel } from '@/components/ReassignPanel'
import { RescuePanel } from '@/components/RescuePanel'
import { HandoverPanel } from '@/components/HandoverPanel'
import { ReportView } from '@/components/report/ReportView'
import { isBucket } from '@/lib/buckets'

type Tab = 'assign' | 'reassign' | 'rescue' | 'handover' | 'performance'
const TABS: { value: Tab; pageTitle: string }[] = [
  { value: 'assign', pageTitle: 'Assign' },
  { value: 'reassign', pageTitle: 'Reassign' },
  { value: 'rescue', pageTitle: 'Rescue' },
  { value: 'handover', pageTitle: 'Handover' },
]

export default function TeamOpsPage() {
  return (
    <Suspense>
      <TeamOpsInner />
    </Suspense>
  )
}

function TeamOpsInner() {
  const searchParams = useSearchParams()
  const { data: session } = useSession()
  // Every role that reaches this page sees these tabs. Reassign is read-only for
  // evaluators (history scoped to runs they're involved in — see ReassignPanel), and
  // Performance is self-scoped for them: /api/report returns only their own row for
  // that role and ReportView then shows the Individual tab alone. No role check is
  // needed for those — and none should be added, it would only be a third copy of a
  // rule the API already enforces.
  //
  // Rescue is the exception: its whole screen is a side-by-side comparison of every
  // teammate's backlog, so there is no scoped version of it to show an evaluator. The
  // API is admin-only, and the tab is dropped here so they get the default tab rather
  // than a wall of 403s.
  const isEvaluator = session?.user?.role === 'evaluator'
  const allowed: Tab[] = isEvaluator
    ? ['assign', 'reassign', 'handover', 'performance']
    : ['assign', 'reassign', 'rescue', 'handover', 'performance']
  const tab = (searchParams.get('tab') as Tab) || 'assign'
  const active: Tab = allowed.includes(tab) ? tab : 'assign'

  // Same shape as the Config page's ?highlight= (app/(manager)/config/page.tsx): a
  // link may say WHICH rows it meant, never what the tool's settings should be.
  const flash = (searchParams.get('flash') || '').split(',').map(s => s.trim()).filter(Boolean)
  const fromParam = searchParams.get('from') || undefined
  // Which genre the sentence that linked here was read on. A category picks the view,
  // the way `tab` does, and is never written back to app_config — so it may travel in
  // a URL where a Rescue THRESHOLD may not. Validated against the bucket list, and
  // anything else is dropped so the panel keeps its own default rather than opening
  // on a genre nobody asked for.
  const catParam = searchParams.get('cat')
  const initialCategory = isBucket(catParam) ? catParam : undefined

  // Performance renders its own page chrome (header, filters, sub-tabs)
  if (active === 'performance') return <ReportView />

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">{TABS.find(t => t.value === active)?.pageTitle ?? 'Team Operations'}</h1>
      </div>

      {active === 'assign' && <AssignTab />}
      {active === 'reassign' && <ReassignPanel initialFrom={fromParam} initialCategory={initialCategory} />}
      {active === 'rescue' && <RescuePanel flash={flash} initialCategory={initialCategory} />}
      {active === 'handover' && <HandoverPanel />}
    </div>
  )
}

// Assign tab: one page for all three genres, roster on top and history matrix
// below. No genre switcher — every genre a person covers is a row of their own
// group, so there is nothing left for a filter to reveal.
// Evaluators see a read-only view scoped to their own Initial-list rows.
function AssignTab() {
  const { data: session } = useSession()
  const isEvaluator = session?.user?.role === 'evaluator'
  const userName = session?.user?.name || ''
  const [rosterNames, setRosterNames] = useState<string[]>([])
  // Compare before setting: AssignSetup calls this after each of its renders,
  // and setting parent state unconditionally would never stop re-rendering.
  const onRosterNames = useCallback((names: string[]) => {
    setRosterNames(prev => (prev.join('|') === names.join('|') ? prev : names))
  }, [])

  return (
    <div>
      <AssignSetup isEvaluator={isEvaluator} userName={userName} onRosterNames={onRosterNames} />
      <div style={{ height: 18 }} />
      <AssignHistory rosterNames={rosterNames} />
    </div>
  )
}
