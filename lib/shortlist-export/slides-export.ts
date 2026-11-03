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
      const code = (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status
      if ((code === 429 || code === 503) && attempt < 3) { await sleep(15_000 * (attempt + 1)); continue }
      throw e
    }
  }
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

    if (plan.images.length) {
      try {
        await send(plan.images.flatMap(i => i.requests))
      } catch {
        // One bad URL fails the whole batch: retry each game alone and name the ones that fail.
        for (const item of plan.images) {
          try { await send(item.requests) } catch { warnings.push(warningFor(item)) }
        }
      }
    }
    return { fileId, url: `https://docs.google.com/presentation/d/${fileId}/edit`, warnings }
  } catch (e) {
    await trashFile(auth, fileId)
    throw e
  }
}
