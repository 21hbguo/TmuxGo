import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ConsoleLayout } from '@/components/ConsoleLayout'
import { DropGuard } from '@/components/DropGuard'
import { QueryProvider } from '@/components/QueryProvider'
import { I18nProvider } from '@/i18n'
import { recoverFromChunkLoadError } from '@/lib/chunk-recovery'
import { GlassPointerEffect } from '@/components/GlassPointerEffect'

const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, _: ErrorInfo) {
    if (recoverFromChunkLoadError(error.message || '', window.sessionStorage, () => window.location.reload())) return
  }
  render() {
    if (!this.state.error) return this.props.children
    return <main className="flex min-h-screen items-center justify-center bg-bg-0 p-8 text-text-1"><div className="max-w-md text-center"><h1 className="text-xl">客户端异常</h1><p className="mt-3 text-sm text-text-2">{this.state.error.message || '渲染过程中发生错误'}</p><button onClick={() => this.setState({ error: null })} className="mt-6 rounded bg-accent px-4 py-2 text-sm text-white">重新加载</button></div></main>
  }
}
export function App() {
  const initialIsMobile = MOBILE_USER_AGENT.test(navigator.userAgent)
  return <AppErrorBoundary><GlassPointerEffect /><QueryProvider><I18nProvider><DropGuard /><main className="flex min-h-0"><ConsoleLayout initialIsMobile={initialIsMobile} /></main></I18nProvider></QueryProvider></AppErrorBoundary>
}
