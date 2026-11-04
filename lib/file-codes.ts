import { sql } from '@/lib/db'
import { generateCode } from '@/lib/short-code'

// Allow-list: the column name is the only identifier ever put in a statement.
type CodeColumn = 'demo_code' | 'record_code'
const COLUMNS: readonly CodeColumn[] = ['demo_code', 'record_code']
const MAX_ATTEMPTS = 5

async function readCode(col: CodeColumn, gameId: string): Promise<{ found: boolean; code: string | null }> {
  const rows = await sql`SELECT ${sql(col)} AS code FROM game_info WHERE game_id = ${gameId} LIMIT 1`
  if (rows.length === 0) return { found: false, code: null }
  return { found: true, code: (rows[0].code as string | null) ?? null }
}

/** Existing code if set, otherwise set and return a new one. null when the game has no game_info row. */
async function ensureCode(col: CodeColumn, gameId: string): Promise<string | null> {
  if (!COLUMNS.includes(col)) throw new Error(`bad code column: ${col}`)
  const first = await readCode(col, gameId)
  if (!first.found) return null
  if (first.code) return first.code

  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode()
    try {
      const updated = await sql`
        UPDATE game_info SET ${sql(col)} = ${code}
        WHERE game_id = ${gameId} AND ${sql(col)} IS NULL
        RETURNING ${sql(col)} AS code`
      if (updated.length > 0) return code
      // 0 rows: someone set it first (or the row vanished). Return theirs.
      const again = await readCode(col, gameId)
      if (!again.found) return null
      if (again.code) return again.code
    } catch (err) {
      if ((err as { code?: string })?.code !== '23505') throw err
      lastErr = err
    }
  }
  throw lastErr ?? new Error(`could not allocate ${col} for ${gameId}`)
}

export const ensureDemoCode = (gameId: string) => ensureCode('demo_code', gameId)
export const ensureRecordCode = (gameId: string) => ensureCode('record_code', gameId)
