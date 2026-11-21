/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))

import { sourceBreakdowns, perEvaluatorPlatform } from '@/lib/operation-runs'

const c = (id: number, os: string | null) => ({ id, game_id: `g${id}`, os, assigned_date: '2026-11-20' })

describe('operation-runs breakdowns', () => {
  it('a linked pair is counted under pair, not under other', () => {
    const cands = [c(1, 'ios'), c(2, 'pair'), c(3, 'android'), c(4, null)]
    expect(sourceBreakdowns(cands).by_platform).toEqual({ ios: 1, android: 1, other: 1, pair: 1 })
    const per = perEvaluatorPlatform(cands, new Map([[1, 'A'], [2, 'A'], [4, 'B']]))
    expect(per).toEqual({ A: { ios: 1, android: 0, other: 0, pair: 1 }, B: { ios: 0, android: 0, other: 1, pair: 0 } })
  })
})
