import { ConsoleLayout } from '@/components/ConsoleLayout'
import { headers } from 'next/headers'

export default function Home() {
  const ua=headers().get('user-agent')||''
  const initialIsMobile=/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(ua)
  return (
    <main className="flex h-screen">
      <ConsoleLayout initialIsMobile={initialIsMobile} />
    </main>
  )
}
