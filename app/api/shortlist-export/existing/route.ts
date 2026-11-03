import { NextRequest, NextResponse } from 'next/server'
import { requireManager } from '@/lib/auth-guard'
import { listExportLabels } from '@/lib/shortlist-export/games'
import { exportFileName, resolveScope } from '@/lib/shortlist-export/scope'
import { findExport, getExportAuth } from '@/lib/shortlist-export/google'
import { EXPORT_TYPES, type ExportFormat, type ExportType } from '@/lib/shortlist-export/types'

export const dynamic = 'force-dynamic'

// The Slides deck / Google Sheet already exported for these choices, if any, so the dialog
// can show "Open file" instead of building the same file again. xlsx has nothing to find.
// GET ?pick=<BatchPicker value>&types=insight,priority_iv&format=slides|sheets
export async function GET(req: NextRequest) {
  const guard = await requireManager()
  if (guard) return guard
  const sp = req.nextUrl.searchParams
  const format = sp.get('format') as ExportFormat
  const types = EXPORT_TYPES.filter(t => (sp.get('types') ?? '').split(',').includes(t)) as ExportType[]
  const scope = resolveScope(sp.get('pick') ?? '', await listExportLabels())
  if (!scope || !types.length) return NextResponse.json({ error: 'Pick a batch or month from W2 Jul 2026 on' }, { status: 400 })
  if (format !== 'slides' && format !== 'sheets') return NextResponse.json({ existing: null })
  try {
    const existing = await findExport(getExportAuth(), scope, types, format, exportFileName(scope, types))
    return NextResponse.json({ existing })
  } catch (e) {
    // Not finding an old file must never block a new export.
    console.error('[shortlist-export] existing lookup failed', e)
    return NextResponse.json({ existing: null })
  }
}
