import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    // Skip auth checks in local dev
    if (process.env.SKIP_AUTH === 'true') return NextResponse.next()

    const { pathname } = req.nextUrl
    const role = req.nextauth.token?.role as string | undefined

    // Admin-only paths
    const adminPaths = ['/operations', '/team', '/admin']
    const isAdminPath = adminPaths.some(p => pathname.startsWith(p))

    // Paths accessible by both roles
    const sharedPaths = ['/dashboard', '/handover-puzzle', '/handover', '/youtube', '/drive-videos']
    const isSharedPath = sharedPaths.some(p => pathname.startsWith(p))

    if (isAdminPath && role !== 'admin') {
      return NextResponse.redirect(new URL('/dashboard', req.url))
    }

    // All authenticated users can access shared paths
    if (isSharedPath) return NextResponse.next()
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
