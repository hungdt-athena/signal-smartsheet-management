import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth-guard'
import { mimeForExt, objectNameFromUrl, readScreenshot } from '@/lib/screenshot-store'

export const dynamic = 'force-dynamic'

// Serves manually uploaded screenshots. Replit Object Storage has no public-URL
// API, so the bytes come back through the app instead of a CDN. That is not a
// pure cost: the old Supabase bucket was public to anyone holding the link,
// while these are readable only by a signed-in user, and the app and the bucket
// now sit in the same region.
//
// Object names are content-addressed by upload timestamp and never rewritten,
// so the response is immutable and the browser fetches each image exactly once.

export async function GET(
  _req: Request,
  { params }: { params: { path: string[] } },
) {
  const guard = await requireAuth()
  if (guard) return guard

  // Route the segments back through the same parser the delete path uses, so
  // traversal and malformed encodings are rejected in one place.
  const objectName = objectNameFromUrl(
    `/api/screenshots/${params.path.map(encodeURIComponent).join('/')}`,
  )
  if (!objectName) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ext = objectName.split('.').pop()?.toLowerCase() || ''
  const mime = mimeForExt(ext)
  if (mime === 'application/octet-stream') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const bytes = await readScreenshot(objectName)
    if (!bytes) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    console.error('GET /api/screenshots error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
