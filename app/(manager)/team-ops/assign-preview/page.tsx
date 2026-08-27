// Page GIẢ LẬP để xem layout Assign một trang trước khi đụng API thật.
// Không fetch, không ghi DB. Xoá page này và fixture.ts khi Assign thật xong.
'use client'
import { useMemo, useState } from 'react'
import { RosterTable, BUCKET_LABELS } from '@/components/RosterTable'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { groupRosterByPerson } from '@/lib/assign-roster'
import { buildMatrix } from '@/lib/assign-history-matrix'
import { BUCKETS, type Bucket } from '@/lib/buckets'
import {
  FIXTURE_INITIAL, FIXTURE_FINAL, FIXTURE_SUB_GENRES, FIXTURE_HISTORY, FIXTURE_WINDOW,
} from './fixture'

const noop = () => {}

export default function AssignPreviewPage() {
  const [genre, setGenre] = useState<Bucket | 'all'>('all')

  const initial = useMemo(
    () => groupRosterByPerson(FIXTURE_INITIAL.filter(r => genre === 'all' || r.category_group === genre)),
    [genre],
  )
  const final = useMemo(
    () => groupRosterByPerson(FIXTURE_FINAL.filter(r => genre === 'all' || r.category_group === genre)),
    [genre],
  )
  const matrix = useMemo(() => buildMatrix({
    ...FIXTURE_WINDOW,
    rows: FIXTURE_HISTORY.filter(r => genre === 'all' || r.category_group === genre),
    rosterNames: Array.from(new Set(FIXTURE_INITIAL.map(r => r.name))),
  }), [genre])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h-title">Assign · preview (fixture)</h1>
      </div>
      <div className="seg-wrapper" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
        {(['all', ...BUCKETS] as const).map(g => (
          <button key={g} className={`seg-btn-premium${genre === g ? ' active' : ''}`} onClick={() => setGenre(g)}>
            {g === 'all' ? 'All' : BUCKET_LABELS[g]}
          </button>
        ))}
      </div>
      <RosterTable title="Initial Evaluator" groups={initial} subGenres={FIXTURE_SUB_GENRES}
        onPatchRow={noop} onPatchAvailable={noop} onRemoveRow={noop} onAddGenre={noop} onAddEvaluator={noop} />
      <div style={{ height: 14 }} />
      <RosterTable title="Final Evaluator" groups={final} subGenres={FIXTURE_SUB_GENRES}
        onPatchRow={noop} onPatchAvailable={noop} onRemoveRow={noop} onAddGenre={noop} onAddEvaluator={noop} />
      <div style={{ height: 18 }} />
      <div className="card">
        <div className="card-head"><span className="card-label">History · 14 ngày</span></div>
        <AssignHistoryMatrix matrix={matrix} />
      </div>
    </div>
  )
}
