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

    // Old /handover view was removed. Route to a page the user can actually see.
    if (pathname === '/handover' || pathname.startsWith('/handover/')) {
      return NextResponse.redirect(new URL(isManager ? '/handover-puzzle' : NON_MANAGER_HOME, req.url))
    }

    // Manager-tier pages (admin + moderator) — exactly the Smartsheet group plus
    // Users Management & Config. These never appear in a non-manager sidebar, so
    // a non-manager hitting any of them by URL is bounced to their home.
    // Mirrors the sidebar `adminOnly`/roles gating and the requireManager() API guards.
    const managerPaths = ['/dashboard', '/operations', '/team', '/handover-puzzle', '/admin', '/config']
    if (managerPaths.some(p => pathname === p || pathname.startsWith(p + '/')) && !isManager) {
      return NextResponse.redirect(new URL(NON_MANAGER_HOME, req.url))
    }

    // Assign Setup is a manager-only sub-view of Evaluations (sidebar child
    // gated roles:['admin','moderator']). Bounce non-managers reaching it by URL.
    if (!isManager && pathname.startsWith('/evaluations') && searchParams.get('cat') === 'assign_setup') {
      return NextResponse.redirect(new URL('/evaluations?cat=evaluate', req.url))
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
    '/dashboard/:path*',
    '/operations/:path*',
    '/team/:path*',
    '/evaluations/:path*',
    '/youtube/:path*',
    '/handover-puzzle/:path*',
    '/handover/:path*',
    '/drive-videos/:path*',
    '/admin/:path*',
    '/config/:path*',
  ],
}
