import { NOTE_MIN_LEN, noteRequirementError } from '@/lib/eval-rules'

const ok = 'Solid core loop, weak meta'
const short = 'meh'

describe('noteRequirementError', () => {
  it('requires a long enough note when the note is rewritten', () => {
    expect(noteRequirementError({ note: short, prevNote: ok, conclusion: 'List_Idea' }))
      .toContain(String(NOTE_MIN_LEN))
    expect(noteRequirementError({ note: '', prevNote: ok, conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: ok, prevNote: short, conclusion: 'List_Idea' })).toBeNull()
  })

  it('never blocks a game reopened without touching the note', () => {
    // legacy short note, resent untouched
    expect(noteRequirementError({ note: short, prevNote: short, conclusion: 'List_Idea' })).toBeNull()
    // stored note is empty, still untouched
    expect(noteRequirementError({ note: '', prevNote: null, conclusion: 'List_Idea' })).toBeNull()
    // whitespace-only difference is not a rewrite
    expect(noteRequirementError({ note: ` ${short} `, prevNote: short, conclusion: 'List_Idea' })).toBeNull()
  })

  it('does not force a note on a first-time evaluation that leaves it empty', () => {
    expect(noteRequirementError({ note: '', prevNote: null, conclusion: 'List_Idea' })).toBeNull()
  })

  it('exempts Link_dead even when the note is rewritten short', () => {
    expect(noteRequirementError({ note: '', prevNote: ok, conclusion: 'Link_dead' })).toBeNull()
  })
})
