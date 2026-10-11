// lib/evaluation-history.ts — turns evaluation_log and assignment_history rows into the
// lines of the panel's History modal. Pure: the route reads the rows, this formats them.
import { prettyConclusion as pc } from '@/lib/buckets'

export interface LogRow {
  id: string
  at: string | Date
  actor: string | null
  owner: string | null
  source: string // panel | other | add_to_record | seed
  context: string | null
  kind: string // first | revise | clear | final | other
  conclusion_before: string | null
  conclusion_after: string | null
  final_before: string | null
  final_after: string | null
  changed: boolean
  view_s: number | null
  confidence: string | null
}

export interface AssignRow {
  id: number
  at: string | Date
  action: string // assign | reassign | handover | rescue
  evaluator_name: string
  from_evaluator: string | null
  by: string | null // user name, or the raw created_by ('cron', an email nobody owns)
}

export interface HistoryEvent {
  key: string
  at: string // ISO
  who: string
  action: string
  detail: string
  time: string | null // panel time of this save
  note: string | null
}

const CONTEXT_LABEL: Record<string, string> = { shortlist: 'Short List', record: 'Record', tagging: 'Tagging' }
const SEED_NOTE = 'Copied from the old record'

const iso = (at: string | Date) => new Date(at).toISOString()
const dash = (v: string | null) => v ?? '—'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function verdictPart(r: LogRow): string {
  if (r.changed) return `${pc(r.conclusion_before)} → ${pc(r.conclusion_after)}`
  return r.conclusion_after ? `Edited · ${pc(r.conclusion_after)}` : 'Edited'
}

export function fromLog(r: LogRow): HistoryEvent {
  const base = { key: `log-${r.id}`, at: iso(r.at), time: null as string | null, note: null as string | null }

  if (r.source === 'seed') {
    const note = r.confidence === 'low' ? `${SEED_NOTE} · time may be off`
      : r.confidence === 'corrected' ? `${SEED_NOTE} · time taken from the first trend tag`
      : SEED_NOTE
    return { ...base, who: dash(r.owner), action: 'Old verdict', detail: pc(r.conclusion_after), note }
  }

  const finalMoved = r.final_before !== r.final_after
  const finalChange = `${dash(r.final_before)} → ${dash(r.final_after)}`
  // A Final row already says "Final" in its action, so its detail is the change alone.
  const detail = r.kind === 'final'
    ? (finalMoved ? finalChange : 'Edited')
    : [verdictPart(r), finalMoved ? `Final: ${finalChange}` : null].filter(Boolean).join(' · ')

  const action = r.source === 'add_to_record' ? 'Add to record'
    : r.kind === 'final' ? 'Final'
    : r.kind === 'clear' ? 'Clear'
    : 'Save'

  return {
    ...base,
    who: dash(r.actor),
    action,
    detail,
    time: r.source === 'panel' && r.view_s != null ? fmtDuration(r.view_s) : null,
    note: r.source === 'panel' && r.context && CONTEXT_LABEL[r.context] ? `From ${CONTEXT_LABEL[r.context]}` : null,
  }
}

export function fromAssign(r: AssignRow): HistoryEvent {
  return {
    key: `asg-${r.id}`,
    at: iso(r.at),
    who: r.by === 'cron' ? 'Auto-assign' : dash(r.by),
    action: cap(r.action),
    detail: r.from_evaluator ? `${r.from_evaluator} → ${r.evaluator_name}` : `→ ${r.evaluator_name}`,
    time: null,
    note: null,
  }
}

/** Both sources in one list, newest first. */
export function mergeHistory(log: LogRow[], assign: AssignRow[]): HistoryEvent[] {
  return [...log.map(fromLog), ...assign.map(fromAssign)]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
