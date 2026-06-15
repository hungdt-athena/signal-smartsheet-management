import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    // Skip auth checks in local dev
    if (process.env.SKIP_AUTH === 'true') return NextResponse.next()

    const { pathname, searchParams } = req.nextUrl
    const role = req.nextauth.token?.role as string | undefined
    const isManager = role === 'admin' || role === 'moderator'

    // Redirect old /handover → /handover-puzzle (unified layout)
    if (pathname === '/handover' || pathname.startsWith('/handover/')) {
      return NextResponse.redirect(new URL('/handover-puzzle', req.url))
    }

    // Manager tier (admin + moderator). Mirrors the sidebar `adminOnly` group
    // and the requireManager()/requireRole(['admin','moderator']) API guards.
    const managerPaths = ['/dashboard', '/operations', '/team', '/admin']
    if (managerPaths.some(p => pathname.startsWith(p)) && !isManager) {
      return NextResponse.redirect(new URL('/handover-puzzle', req.url))
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
  ],
}
