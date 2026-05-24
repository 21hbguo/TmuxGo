import type { Metadata, Viewport } from 'next'
import './globals.css'
import { QueryProvider } from '@/components/QueryProvider'
import { I18nProvider } from '@/i18n'

export const metadata: Metadata = {
  title: 'tmuxU - Web Console',
  description: 'Web-based tmux session manager',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
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
