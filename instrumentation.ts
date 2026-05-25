export async function register() {
  // Only run on the server runtime (not edge, not build)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const ONE_HOUR = 60 * 60 * 1000

    // Check every hour; the handler itself is idempotent and fast
    setInterval(async () => {
      try {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
        await fetch(`${baseUrl}/api/handover-puzzle/check-availability`, { cache: 'no-store' })
        console.log('[cron] availability check done')
      } catch (err) {
        console.error('[cron] availability check failed:', err)
      }
    }, ONE_HOUR)

    console.log('[cron] availability check scheduled (every 1h)')
  }
}
