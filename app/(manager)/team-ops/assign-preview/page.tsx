// A MOCK page for eyeballing the single-page Assign layout before the real API
// is touched. No fetch, no writes. Delete this page and fixture.ts once done.
'use client'
import { useMemo } from 'react'
import { RosterTable } from '@/components/RosterTable'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { groupRosterByPerson } from '@/lib/assign-roster'
import { buildMatrix } from '@/lib/assign-history-matrix'
import {
  FIXTURE_INITIAL, FIXTURE_FINAL, FIXTURE_SUB_GENRES, FIXTURE_HISTORY, FIXTURE_WINDOW,
} from './fixture'

const noop = () => {}

export default function AssignPreviewPage() {
  const initial = useMemo(() => groupRosterByPerson(FIXTURE_INITIAL), [])
  const final = useMemo(() => groupRosterByPerson(FIXTURE_FINAL), [])
  const matrix = useMemo(() => buildMatrix({
    ...FIXTURE_WINDOW,
    rows: FIXTURE_HISTORY,
    rosterNames: Array.from(new Set(FIXTURE_INITIAL.map(r => r.name))),
  }), [])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Assign · preview (fixture)</h1>
      </div>
      <RosterTable title="Initial Evaluator" groups={initial} subGenres={FIXTURE_SUB_GENRES}
        onPatchRow={noop} onPatchAvailable={noop} onRemoveRow={noop} onAddGenre={noop} onAddEvaluator={noop} />
      <div style={{ height: 14 }} />
      <RosterTable title="Final Evaluator" groups={final} subGenres={FIXTURE_SUB_GENRES}
        onPatchRow={noop} onPatchAvailable={noop} onRemoveRow={noop} onAddGenre={noop} onAddEvaluator={noop} />
      <div style={{ height: 18 }} />
      <div className="card">
        <div className="card-head"><span className="card-label">History · 14 days</span></div>
        <AssignHistoryMatrix matrix={matrix} />
      </div>
    </div>
  )
}
