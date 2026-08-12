import { classifyTag, resolveConfirm, TRENDS_FIELD, SYNC_USER } from '@/lib/playtest-tags'

const pending = (sub: number | null) => ({ id: 1, field_value: 'Balatro', sub_value_id: sub })
const existing = (sub: number | null) => ({ field_value: 'Balatro', sub_value_id: sub })

describe('constants', () => {
  it('names the Signal Sense field and system account', () => {
    expect(TRENDS_FIELD).toBe('Trends')
    expect(SYNC_USER).toBe('playtest_sync')
  })
})

describe('classifyTag', () => {
  it('inserts when Signal Sense has no tag for the value', () => {
    expect(classifyTag(pending(1), undefined)).toEqual({ kind: 'insert' })
  })

  it('is a duplicate when value and sub-value both match', () => {
    expect(classifyTag(pending(1), existing(1))).toEqual({ kind: 'duplicate' })
  })

  it('is a duplicate when neither side has a sub-value', () => {
    expect(classifyTag(pending(null), existing(null))).toEqual({ kind: 'duplicate' })
  })

  it('enriches when their sub-value is empty and ours is set', () => {
    expect(classifyTag(pending(2), existing(null))).toEqual({ kind: 'enrich' })
  })

  it('is a duplicate when ours is empty and theirs is set (they know more)', () => {
    expect(classifyTag(pending(null), existing(2))).toEqual({ kind: 'duplicate' })
  })

  it('conflicts when both have a sub-value and they differ', () => {
    expect(classifyTag(pending(1), existing(2))).toEqual({ kind: 'conflict', theirSubValueId: 2 })
  })
})

describe('resolveConfirm', () => {
  it('writes an insert as synced/inserted', () => {
    expect(resolveConfirm({ kind: 'insert' }, false))
      .toEqual({ write: 'insert', status: 'synced', result: 'inserted' })
  })

  it('writes nothing for a duplicate but still leaves Pending', () => {
    expect(resolveConfirm({ kind: 'duplicate' }, false))
      .toEqual({ write: null, status: 'synced', result: 'duplicate' })
  })

  it('updates the sub-value for an enrich', () => {
    expect(resolveConfirm({ kind: 'enrich' }, false))
      .toEqual({ write: 'update', status: 'synced', result: 'enriched' })
  })

  it('keeps the Signal Sense value when a conflict is not overwritten', () => {
    expect(resolveConfirm({ kind: 'conflict', theirSubValueId: 2 }, false))
      .toEqual({ write: null, status: 'rejected', result: 'kept' })
  })

  it('overwrites the sub-value when the admin forces it', () => {
    expect(resolveConfirm({ kind: 'conflict', theirSubValueId: 2 }, true))
      .toEqual({ write: 'update', status: 'synced', result: 'overwritten' })
  })

  it('ignores overwrite for non-conflict actions', () => {
    expect(resolveConfirm({ kind: 'insert' }, true).result).toBe('inserted')
    expect(resolveConfirm({ kind: 'duplicate' }, true).result).toBe('duplicate')
  })
})
