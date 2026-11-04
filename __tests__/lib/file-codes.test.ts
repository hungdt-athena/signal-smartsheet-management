/**
 * @jest-environment node
 */
jest.mock('@/lib/db', () => ({ sql: jest.fn() }))
jest.mock('@/lib/short-code', () => ({ generateCode: jest.fn() }))

import { ensureDemoCode, ensureRecordCode } from '@/lib/file-codes'
import { sql } from '@/lib/db'
import { generateCode } from '@/lib/short-code'

const sqlMock = sql as unknown as jest.Mock
const genMock = generateCode as unknown as jest.Mock

type Row = { demo_code: string | null; record_code: string | null }
let table: Map<string, Row>
let statements: string[]
let updateHook: ((col: string, code: string) => void) | null
let uniqueTaken: Set<string>

const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' })

beforeEach(() => {
  table = new Map()
  statements = []
  updateHook = null
  uniqueTaken = new Set()
  genMock.mockReset()
  sqlMock.mockReset()
  sqlMock.mockImplementation((strings: unknown, ...binds: unknown[]) => {
    // sql('col') identifier helper
    if (!Array.isArray(strings) || !('raw' in (strings as object))) return { ident: strings }
    const parts = strings as string[]
    let text = parts[0]
    const vals: unknown[] = []
    binds.forEach((b, i) => {
      if (b && typeof b === 'object' && 'ident' in (b as object)) text += (b as { ident: string }).ident
      else { text += '$'; vals.push(b) }
      text += parts[i + 1]
    })
    statements.push(text)
    if (/^\s*SELECT/.test(text)) {
      const col = text.match(/SELECT\s+(\w+)/)![1] as keyof Row
      const row = table.get(vals[0] as string)
      return Promise.resolve(row ? [{ code: row[col] }] : [])
    }
    if (/^\s*UPDATE/.test(text)) {
      const col = text.match(/SET\s+(\w+)/)![1] as keyof Row
      const [code, gameId] = vals as [string, string]
      if (updateHook) updateHook(col, code)
      if (uniqueTaken.has(code)) return Promise.reject(uniqueViolation())
      const row = table.get(gameId)
      if (!row || row[col] !== null) return Promise.resolve([])
      row[col] = code
      uniqueTaken.add(code)
      return Promise.resolve([{ code }])
    }
    throw new Error('unexpected: ' + text)
  })
})

describe('ensureDemoCode / ensureRecordCode', () => {
  it('(a) returns an existing code without an UPDATE', async () => {
    table.set('g1', { demo_code: 'ABC234', record_code: null })
    expect(await ensureDemoCode('g1')).toBe('ABC234')
    expect(statements.some((s) => /UPDATE/.test(s))).toBe(false)
    expect(genMock).not.toHaveBeenCalled()
  })

  it('(b) returns null when game_info has no row', async () => {
    expect(await ensureDemoCode('nope')).toBeNull()
    expect(await ensureRecordCode('nope')).toBeNull()
    expect(statements.some((s) => /UPDATE/.test(s))).toBe(false)
  })

  it('sets a new code on the right column', async () => {
    table.set('g1', { demo_code: null, record_code: null })
    genMock.mockReturnValueOnce('AAAAAA')
    expect(await ensureRecordCode('g1')).toBe('AAAAAA')
    expect(table.get('g1')).toEqual({ demo_code: null, record_code: 'AAAAAA' })
  })

  it('(c) retries with a new code after a unique violation', async () => {
    table.set('g1', { demo_code: null, record_code: null })
    uniqueTaken.add('TAKEN2')
    genMock.mockReturnValueOnce('TAKEN2').mockReturnValueOnce('FRESH3')
    expect(await ensureDemoCode('g1')).toBe('FRESH3')
    expect(genMock).toHaveBeenCalledTimes(2)
  })

  it('(d) concurrent calls: the loser updates 0 rows, re-reads, and returns the winner code', async () => {
    table.set('g1', { demo_code: null, record_code: null })
    genMock.mockReturnValueOnce('WINNR2').mockReturnValueOnce('LOSER3')
    const results = await Promise.all([ensureDemoCode('g1'), ensureDemoCode('g1')])
    expect(results).toEqual(['WINNR2', 'WINNR2'])
    // both saw NULL on the first read, both UPDATEd, the second matched 0 rows and re-read
    const updates = statements.filter((s) => /UPDATE/.test(s)).length
    const selects = statements.filter((s) => /SELECT/.test(s)).length
    expect(updates).toBe(2)
    expect(selects).toBe(3)
    expect(table.get('g1')!.demo_code).toBe('WINNR2')
  })

  it('(e) throws after 5 consecutive unique violations', async () => {
    table.set('g1', { demo_code: null, record_code: null })
    genMock.mockReturnValue('DUPDUP')
    uniqueTaken.add('DUPDUP')
    await expect(ensureDemoCode('g1')).rejects.toMatchObject({ code: '23505' })
    expect(genMock).toHaveBeenCalledTimes(5)
  })
})
