// components/AssignHistory.tsx — assignment_history dạng matrix ngày × người.
// Cửa sổ 14 ngày, lùi/tiến bằng ◀ ▶. Số trong ô là assign; reassign/handover
// không bao giờ được cộng vào (game bị reassign đã đếm ở lần assign gốc).
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AssignHistoryMatrix } from '@/components/AssignHistoryMatrix'
import { buildMatrix, shiftWindow, type HistoryRow } from '@/lib/assign-history-matrix'
import type { Bucket } from '@/lib/buckets'

const WINDOW_DAYS = 14

// Cửa sổ mặc định: 14 ngày tính đến hôm nay theo giờ VN.
function defaultWindow(): { from: string; to: string } {
  const vn = new Date(Date.now() + 7 * 3_600_000)
  const to = vn.toISOString().slice(0, 10)
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (WINDOW_DAYS - 1) * 86_400_000)
    .toISOString().slice(0, 10)
  return { from, to }
}

export function AssignHistory({ genre, rosterNames }: { genre: Bucket | 'all'; rosterNames: string[] }) {
  const [win, setWin] = useState(defaultWindow)
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Không truyền `category`: một lần đọc phục vụ cả 3 genre, filter chip lọc ở client.
  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams({ from: win.from, to: win.to, limit: '1000' })
      const res = await fetch(`/api/admin/assignment-history?${qs}`, { cache: 'no-store' })
      if (!res.ok) throw new Error()
      setRows((await res.json()).rows ?? [])
    } catch { setError('Failed to load history.') }
    finally { setLoading(false) }
  }, [win])

  useEffect(() => { refresh() }, [refresh])

  const matrix = useMemo(() => buildMatrix({
    ...win,
    rows: rows.filter(r => genre === 'all' || r.category_group === genre),
    rosterNames,
  }), [win, rows, genre, rosterNames])

  return (
    <div className="card hist-card">
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="card-label">History</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="btn btn-sm" aria-label="Earlier"
            onClick={() => setWin(w => shiftWindow(w.from, w.to, -WINDOW_DAYS))}>◀</button>
          <span className="hist-sub">{win.from} → {win.to}</span>
          <button className="btn btn-sm" aria-label="Later"
            onClick={() => setWin(w => shiftWindow(w.from, w.to, WINDOW_DAYS))}>▶</button>
          <button className="btn btn-sm" onClick={refresh} disabled={loading}>
            <span className={loading ? 'spin' : ''}>↻</span>{loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <p className="msg-err" style={{ margin: '8px 0' }}>{error}</p>}
      <AssignHistoryMatrix matrix={matrix} />
    </div>
  )
}
