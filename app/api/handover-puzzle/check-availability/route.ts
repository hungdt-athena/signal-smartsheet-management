import { NextResponse } from 'next/server'
import { readHandoverLog } from '@/lib/google-sheets'

export const dynamic = 'force-dynamic'

/**
 * GET /api/handover-puzzle/check-availability
 *
 * Checks all handover entries and auto-toggles "Today Available":
 * - Set to "No" if today is within the handover date range
 * - Set to "Yes" if today is past the end date (restore availability)
 *
 * Designed to be called by a cron job or n8n schedule.
 */
export async function GET() {
  const getUrl = process.env.WEBHOOK_TEAM_INITIAL_GET
  const availUrl = process.env.WEBHOOK_TEAM_INITIAL_AVAILABILITY
  if (!getUrl || !availUrl) {
    return NextResponse.json({ error: 'Webhook URLs not configured' }, { status: 500 })
  }

  try {
    // 1. Read all handover log entries from Handover sheet's Logging tab
    const handovers = await readHandoverLog()
    const today = new Date().toISOString().split('T')[0]

    // 2. Get current evaluator list
    const listRes = await fetch(getUrl, { cache: 'no-store' })
    if (!listRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch evaluators' }, { status: 502 })
    }
    const evaluators = await listRes.json()

    const changes: { name: string; action: string }[] = []

    // 3. For each evaluator, determine if they should be available
    for (const ev of evaluators) {
      const name = (ev['Evaluator Name'] || '').trim()
      if (!name) continue

      // Only consider success/running entries (not failed submissions)
      const activeHandovers = handovers.filter(h =>
        h.evaluatorName.trim() === name &&
        (h.status === 'success' || h.status === 'running')
      )

      // Check if any handover covers today
      const isOnLeave = activeHandovers.some(h => today >= h.startDate && today <= h.endDate)
      const currentAvail = ev['Today Available']

      if (isOnLeave && currentAvail === 'Yes') {
        // Should be unavailable but currently available -> set to No
        await fetch(availUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ row_number: ev.row_number, today_available: 'No' }),
        })
        changes.push({ name, action: 'set_unavailable' })
      } else if (!isOnLeave && currentAvail === 'No') {
        // Check if this person was previously on handover leave (ended)
        const hadHandover = activeHandovers.some(h => today > h.endDate)
        if (hadHandover) {
          // Handover period ended -> restore availability
          await fetch(availUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ row_number: ev.row_number, today_available: 'Yes' }),
          })
          changes.push({ name, action: 'restored_available' })
        }
      }
    }

    return NextResponse.json({ checked: evaluators.length, changes })
  } catch (err) {
    console.error('Check availability error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
