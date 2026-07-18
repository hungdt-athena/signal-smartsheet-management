import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    // Skip auth checks in local dev
    if (process.env.SKIP_AUTH === 'true') return NextResponse.next()

    const { pathname, searchParams } = req.nextUrl
    const role = req.nextauth.token?.role as string | undefined
    const isManager = role === 'admin' || role === 'moderator'

    // Default landing for non-managers: the first page visible in their sidebar
    // (Evaluate). Keep in sync with app/page.tsx. Anything they can't see in the
    // sidebar redirects here instead of leaking through by URL.
    const NON_MANAGER_HOME = '/evaluations'

    // Old /handover and /handover-puzzle views were removed — handover now lives in
    // the Team Operations tab. Route to a page the user can actually see.
    if (pathname === '/handover' || pathname.startsWith('/handover/') ||
        pathname === '/handover-puzzle' || pathname.startsWith('/handover-puzzle/')) {
      const canHandover = isManager || role === 'evaluator'
      return NextResponse.redirect(new URL(canHandover ? '/team-ops?tab=handover' : NON_MANAGER_HOME, req.url))
    }

    // Team Operations: managers get every tab. Evaluators get the (scoped) Assign
    // and Handover tabs only — Reassign redirects to Assign. Mirrors the sidebar
    // child gating and the per-role API scoping. Non-evaluators → home.
    const isEvaluator = role === 'evaluator'
    const evaluatorTabs = ['assign', 'handover']
    if (pathname === '/team-ops' || pathname.startsWith('/team-ops/')) {
      if (!isManager) {
        if (!isEvaluator) return NextResponse.redirect(new URL(NON_MANAGER_HOME, req.url))
        const tab = searchParams.get('tab') || 'assign'
        if (!evaluatorTabs.includes(tab)) return NextResponse.redirect(new URL('/team-ops?tab=assign', req.url))
      }
    }

    // Report: admin-only. Moderators fall back to their manager home (Dashboard);
    // evaluators to theirs. /api/report enforces the same guard server-side.
    if ((pathname === '/report' || pathname.startsWith('/report/')) && role !== 'admin') {
      return NextResponse.redirect(new URL(isManager ? '/dashboard' : NON_MANAGER_HOME, req.url))
    }

    // Users Management & Config stay manager-only.
    const managerPaths = ['/admin', '/config']
    if (managerPaths.some(p => pathname === p || pathname.startsWith(p + '/')) && !isManager) {
      return NextResponse.redirect(new URL(NON_MANAGER_HOME, req.url))
    }

    // In-development views hidden from non-admins (mirror the nav children
    // gated with roles:['admin']). Same data endpoints stay open because they
    // are shared with always-visible views (e.g. Short List's category filter);
    // enforcement here is at the view/query level, redirecting to the default
    // sibling tab rather than blocking.
    if (role !== 'admin') {
      const cat = searchParams.get('cat') ?? ''
      const tab = searchParams.get('tab') ?? ''
      if (pathname.startsWith('/evaluations') && (cat === 'arcade' || cat === 'simulation')) {
        return NextResponse.redirect(new URL('/evaluations?cat=puzzle', req.url))
      }
      if (pathname.startsWith('/youtube') && (tab === 'short_list' || tab === 'record_video')) {
        return NextResponse.redirect(new URL('/youtube?tab=youtube', req.url))
      }
    }
  },
  {
    callbacks: {
      authorized: ({ token }) => process.env.SKIP_AUTH === 'true' || !!token,
    },
  }
)

export const config = {
  matcher: [
    '/team-ops/:path*',
    '/evaluations/:path*',
    '/youtube/:path*',
    '/report/:path*',
    '/handover-puzzle/:path*',
    '/handover/:path*',
    '/drive-videos/:path*',
    '/admin/:path*',
    '/config/:path*',
  ],
}
