import { isBucket, isWeight, normalizeCategory, BUCKETS, WEIGHTS } from '@/lib/buckets'

describe('lib/buckets', () => {
  it('BUCKETS and WEIGHTS have the expected members', () => {
    expect(BUCKETS).toEqual(['puzzle', 'arcade', 'simulation'])
    expect(WEIGHTS).toEqual([30, 50, 70, 100])
  })
  it('isBucket / isWeight validate membership', () => {
    expect(isBucket('puzzle')).toBe(true)
    expect(isBucket('rpg')).toBe(false)
    expect(isWeight(70)).toBe(true)
    expect(isWeight(60)).toBe(false)
    expect(isWeight('70')).toBe(false)
  })
  it('normalizeCategory maps empty/all → All, joins/trims lists', () => {
    expect(normalizeCategory('')).toBe('All')
    expect(normalizeCategory(undefined)).toBe('All')
    expect(normalizeCategory('all')).toBe('All')
    expect(normalizeCategory(' puzzle , word ,')).toBe('puzzle,word')
    expect(normalizeCategory(['puzzle', 'word'])).toBe('puzzle,word')
  })
})
