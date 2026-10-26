import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import './styles/evaluations.css'
import './styles/record.css'
import './styles/teamops.css'
import './styles/tagging-weekly.css'
import './styles/performance.css'
import './styles/panel.css'
import './styles/admin-misc.css'
import { Providers } from './providers'
import VersionWatcher from '@/components/VersionWatcher'
import { Toaster } from '@/components/ui/Toaster'

// IBM Plex, latin subset, served from the repo. next/font/google fetched it from
// Google at build time and crashed the Replit build whenever Google answered with a
// font URL without a file extension (loader.js: "Cannot read properties of null").
// Sans is a variable font: one file covers 400-700.
const ibmPlexSans = localFont({
  src: './fonts/ibm-plex-sans-var.woff2',
  weight: '400 700',
  variable: '--font-ibm-plex-sans',
})

const ibmPlexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
})

export const metadata: Metadata = { title: 'Signal - Playtest Management' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
        <Providers>{children}</Providers>
        <VersionWatcher />
        <Toaster />
      </body>
    </html>
  )
}
