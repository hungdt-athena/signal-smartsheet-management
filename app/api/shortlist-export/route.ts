import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { countExportGames, listExportLabels, loadExportGames } from '@/lib/shortlist-export/games'
import { exportFileName, resolveScope } from '@/lib/shortlist-export/scope'
import { buildTabs } from '@/lib/shortlist-export/table'
import { buildXlsx } from '@/lib/shortlist-export/xlsx'
import { getExportAuth } from '@/lib/shortlist-export/google'
import { exportSlides } from '@/lib/shortlist-export/slides-export'
import { createExportSheet } from '@/lib/shortlist-export/gsheet'
import { EXPORT_FORMATS, EXPORT_TYPES, type ExportFormat, type ExportType } from '@/lib/shortlist-export/types'

export const dynamic = 'force-dynamic'
// A month deck is ~100 slides plus one image call per game on the fallback path.
export const maxDuration = 300

// Short List export: the Insight / Priority IV games of one batch or one month, as a Google
// Slides deck (copy of the Master Template), a Google Sheet, or an xlsx download.
// Managers only (admin + moderator).

const BAD_PICK = 'Pick a batch or month from W2 Jul 2026 on'
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

/** labels: the exportable batch labels. counts: games of `pick`, when one is given. */
export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const labels = await listExportLabels()
  const pick = req.nextUrl.searchParams.get('pick')
  if (pick == null) return NextResponse.json({ labels, counts: null })
  const scope = resolveScope(pick, labels)
  if (!scope) return bad(BAD_PICK)
  const games = await loadExportGames(scope.labels, [...EXPORT_TYPES])
  return NextResponse.json({ labels, counts: countExportGames(games) })
}

export async function POST(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard

  const body = await req.json().catch(() => null) as { pick?: unknown; types?: unknown; format?: unknown } | null
  const types = Array.isArray(body?.types) ? body!.types as unknown[] : []
  const format = body?.format as ExportFormat
  if (!types.length || !types.every(t => EXPORT_TYPES.includes(t as ExportType))) return bad('Choose Insight, Priority IV or both')
  if (!EXPORT_FORMATS.includes(format)) return bad('Choose Slides, Google Sheets or xlsx')
  const chosen = EXPORT_TYPES.filter(t => types.includes(t))

  const scope = resolveScope(typeof body?.pick === 'string' ? body.pick : '', await listExportLabels())
  if (!scope) return bad(BAD_PICK)

  const games = await loadExportGames(scope.labels, chosen)
  if (!games.length) return bad('No games in this period')
  const name = exportFileName(scope, chosen)

  try {
    if (format === 'xlsx') {
      const buf = await buildXlsx(buildTabs(games, chosen))
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type': XLSX_TYPE,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.xlsx')}`,
        },
      })
    }
    const auth = getExportAuth()
    if (format === 'sheets') {
      const { url } = await createExportSheet(auth, name, buildTabs(games, chosen))
      return NextResponse.json({ url, warnings: [] })
    }
    const { url, warnings } = await exportSlides(auth, name, games, scope, chosen)
    return NextResponse.json({ url, warnings })
  } catch (e) {
    console.error('[shortlist-export]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Export failed' }, { status: 500 })
  }
}
