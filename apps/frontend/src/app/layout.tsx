import type { Metadata, Viewport } from 'next'
import './globals.css'
import { QueryProvider } from '@/components/QueryProvider'
import { I18nProvider } from '@/i18n'

export const metadata: Metadata = {
  title: 'tmuxU',
  description: 'Web-based tmux session manager',
  applicationName: 'tmuxU',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'tmuxU',
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
        <QueryProvider>
          <I18nProvider>{children}</I18nProvider>
        </QueryProvider>
      </body>
    </html>
  )
}
