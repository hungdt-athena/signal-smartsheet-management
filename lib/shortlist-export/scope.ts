// Turn a BatchPicker value into the batch labels one export covers. Pure.
//
// Only labels that have a row in `batches` (W2 Jul 2026 on) are exportable: older labels
// are leftovers of the Sheet -> Postgres move and are not offered. A month is the labels
// of that month (by the label, not by `batches.starts_on`: W1 Nov starts 27/10).

import { batchLabelsOfMonth, monthKeyLabel, monthKeyOfBatch } from '@/lib/batch-month'
import type { ExportScope, ExportType } from './types'

const MONTH_PICK = /^month:(\d{4}-\d{2})$/

export function resolveScope(pick: string, allowedLabels: string[]): ExportScope | null {
  const p = (pick || '').trim()
  if (!p) return null
  const allowed = new Set(allowedLabels)

  const m = MONTH_PICK.exec(p)
  if (m) {
    const monthKey = m[1]
    const labels = batchLabelsOfMonth(monthKey).filter(l => allowed.has(l))
    if (!labels.length) return null
    return { kind: 'month', labels, monthKey, weekTag: null }
  }

  if (!allowed.has(p)) return null
  const monthKey = monthKeyOfBatch(p)
  if (!monthKey) return null
  return { kind: 'week', labels: [p], monthKey, weekTag: p.slice(0, 2) }
}

/** 'Oct 2026 W3 Report', 'Oct 2026 Monthly Report (Priority IV)'. */
export function exportFileName(scope: ExportScope, types: ExportType[]): string {
  const base = `${monthKeyLabel(scope.monthKey)} ${scope.weekTag ?? 'Monthly'} Report`
  const hasI = types.includes('insight')
  const hasP = types.includes('priority_iv')
  if (hasI && !hasP) return `${base} (Insight)`
  if (hasP && !hasI) return `${base} (Priority IV)`
  return base
}
