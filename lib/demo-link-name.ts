import { codeFromFileName } from '@/lib/short-code'

// Does a demo video's Drive file name belong to the game it is attached to?
// Used to warn (never block) when an evaluator pastes a link to the wrong game's video.

export type NameCheck = 'ok' | 'mismatch' | 'unknown'

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com'])
const ID_RE = /^[A-Za-z0-9_-]{10,}$/

/** A pasted value worth checking: an http(s) link with a host. */
export function looksLikeUrl(v: string): boolean {
  return /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(v.trim())
}

/** The Drive file id in /file/d/<id>/..., open?id=<id> or uc?id=<id>. null for anything else. */
export function driveFileId(link: string): string | null {
  let url: URL
  try { url = new URL(link.trim()) } catch { return null }
  if (!DRIVE_HOSTS.has(url.hostname.toLowerCase())) return null
  const m = url.pathname.match(/\/file\/d\/([^/]+)/)
  const id = m ? m[1] : url.searchParams.get('id')
  return id && ID_RE.test(id) ? id : null
}

/** Lower-case, one kind of quote and dash, single spaces. */
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** "Picky Picnic: Cozy Farm" -> "Picky Picnic"; "Find The Suspect - Clue Puzzle" -> "Find The Suspect". */
function titleWithoutSubtitle(normTitle: string): string {
  const cuts = [normTitle.indexOf(':'), normTitle.indexOf(' - ')].filter(i => i > 0)
  return cuts.length ? normTitle.slice(0, Math.min(...cuts)).trim() : normTitle
}

/** ok when the file name is the game's demo code or its title (subtitle optional).
 *  unknown when the game has neither to compare against, or the name is empty. */
export function matchDemoFileName(
  fileName: string,
  expected: { code: string | null; title: string | null },
): NameCheck {
  const code = expected.code?.trim() || null
  const title = expected.title?.trim() || null
  if (!code && !title) return 'unknown'
  const full = norm(fileName)
  if (!full) return 'unknown'
  // One extension off ("Ocean Crown.mp4"). The raw name is kept too, for a title like "Dr. Who".
  const names = new Set([full, norm(fileName.trim().replace(/\.[A-Za-z0-9]{1,5}$/, ''))])

  const wanted = new Set<string>()
  if (code) wanted.add(norm(code))
  if (title) {
    const t = norm(title)
    wanted.add(t)
    wanted.add(titleWithoutSubtitle(t))
  }
  for (const n of Array.from(names)) if (n && wanted.has(n)) return 'ok'
  if (code && codeFromFileName(fileName.trim()) === code.toUpperCase()) return 'ok'
  return 'mismatch'
}
