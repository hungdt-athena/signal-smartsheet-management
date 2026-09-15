import { promises as fs } from 'fs'
import path from 'path'
import type { Client } from '@replit/object-storage'

/** Object names live under this prefix, then the game's own prefix:
 *  `screenshots/<gameId>/<file>`. The game prefix is what stops a
 *  user-supplied URL from reaching another game's files. */
const PREFIX = 'screenshots'

/** Where a manual screenshot is served from. Replit Object Storage has no
 *  public-URL API (unlike the Supabase bucket this replaced), so the stored
 *  value is an app route rather than an external link, and the bytes are
 *  streamed by `app/api/screenshots/[...path]/route.ts`. */
const URL_BASE = '/api/screenshots'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export function mimeForExt(ext: string): string {
  return EXT_MIME[ext] || 'application/octet-stream'
}

/** Which backend stores the bytes.
 *
 *  Replit Object Storage only works inside a Replit runtime: its SDK talks to a
 *  sidecar on http://127.0.0.1:1106 for credentials and for the default bucket
 *  id, and there is no token to configure in its place. So local development
 *  writes to disk instead.
 *
 *  This is chosen explicitly rather than by sniffing for the sidecar. Falling
 *  back to disk on its own would put production screenshots on a container
 *  filesystem that is wiped on every redeploy -- a silent data loss of exactly
 *  the kind that hid the previous (dead Supabase project) outage. In production
 *  a missing sidecar throws instead. */
export type Backend = 'replit' | 'local'

export function backend(): Backend {
  const explicit = process.env.SCREENSHOT_STORE
  if (explicit === 'replit' || explicit === 'local') return explicit
  return process.env.NODE_ENV === 'production' ? 'replit' : 'local'
}

/** Kept for the routes that used to guard on it. Both backends are always
 *  available -- there is nothing left to leave unconfigured, which is the point
 *  of the move off Supabase -- so this no longer gates anything. A real failure
 *  now surfaces as a thrown error from the upload itself. */
export function isStorageConfigured(): boolean {
  return true
}

const LOCAL_DIR = process.env.SCREENSHOT_LOCAL_DIR
  || path.join(process.cwd(), '.screenshots')

/** Which bucket to write to. Leave SCREENSHOT_BUCKET unset in normal operation:
 *  the sidecar then serves `[objectStorage] defaultBucketID` from `.replit`,
 *  which keeps the bucket declared in exactly one place.
 *
 *  Set it only to write somewhere other than the app's default bucket. The value
 *  is the bucket *id* -- `replit-objstore-<uuid>`, as it appears in `.replit` --
 *  not the name App Storage shows in its dropdown. Those differ, and passing the
 *  display name fails at the GCS call rather than anywhere informative. */
export function bucketName(): string | undefined {
  return process.env.SCREENSHOT_BUCKET || undefined
}

let clientPromise: Promise<Client> | null = null
function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = import('@replit/object-storage')
      .then(m => new m.Client({ bucketId: bucketName() }))
  }
  return clientPromise
}

/** Resolves an object name to a path inside LOCAL_DIR, refusing anything that
 *  escapes it. Object names are built by this module, but `deleteScreenshotByUrl`
 *  derives one from a user-supplied URL. */
function localPath(objectName: string): string {
  const full = path.resolve(LOCAL_DIR, objectName)
  const root = path.resolve(LOCAL_DIR)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Invalid object name')
  }
  return full
}

/** Uploads one image and returns the URL to serve it from. */
export async function uploadScreenshot(
  gameId: string, buffer: Buffer, ext: string, index: number,
): Promise<string> {
  const file = `${Date.now()}-${index}.${ext}`
  const objectName = `${PREFIX}/${gameId}/${file}`

  if (backend() === 'local') {
    const dest = localPath(objectName)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, buffer)
  } else {
    // `compress: false` -- these are already-compressed PNG/JPEG/WebP, so the
    // SDK's gzip layer only costs CPU on the way in and out.
    const res = await (await getClient()).uploadFromBytes(objectName, buffer, { compress: false })
    if (!res.ok) throw new Error(res.error.message)
  }

  return `${URL_BASE}/${encodeURIComponent(gameId)}/${encodeURIComponent(file)}`
}

