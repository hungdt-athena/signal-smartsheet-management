// lib/unsaved-fields.ts — which fields of the eval panel differ from what was loaded, for
// the "unsaved changes" popup. The form is compared with the row it was filled from;
// pure so it can be tested without rendering the panel.
import type { NoteParts } from '@/lib/eval-rules'

export interface FormValues {
  noteParts: NoteParts
  conclusion: string
  batch: string
  driveLink: string
  gameAlike: unknown[]
  finalNote: string
  finalConclusion: string
  drive5: string
  drive20: string
  rec5Assignee: string
  rec20Assignee: string
}

/** The row as loaded (the same mapping the panel's applyData uses). */
export interface LoadedRow {
  noteParts: NoteParts
  initial_conclusion: string | null
  batch: string | null
  drive_link: string | null
  game_alike: unknown
  final_note: string | null
  final_conclusion: string | null
  record_5min_drive: string | null
  record_20min_drive: string | null
  record_5min_assignee: string | null
  record_20min_assignee: string | null
}

const s = (v: string | null | undefined) => v ?? ''

export function unsavedFields(
  form: FormValues,
  row: LoadedRow,
  extra: { trendsTouched: boolean; stagedShots: number },
): string[] {
  const out: string[] = []
  const diff = (label: string, now: string, was: string | null | undefined) => { if (now !== s(was)) out.push(label) }

  diff('Initial conclusion', form.conclusion, row.initial_conclusion)
  diff('Self note', form.noteParts.self_note, row.noteParts.self_note)
  diff('Gameplay', form.noteParts.gameplay, row.noteParts.gameplay)
  diff('Game over', form.noteParts.game_over, row.noteParts.game_over)
  diff('Level complete', form.noteParts.level_complete, row.noteParts.level_complete)
  // Batch only goes to the server on a List_Idea; elsewhere a changed value is never saved.
  if (form.conclusion === 'List_Idea') diff('Batch', form.batch, row.batch)
  diff('Demo video link', form.driveLink, row.drive_link)
  const alikeNow = JSON.stringify(form.gameAlike)
  const alikeWas = JSON.stringify(Array.isArray(row.game_alike) ? row.game_alike : [])
  if (alikeNow !== alikeWas) out.push('Game alike')
  if (extra.trendsTouched) out.push('Trend tags')
  diff('Final conclusion', form.finalConclusion, row.final_conclusion)
  diff('Final note', form.finalNote, row.final_note)
  diff('Recording 5-min link', form.drive5, row.record_5min_drive)
  diff('Recording 20-min link', form.drive20, row.record_20min_drive)
  diff('Recording 5-min assignee', form.rec5Assignee, row.record_5min_assignee)
  diff('Recording 20-min assignee', form.rec20Assignee, row.record_20min_assignee)
  if (extra.stagedShots > 0) out.push(extra.stagedShots === 1 ? 'Screenshot' : `Screenshots (${extra.stagedShots})`)
  return out
}
