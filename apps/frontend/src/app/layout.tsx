import type { Metadata, Viewport } from 'next'
import './globals.css'
import { QueryProvider } from '@/components/QueryProvider'
import { I18nProvider } from '@/i18n'
import { DropGuard } from '@/components/DropGuard'

export const metadata: Metadata = {
  title: 'TmuxGo',
  description: 'Web-based tmux session manager',
  applicationName: 'TmuxGo',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TmuxGo',
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#071224',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: "document.addEventListener('contextmenu',function(e){e.preventDefault()},{passive:false})" }} />
        <script dangerouslySetInnerHTML={{ __html: "addEventListener('dragover',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-terminal]');if(!t){e.preventDefault();e.stopPropagation();if(e.dataTransfer)e.dataTransfer.dropEffect='none'}},true);addEventListener('drop',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-terminal]');if(!t){e.preventDefault();e.stopPropagation()}},true)" }} />
        <QueryProvider>
          <I18nProvider><DropGuard />{children}</I18nProvider>
        </QueryProvider>
      </body>
    </html>
  )
}
