import {
  CODE_ALPHABET,
  MIN_DIGITS,
  MIN_LETTERS,
  generateCode,
  isCode,
  codeFromFileName,
} from '@/lib/short-code'

describe('generateCode', () => {
  it('returns 6 chars from the alphabet, none of 0O1IL, at least 2 digits and 2 letters', () => {
    for (let i = 0; i < 1000; i++) {
      const c = generateCode()
      expect(c).toHaveLength(6)
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch)
      expect(c).not.toMatch(/[0O1IL]/)
      expect(isCode(c)).toBe(true)
      expect(c.match(/[2-9]/g)!.length).toBeGreaterThanOrEqual(MIN_DIGITS)
      expect(c.match(/[A-Z]/g)!.length).toBeGreaterThanOrEqual(MIN_LETTERS)
    }
  })
})

describe('codeFromFileName', () => {
  const cases: Array<[string, string | null]> = [
    ['K7M2QX.mp4', 'K7M2QX'],
    ['k7m2qx.MP4', 'K7M2QX'],
    ['K7M2QX (1).mp4', 'K7M2QX'],
    ['K7M2QX .mp4', 'K7M2QX'],
    ['K7M2QX.mp4.mp4', null],
    ['K7M2QX_20mins.mp4', null],
    ['K7M2Q.mp4', null],
    ['K7M2QXA.mp4', null],
    ['K7M2O1.mp4', null],
    ['Racket.mp4', null],
    ['ABCDEF.mp4', null],
    ['234567.mp4', null],
    ['K7MQXA.mp4', null],
    ['AB2345.mp4', 'AB2345'],
    ['A2B3CD.mp4', 'A2B3CD'],
  ]
  it.each(cases)('%s -> %s', (name, expected) => {
    expect(codeFromFileName(name)).toBe(expected)
  })
})

describe('isCode', () => {
  it('needs 2 digits and 2 letters', () => {
    expect(isCode('K7M2QX')).toBe(true)
    expect(isCode('K7MQXA')).toBe(false)
    expect(isCode('KMQXA2')).toBe(false)
    expect(isCode('ABCDEF')).toBe(false)
    expect(isCode('234567')).toBe(false)
    expect(isCode('K7M2Q')).toBe(false)
  })
})
