import { leaveDecision, LEAVE_WORD } from '@/lib/leave-decision'

describe('leaveDecision', () => {
  it('goes straight away when nothing is unsaved', () => {
    expect(leaveDecision({ dirty: false, autoSave: false, saving: false })).toBe('go')
    expect(leaveDecision({ dirty: false, autoSave: true, saving: false })).toBe('go')
  })
  it('asks when there are unsaved edits and auto-save is off', () => {
    expect(leaveDecision({ dirty: true, autoSave: false, saving: false })).toBe('ask')
  })
  it('saves first when auto-save is on, instead of dropping the edit its timer would lose', () => {
    expect(leaveDecision({ dirty: true, autoSave: true, saving: false })).toBe('save-then-go')
  })
  it('does not ask while a save is already running', () => {
    expect(leaveDecision({ dirty: true, autoSave: false, saving: true })).toBe('go')
    expect(leaveDecision({ dirty: true, autoSave: true, saving: true })).toBe('go')
  })
  it('has a word for every action', () => {
    expect(LEAVE_WORD).toEqual({ next: 'next', prev: 'previous', jump: 'open', close: 'close' })
  })
})
