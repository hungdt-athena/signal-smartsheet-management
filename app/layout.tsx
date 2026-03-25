import type { Metadata } from 'next'
import { Baloo_2 } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const baloo = Baloo_2({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'] })

export const metadata: Metadata = { title: 'Signal Management' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={baloo.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
