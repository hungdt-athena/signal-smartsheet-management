'use client'
import { Suspense, useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { AssignSetup } from '@/components/AssignSetup'
import { AssignHistory } from '@/components/AssignHistory'
import { ReassignPanel } from '@/components/ReassignPanel'
import { RescuePanel } from '@/components/RescuePanel'
import { HandoverPanel } from '@/components/HandoverPanel'
import { ReportView } from '@/components/report/ReportView'
import { PageHeader } from '@/components/ui/PageHeader'
import { isBucket, type Bucket } from '@/lib/buckets'
import { parseAssignedRange, type AssignedRange } from '@/lib/rescue-range'
import { useSetUrlParams } from '@/lib/use-url-state'

type Tab = 'assign' | 'reassign' | 'rescue' | 'handover' | 'performance'
type OpsTab = Exclude<Tab, 'performance'>

// Title = the sidebar label. One line under it says what the tab is for; an
// evaluator reads a different line where their view is history only.
const HEADERS: Record<OpsTab, { title: string; sub: string; subEvaluator: string }> = {
  assign: {
    title: 'Assign',
    sub: 'Who receives new games, and what the next run would hand out.',
    subEvaluator: 'Your roster rows: category groups, weight and availability.',
  },
  reassign: {
    title: 'Reassign',
    sub: 'Move pending games from one evaluator to others.',
    subEvaluator: 'Reassign runs that moved games to or from you.',
  },
  rescue: {
    title: 'Rescue',
    sub: 'Move games that waited too long to evaluators who keep up.',
    subEvaluator: 'Rescue runs that moved games to or from you.',
  },
  handover: {
    title: 'Handover',
    sub: 'Send an evaluator\'s pending games to the team while they are away.',
    subEvaluator: 'Send your pending games to the team while you are away.',
  },
}

export default function TeamOpsPage() {
  return (
    <Suspense>
      <TeamOpsInner />
    </Suspense>
  )
}

function TeamOpsInner() {
  const searchParams = useSearchParams()
  const setUrl = useSetUrlParams()
  const { data: session } = useSession()
  // Every role that reaches this page sees every tab. For evaluators the views are
  // scoped, and the scoping lives in the APIs, not here:
  //   Assign      → their own roster rows (see AssignTab).
  //   Reassign    → history only: runs they were in, as source or receiver.
  //   Rescue      → the same, for rescue runs. The scan and its actions stay
  //                 admin-only in /api/operations/rescue; the panel never calls them.
  //   Handover    → their own requests.
  //   Performance → /api/report returns only their own row, so ReportView shows
  //                 the Individual tab alone.
  // Keep in step with evaluatorTabs in middleware.ts and the sidebar in layout.tsx.
  const isEvaluator = session?.user?.role === 'evaluator'
  const allowed: Tab[] = ['assign', 'reassign', 'rescue', 'handover', 'performance']
  const tab = (searchParams.get('tab') as Tab) || 'assign'
  const active: Tab = allowed.includes(tab) ? tab : 'assign'

  // Same shape as the Config page's ?highlight= (app/(manager)/config/page.tsx): a
  // link may say WHICH rows it meant, never what the tool's settings should be.
  const flash = (searchParams.get('flash') || '').split(',').map(s => s.trim()).filter(Boolean)
  const fromParam = searchParams.get('from') || undefined
  // The category group on screen lives in ?cat=, so reload, Back and a link from
  // the Report all open the same genre. A category picks the view, the way `tab`
  // does, and is never written back to app_config — so it may travel in a URL where
  // a Rescue THRESHOLD may not. Anything that is not a bucket falls back to Puzzle
  // rather than opening on a genre nobody asked for.
  const catParam = searchParams.get('cat')
  const category: Bucket = isBucket(catParam) ? catParam : 'puzzle'
  // Same reasoning as the category: a range picks which games the screen is about and
  // is never saved, so it lives in the URL. A malformed one is dropped, not repaired.
  const parsedRange = parseAssignedRange(searchParams.get('assignedFrom'), searchParams.get('assignedTo'))
  const rFrom = parsedRange.ok ? parsedRange.range?.from ?? null : null
  const rTo = parsedRange.ok ? parsedRange.range?.to ?? null : null
  // Rebuilt only when a day changes, so the panel's load effect does not refire.
  const range = useMemo<AssignedRange | null>(
    () => (rFrom || rTo ? { from: rFrom, to: rTo } : null),
    [rFrom, rTo],
  )
  // "Show all backlog" clears it from the URL, so reload and Back agree with the screen.
  const clearRange = useCallback(() => setUrl({ assignedFrom: null, assignedTo: null }), [setUrl])
  // Switching genre also drops ?from= and ?flash=: both named people in the genre
  // the link was about, and would preselect or ring them in the new one.
  const setCategory = useCallback((b: Bucket) => {
    setUrl({ cat: b === 'puzzle' ? null : b, from: null, flash: null })
  }, [setUrl])

  // Performance renders its own page chrome (header, filters, sub-tabs)
  if (active === 'performance') return <ReportView />

  const head = HEADERS[active]
  return (
    <div className="page">
      <PageHeader title={head.title} sub={isEvaluator ? head.subEvaluator : head.sub} />

      {active === 'assign' && <AssignTab />}
      {active === 'reassign' && (
        <ReassignPanel initialFrom={fromParam} category={category} onCategoryChange={setCategory} />
      )}
      {active === 'rescue' && <RescuePanel flash={flash} category={category} onCategoryChange={setCategory} range={range} onClearRange={clearRange} />}
      {active === 'handover' && <HandoverPanel category={category} onCategoryChange={setCategory} />}
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

  // A fragment, not a wrapper: .page's gap spaces the two.
  return (
    <>
      <AssignSetup isEvaluator={isEvaluator} userName={userName} onRosterNames={onRosterNames} />
      <AssignHistory rosterNames={rosterNames} />
    </>
  )
}
