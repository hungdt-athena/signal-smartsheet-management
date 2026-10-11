// lib/evaluation-history.ts — turns evaluation_log and assignment_history rows into the
// events of the panel's History modal, and groups them by day. Pure: the route reads the
// rows, this formats them.

export interface LogRow {
  id: string
  at: string | Date
  actor: string | null
  owner: string | null
  source: string // panel | other | add_to_record | record_tab | seed
  context: string | null
  kind: string // first | revise | clear | final | other | record_add | record_assign | record_move | record_remove
  conclusion_before: string | null
  conclusion_after: string | null
  final_before: string | null
  final_after: string | null
  batch_before: string | null
  batch_after: string | null
  bucket_before: string | null // Record bucket ('5min' | '20min') before / after
  bucket_after: string | null
  recorder_before: string | null
  recorder_after: string | null
  owner_after: string | null // initial_evaluator after the write (add to Record only)
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

export type EventType = 'save' | 'final' | 'record' | 'assign' | 'seed'

/** One thing that moved: a verdict, the final conclusion, the batch, or a person. `from` null means
 *  there is no "before" to show (a first verdict, a first assignment). */
export interface Change {
  kind: 'initial' | 'final' | 'batch' | 'person'
  from: string | null
  to: string | null
  label?: string // names the line when the kind alone does not ("Evaluator")
}

export interface HistoryEvent {
  key: string
  at: string // ISO
  who: string
  type: EventType
  verb: string
  changes: Change[]
  time: string | null // panel time of this save, e.g. "12m"
  seconds: number | null
  note: string | null
}

const CONTEXT_LABEL: Record<string, string> = { shortlist: 'Short List', record: 'Record', tagging: 'Tagging' }
const SEED_NOTE = 'Copied from the old record'
const ASSIGN_VERB: Record<string, string> = {
  assign: 'assigned to', reassign: 'reassigned', handover: 'handed over', rescue: 'rescued',
}

const iso = (at: string | Date) => new Date(at).toISOString()
const dash = (v: string | null) => v ?? '—'

export function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** '5min' -> '5 min'. Anything else is not a Record bucket. */
function bucketLabel(b: string | null): string | null {
  return b === '5min' ? '5 min' : b === '20min' ? '20 min' : null
}

/** The Record bucket a final conclusion puts a game in by itself. */
function finalBucket(final: string | null): string | null {
  return final === 'Priority IV' ? '20min' : final === 'Insight' ? '5min' : null
}

const withBucket = (text: string, b: string | null) => (bucketLabel(b) ? `${text} · ${bucketLabel(b)}` : text)

/** "Batch W2 Oct, 2026", or "Batch W2 Oct, 2026 · was W1 Oct, 2026" when the write moved it. */
function batchNote(r: LogRow, showWas: boolean): string | null {
  const now = r.batch_after ?? r.batch_before
  if (now == null) return null
  const was = showWas && r.batch_before != null && r.batch_after != null && r.batch_before !== r.batch_after
  return was ? `Batch ${now} · was ${r.batch_before}` : `Batch ${now}`
}

const joinNote = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ') || null

/** The four Record events: add, assign (confirm), move, remove. */
function fromRecordLog(r: LogRow, base: Omit<HistoryEvent, 'who' | 'type' | 'verb' | 'changes'>): HistoryEvent {
  const who = dash(r.actor)
  const type: EventType = 'record'

  if (r.kind === 'record_add') {
    const changes: Change[] = []
    if (r.owner_after != null && r.owner !== r.owner_after) changes.push({ kind: 'person', label: 'Evaluator', from: r.owner, to: r.owner_after })
    if (r.conclusion_before !== r.conclusion_after) changes.push({ kind: 'initial', from: r.conclusion_before, to: r.conclusion_after })
    if (r.final_before !== r.final_after) changes.push({ kind: 'final', from: r.final_before, to: r.final_after })
    return { ...base, who, type, verb: withBucket('added to Record', r.bucket_after), changes, note: batchNote(r, true) }
  }

  if (r.kind === 'record_move') {
    const from = bucketLabel(r.bucket_before)
    const to = bucketLabel(r.bucket_after)
    const recorder = r.recorder_after ?? r.recorder_before
    const verb = from && to ? `moved the game in Record · ${from} → ${to}` : to ? `moved the game in Record · to ${to}` : 'moved the game in Record'
    return { ...base, who, type, verb, changes: [], note: joinNote(recorder ? `Recorder ${recorder}` : null, batchNote(r, false)) }
  }

  if (r.kind === 'record_remove') {
    const was = bucketLabel(r.bucket_before)
    return {
      ...base, who, type, verb: was ? `removed the game from Record · was ${was}` : 'removed the game from Record', changes: [],
      note: joinNote(r.recorder_before ? `Recorder was ${r.recorder_before}` : null, batchNote(r, false)),
    }
  }

  // record_assign
  const where = withBucket('Record', r.bucket_after ?? r.bucket_before)
  const verb = r.recorder_before == null
    ? `assigned ${r.recorder_after ?? 'a recorder'} to ${where}`
    : `reassigned ${where} from ${r.recorder_before} to ${r.recorder_after ?? '—'}`
  if (r.source === 'seed') return { ...base, who: '—', type, verb, changes: [], note: SEED_NOTE }
  return { ...base, who, type, verb, changes: [], note: batchNote(r, false) }
}

/** The verdict chip(s): before → after when it moved from something, else just the verdict. */
function verdictChange(r: LogRow): Change {
  const arrow = r.changed && r.conclusion_before != null
  return { kind: 'initial', from: arrow ? r.conclusion_before : null, to: r.conclusion_after }
}

export function fromLog(r: LogRow): HistoryEvent {
  const base = { key: `log-${r.id}`, at: iso(r.at), time: null as string | null, seconds: null as number | null, note: null as string | null }

  if (r.kind === 'record_add' || r.kind === 'record_assign' || r.kind === 'record_move' || r.kind === 'record_remove') {
    return fromRecordLog(r, base)
  }
  // Rows written before the Record kinds existed: an add-to-record pull was a plain save with this source.
  if (r.source === 'add_to_record') return fromRecordLog({ ...r, kind: 'record_add' }, base)

  if (r.source === 'seed') {
    const note = r.confidence === 'low' ? `${SEED_NOTE} · time may be off`
      : r.confidence === 'corrected' ? `${SEED_NOTE} · time taken from the first trend tag`
      : SEED_NOTE
    return { ...base, who: dash(r.owner), type: 'seed', verb: 'evaluated', changes: [{ kind: 'initial', from: null, to: r.conclusion_after }], note }
  }

  const finalMoved = r.final_before !== r.final_after
  const batchMoved = r.batch_before !== r.batch_after
  const batchChange: Change = { kind: 'batch', from: r.batch_before, to: r.batch_after }
  const finalChange: Change = { kind: 'final', from: r.final_before, to: r.final_after }
  const timed = r.source === 'panel' && r.view_s != null
  const timing = timed ? { time: fmtDuration(r.view_s as number), seconds: r.view_s as number } : {}
  const fromTab = r.source === 'panel' && r.context && CONTEXT_LABEL[r.context] ? `From ${CONTEXT_LABEL[r.context]}` : null
  // A final conclusion of Insight / Priority IV puts a List_Idea game in Record on its own; say so on that event.
  const enters = finalMoved && finalBucket(r.final_after) && finalBucket(r.final_after) !== finalBucket(r.final_before)
    ? `Enters Record · ${bucketLabel(finalBucket(r.final_after))}` : null
  const note = joinNote(fromTab, enters)
  const who = dash(r.actor)

  let type: EventType = 'save'
  let verb: string
  let changes: Change[] = []
  switch (r.kind) {
    case 'final':
      type = 'final'
      verb = r.final_before == null ? 'set the final conclusion' : 'changed the final conclusion'
      changes = finalMoved ? [finalChange] : []
      break
    case 'first':
      verb = 'evaluated'
      changes = [verdictChange(r)]
      break
    case 'clear':
      verb = 'cleared the verdict'
      changes = [{ kind: 'initial', from: r.conclusion_before, to: null }]
      break
    case 'revise':
      if (!r.changed && batchMoved && !finalMoved) {
        // Only the batch moved: no verdict chip, the batch line says it all.
        verb = 'changed the batch'
        changes = []
      } else {
        verb = r.changed ? 'changed the verdict' : 'edited the evaluation'
        changes = [verdictChange(r)]
      }
      break
    default:
      verb = 'updated the game'
  }
  if (r.kind !== 'final' && finalMoved) changes.push(finalChange)
  if (batchMoved) changes.push(batchChange)

  return { ...base, ...timing, who, type, verb, changes, note }
}

export function fromAssign(r: AssignRow): HistoryEvent {
  return {
    key: `asg-${r.id}`,
    at: iso(r.at),
    who: r.by === 'cron' ? 'Auto-assign' : dash(r.by),
    type: 'assign',
    verb: ASSIGN_VERB[r.action] ?? r.action,
    changes: [{ kind: 'person', from: r.from_evaluator, to: r.evaluator_name }],
    time: null,
    seconds: null,
    note: null,
  }
}

/** Both sources in one list, newest first. */
export function mergeHistory(log: LogRow[], assign: AssignRow[]): HistoryEvent[] {
  return [...log.map(fromLog), ...assign.map(fromAssign)]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

export interface HistorySummary { events: number; seconds: number; people: number }

/** The line under the title. Panel time sums only timed saves; people counts who acted
 *  (the auto-assign robot and unknown actors are not people). */
export function summarize(events: HistoryEvent[]): HistorySummary {
  const people = new Set(events.filter(e => e.who !== 'Auto-assign' && e.who !== '—').map(e => e.who.toLowerCase()))
  return { events: events.length, seconds: events.reduce((n, e) => n + (e.seconds ?? 0), 0), people: people.size }
}

// ---- days, in Asia/Ho_Chi_Minh ----------------------------------------------------------

const TZ = 'Asia/Ho_Chi_Minh'
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ }) // YYYY-MM-DD

function dayLabel(d: Date, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const core = `${get('weekday')} ${get('day')}/${get('month')}`
  const key = dayKey(d)
  if (key === dayKey(now)) return `Today · ${core}`
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return `Yesterday · ${core}`
  return get('year') === new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric' }).format(now)
    ? core
    : `${core}/${get('year')}`
}

/** HH:mm in Vietnam time. */
export function fmtClock(at: string): string {
  return new Date(at).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
}

export interface DayGroup { key: string; label: string; events: HistoryEvent[] }

/** Events (already newest first) split into Vietnam calendar days. */
export function groupByDay(events: HistoryEvent[], now: Date = new Date()): DayGroup[] {
  const out: DayGroup[] = []
  for (const e of events) {
    const d = new Date(e.at)
    const key = dayKey(d)
    const last = out[out.length - 1]
    if (last && last.key === key) last.events.push(e)
    else out.push({ key, label: dayLabel(d, now), events: [e] })
  }
  return out
}
