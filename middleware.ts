import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    // Skip auth checks in local dev
    if (process.env.SKIP_AUTH === 'true') return NextResponse.next()

    const { pathname } = req.nextUrl
    const role = req.nextauth.token?.role as string | undefined

    // Redirect old /handover → /handover-puzzle (unified layout)
    if (pathname === '/handover' || pathname.startsWith('/handover/')) {
      return NextResponse.redirect(new URL('/handover-puzzle', req.url))
    }

    // Admin-only paths
    const adminPaths = ['/operations', '/team', '/admin']
    const isAdminPath = adminPaths.some(p => pathname.startsWith(p))

    if (isAdminPath && role !== 'admin') {
      return NextResponse.redirect(new URL('/dashboard', req.url))
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
    '/youtube/:path*',
    '/handover-puzzle/:path*',
    '/handover/:path*',
    '/drive-videos/:path*',
    '/admin/:path*',
  ],
}
