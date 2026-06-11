import { createClient, SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'game-screenshots'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export function isStorageConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
}

let client: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false },
    })
  }
  return client
}

/** Uploads one image under <gameId>/ and returns its public URL. */
export async function uploadScreenshot(gameId: string, buffer: Buffer, ext: string, index: number): Promise<string> {
  const path = `${gameId}/${Date.now()}-${index}.${ext}`
  const { error } = await getClient().storage.from(BUCKET).upload(path, buffer, {
    contentType: EXT_MIME[ext] || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
  return getClient().storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Derives the bucket object path from a public URL; null if it isn't ours. */
export function pathFromPublicUrl(url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  const raw = url.slice(idx + marker.length)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null // malformed percent-encoding — not one of our URLs
  }
}

/** Deletes one object. The URL must point into this game's prefix —
 *  user-supplied URLs must never reach another game's files. */
export async function deleteScreenshotByUrl(url: string, gameId: string): Promise<void> {
  const path = pathFromPublicUrl(url)
  if (!path || !path.startsWith(`${gameId}/`)) {
    throw new Error('URL does not belong to this game')
  }
  const { error } = await getClient().storage.from(BUCKET).remove([path])
  if (error) throw new Error(error.message)
}

/** Removes every object under the game's prefix. No-op when the prefix is empty. */
export async function deleteGameScreenshots(gameId: string): Promise<void> {
  const { data, error } = await getClient().storage.from(BUCKET).list(gameId, { limit: 1000 })
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return
  const paths = data.map(f => `${gameId}/${f.name}`)
  const { error: rmErr } = await getClient().storage.from(BUCKET).remove(paths)
  if (rmErr) throw new Error(rmErr.message)
}