/** Reads one object's bytes. Null when it does not exist. */
export async function readScreenshot(objectName: string): Promise<Buffer | null> {
  if (backend() === 'local') {
    try {
      return await fs.readFile(localPath(objectName))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  const res = await (await getClient()).downloadAsBytes(objectName)
  if (!res.ok) {
    if (res.error.statusCode === 404) return null
    throw new Error(res.error.message)
  }
  return res.value[0]
}

/** Derives the object name from a stored URL; null if it isn't one of ours. */
export function objectNameFromUrl(url: string): string | null {
  const marker = `${URL_BASE}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  const raw = url.slice(idx + marker.length)
  if (!raw) return null
  try {
    const decoded = raw.split('/').map(decodeURIComponent).join('/')
    // Traversal and absolute segments never name a real object.
    if (decoded.split('/').some(s => s === '' || s === '.' || s === '..')) return null
    return `${PREFIX}/${decoded}`
  } catch {
    return null // malformed percent-encoding -- not one of our URLs
  }
}

/** Deletes one object. The URL must point into this game's prefix --
 *  user-supplied URLs must never reach another game's files. */
export async function deleteScreenshotByUrl(url: string, gameId: string): Promise<void> {
  const objectName = objectNameFromUrl(url)
  if (!objectName || !objectName.startsWith(`${PREFIX}/${gameId}/`)) {
    throw new Error('URL does not belong to this game')
  }
  if (backend() === 'local') {
    await fs.rm(localPath(objectName), { force: true })
    return
  }
  const res = await (await getClient()).delete(objectName, { ignoreNotFound: true })
  if (!res.ok) throw new Error(res.error.message)
}

/** Removes every object under the game's prefix. No-op when the prefix is empty. */
export async function deleteGameScreenshots(gameId: string): Promise<void> {
  const dirName = `${PREFIX}/${gameId}`

  if (backend() === 'local') {
    await fs.rm(localPath(dirName), { recursive: true, force: true })
    return
  }

  const client = await getClient()
  const listed = await client.list({ prefix: `${dirName}/` })
  if (!listed.ok) throw new Error(listed.error.message)
  for (const obj of listed.value) {
    const res = await client.delete(obj.name, { ignoreNotFound: true })
    if (!res.ok) throw new Error(res.error.message)
  }
}

export interface StorageCheck {
  ok: boolean
  backend: Backend
  /** The bucket that was pinned, or null when the sidecar's default was used. */
  bucket: string | null
  /** Which step failed, when one did. */
  step?: 'upload' | 'read' | 'verify' | 'delete'
  error?: string
}

/** Round-trips a small object to prove storage actually works from wherever this
 *  is running: upload, read the same bytes back, delete. Written because the
 *  Replit SDK reaches a sidecar that only exists inside a Replit runtime, and
 *  because a bucket can be present in the UI while the app is pointed at a
 *  different one -- neither is knowable from the code alone, and the last outage
 *  here was storage that looked configured and was not. */
export async function checkStorage(): Promise<StorageCheck> {
  const base: StorageCheck = { ok: false, backend: backend(), bucket: bucketName() ?? null }
  const probe = Buffer.from(`storage-check ${Date.now()}`)
  // A real game prefix is never a bare dot-name, so this cannot collide.
  const gameId = '.storage-check'
  let url: string

  try {
    url = await uploadScreenshot(gameId, probe, 'png', 0)
  } catch (e) {
    return { ...base, step: 'upload', error: e instanceof Error ? e.message : String(e) }
  }

  try {
    const got = await readScreenshot(objectNameFromUrl(url)!)
    if (!got) return { ...base, step: 'read', error: 'object not found after upload' }
    if (!got.equals(probe)) return { ...base, step: 'verify', error: 'bytes differ after round trip' }
  } catch (e) {
    return { ...base, step: 'read', error: e instanceof Error ? e.message : String(e) }
  }

  try {
    await deleteGameScreenshots(gameId)
  } catch (e) {
    // Upload and read both worked, so storage is usable; say so, but do not hide
    // that the probe left a file behind.
    return { ...base, ok: true, step: 'delete', error: e instanceof Error ? e.message : String(e) }
  }

  return { ...base, ok: true }
}
