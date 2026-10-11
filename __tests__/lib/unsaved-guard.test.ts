import { registerUnsavedGuard, requestLeaveUnsaved } from '@/lib/unsaved-guard'

describe('requestLeaveUnsaved', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.splice(0).forEach(c => c()) })
  const add = (g: Parameters<typeof registerUnsavedGuard>[0]) => { cleanups.push(registerUnsavedGuard(g)) }

  it('just proceeds when nothing is registered', () => {
    const proceed = jest.fn()
    requestLeaveUnsaved(proceed)
    expect(proceed).toHaveBeenCalledTimes(1)
  })
  it('just proceeds when the editor has nothing unsaved', () => {
    const requestLeave = jest.fn()
    add({ isDirty: () => false, flush: async () => {}, requestLeave })
    const proceed = jest.fn()
    requestLeaveUnsaved(proceed)
    expect(requestLeave).not.toHaveBeenCalled()
    expect(proceed).toHaveBeenCalledTimes(1)
  })
  it('hands proceed to a dirty editor and does not run it itself', () => {
    const requestLeave = jest.fn()
    add({ isDirty: () => true, flush: async () => {}, requestLeave })
    const proceed = jest.fn()
    requestLeaveUnsaved(proceed)
    expect(requestLeave).toHaveBeenCalledWith(proceed)
    expect(proceed).not.toHaveBeenCalled()
  })
  it('proceeds when the dirty editor cannot ask', () => {
    add({ isDirty: () => true, flush: async () => {} })
    const proceed = jest.fn()
    requestLeaveUnsaved(proceed)
    expect(proceed).toHaveBeenCalledTimes(1)
  })
  it('a faulty guard does not block leaving', () => {
    add({ isDirty: () => { throw new Error('boom') }, flush: async () => {} })
    const proceed = jest.fn()
    requestLeaveUnsaved(proceed)
    expect(proceed).toHaveBeenCalledTimes(1)
  })
})
