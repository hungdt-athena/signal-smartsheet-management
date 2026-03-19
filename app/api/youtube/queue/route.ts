import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const webhookUrl = process.env.WEBHOOK_YTB_QUEUE
  if (!webhookUrl) return NextResponse.json({ error: 'YouTube queue webhook not configured' }, { status: 500 })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const res = await fetch(webhookUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return NextResponse.json({ error: 'n8n returned error' }, { status: 502 })
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err: unknown) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Drive request timed out, try again' }, { status: 504 })
    }
    return NextResponse.json({ error: 'Failed to fetch video queue' }, { status: 502 })
  }
}
