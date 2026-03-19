import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl
    const role = req.nextauth.token?.role as string | undefined

    const managerPaths = ['/dashboard', '/operations', '/team', '/youtube']
    const evaluatorPaths = ['/handover', '/drive-videos']

    const isManagerPath = managerPaths.some(p => pathname.startsWith(p))
    const isEvaluatorPath = evaluatorPaths.some(p => pathname.startsWith(p))

    if (isManagerPath && role !== 'manager') {
      return NextResponse.redirect(new URL('/handover', req.url))
    }
    if (isEvaluatorPath && role !== 'evaluator') {
      return NextResponse.redirect(new URL('/dashboard', req.url))
    }
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
)

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/operations/:path*',
    '/team/:path*',
    '/youtube/:path*',
    '/handover/:path*',
    '/drive-videos/:path*',
  ],
}
