// Build the deck: copy the Master Template into the export folder, read the copy, send the plan.

import { google, type slides_v1 } from 'googleapis'
import { EXPORT_FOLDER_ID, MASTER_TEMPLATE_ID, trashFile, type ExportAuth } from './google'
import { readTemplate } from './slides-template'
import { planSlides, type MediaItem } from './slides-plan'
import type { ExportGame, ExportScope, ExportType } from './types'

type R = slides_v1.Schema$Request
const CHUNK = 500

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Slides allows 60 writes a minute per user: wait out a 429 instead of failing the export. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const code = codeOf(e)
      if ((code === 429 || code === 503) && attempt < 3) { await sleep(15_000 * (attempt + 1)); continue }
      throw e
    }
  }
}

const codeOf = (e: unknown) => (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status

/** Auth, quota (after retries) and server errors stop the export; anything else is one bad URL. */
function isFatal(e: unknown): boolean {
  const c = codeOf(e)
  return c === 401 || c === 403 || c === 429 || (typeof c === 'number' && c >= 500)
}

function warningFor(item: MediaItem): string {
  return item.requests.some(r => r.createVideo) ? `Video not added: ${item.title}` : `Icon not loaded: ${item.title}`
}

export async function exportSlides(
  auth: ExportAuth, name: string, games: ExportGame[], scope: ExportScope, types: ExportType[],
): Promise<{ fileId: string; url: string; warnings: string[] }> {
  const drive = google.drive({ version: 'v3', auth })
  const slides = google.slides({ version: 'v1', auth })
  const copy = await drive.files.copy({
    fileId: MASTER_TEMPLATE_ID,
    requestBody: { name, parents: [EXPORT_FOLDER_ID] },
    supportsAllDrives: true,
    fields: 'id',
  })
  const fileId = copy.data.id!
  const send = (requests: R[]) => withRetry(() => slides.presentations.batchUpdate({ presentationId: fileId, requestBody: { requests } }))

  try {
    const { data } = await slides.presentations.get({ presentationId: fileId })
    const plan = planSlides(readTemplate(data), games, scope, types)
    const warnings = [...plan.warnings]

    for (let i = 0; i < plan.structure.length; i += CHUNK) await send(plan.structure.slice(i, i + CHUNK))

    // One bad URL fails the whole batch. The error names the request ("Invalid requests[37]…"):
    // drop that game, warn, resend the rest. Without an index, fall back to one game per call.
    let items = plan.images
    while (items.length) {
      try {
        await send(items.flatMap(i => i.requests))
        break
      } catch (e) {
        if (isFatal(e)) throw e
        const m = /requests\[(\d+)\]/.exec(String((e as Error).message ?? ''))
        if (!m) {
          for (const item of items) {
            try { await send(item.requests) } catch (e2) { if (isFatal(e2)) throw e2; warnings.push(warningFor(item)) }
          }
          break
        }
        let at = parseInt(m[1], 10)
        const bad = items.findIndex(i => (at -= i.requests.length) < 0)
        if (bad < 0) throw e
        warnings.push(warningFor(items[bad]))
        items = items.filter((_, i) => i !== bad)
      }
    }
    return { fileId, url: `https://docs.google.com/presentation/d/${fileId}/edit`, warnings }
  } catch (e) {
    await trashFile(auth, fileId)
    throw e
  }
}
