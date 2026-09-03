import { NOTE_MIN_LEN, noteRequirementError } from '@/lib/eval-rules'

const ok = 'Solid core loop, weak meta'
const short = 'meh'

describe('noteRequirementError', () => {
  it('requires a long enough note on every save', () => {
    expect(noteRequirementError({ note: short, conclusion: 'List_Idea' }))
      .toContain(String(NOTE_MIN_LEN))
    expect(noteRequirementError({ note: '', conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: null, conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: ok, conclusion: 'List_Idea' })).toBeNull()
  })

  it('blocks a reopened game whose stored note is too short', () => {
    // legacy short note, resent untouched — now blocks
    expect(noteRequirementError({ note: short, conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: '', conclusion: null })).not.toBeNull()
  })

  it('counts trimmed length, not padding', () => {
    expect(noteRequirementError({ note: '         ', conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: `  ${ok}  `, conclusion: 'List_Idea' })).toBeNull()
  })

  it('exempts Link_dead', () => {
    expect(noteRequirementError({ note: '', conclusion: 'Link_dead' })).toBeNull()
  })
})
