import { useEffect, useMemo, useRef } from 'react'
import { FiBox, FiX } from 'react-icons/fi'
import { api } from '@/lib/api'
import { getApiBase } from '@/lib/runtime-endpoints'
import { usePlugins } from '@/hooks/useApi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

interface PluginViewProps {
  pluginId: string
  viewId: string
  mode?: 'panel' | 'mobile'
  onClose: () => void
}
interface PluginBridgeRequest {
  source: 'tmuxgo-plugin'
  type: 'request' | 'ready'
  id?: string
  pluginId: string
  viewId: string
  method?: string
  params?: Record<string, unknown>
}

export function PluginView({ pluginId, viewId, mode = 'panel', onClose }: PluginViewProps) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const { data } = usePlugins()
  const plugin = data?.plugins.find((item) => item.pluginId === pluginId)
  const view = plugin?.manifest.contributes?.views?.find((item) => item.id === viewId)
  const context = useMemo(() => ({ hostId: activeHostId || 'local', sessionId: activeSessionId || '', paneId: activePaneId || '', source: 'plugin-view', pluginId, viewId }), [activeHostId, activePaneId, activeSessionId, pluginId, viewId])
  const url = view ? `${getApiBase()}/api/plugins/${encodeURIComponent(pluginId)}/assets/${view.entry.split('/').map(encodeURIComponent).join('/')}?viewId=${encodeURIComponent(viewId)}` : ''
  useEffect(() => {
    const handleMessage = async (event: MessageEvent<PluginBridgeRequest>) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const message = event.data
      if (!message || message.source !== 'tmuxgo-plugin' || message.pluginId !== pluginId || message.viewId !== viewId) return
      if (message.type === 'ready') {
        iframeRef.current?.contentWindow?.postMessage({ source: 'tmuxgo-host', type: 'context', pluginId, viewId, context }, '*')
        return
      }
      if (message.type !== 'request' || !message.id || !message.method) return
      const params = message.params || {}
      try {
        let result: unknown
        if (message.method === 'context.get') result = context
        else if (message.method === 'storage.list') result = (await api.plugins.storage.list(pluginId)).keys
        else if (message.method === 'storage.get') result = (await api.plugins.storage.get(pluginId, String(params.key || ''))).value
        else if (message.method === 'storage.set') result = await api.plugins.storage.set(pluginId, String(params.key || ''), params.value)
        else if (message.method === 'storage.delete') result = await api.plugins.storage.remove(pluginId, String(params.key || ''))
        else if (message.method === 'action.invoke') result = await api.plugins.invoke(pluginId, String(params.actionId || ''), { ...(params.context && typeof params.context === 'object' ? params.context as Record<string, unknown> : {}), ...context, source: 'plugin-view' })
        else if (message.method === 'ui.notify') {
          const level = params.level === 'error' ? 'error' : params.level === 'success' ? 'success' : 'info'
          pushToast({ type: level, message: String(params.message || '') })
          result = { ok: true }
        } else throw new Error('Unsupported plugin bridge method')
        iframeRef.current?.contentWindow?.postMessage({ source: 'tmuxgo-host', type: 'response', id: message.id, pluginId, ok: true, result }, '*')
      } catch (error) {
        iframeRef.current?.contentWindow?.postMessage({ source: 'tmuxgo-host', type: 'response', id: message.id, pluginId, ok: false, error: error instanceof Error ? error.message : String(error) }, '*')
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [context, pluginId, pushToast, viewId])
  if (!plugin || !view || plugin.state !== 'active') return <div className="flex h-full items-center justify-center p-4 text-sm text-text-3">{t('plugins.viewUnavailable')}</div>
  const width = Math.max(240, Math.min(720, view.width || 360))
  return <section className={`tmuxgo-content-surface flex min-h-0 flex-col overflow-hidden ${mode === 'panel' ? 'shrink-0 border-r border-[var(--line)]' : 'h-full w-full'}`} style={mode === 'panel' ? { width } : undefined}>
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3"><span className="flex h-6 w-6 items-center justify-center rounded bg-bg-2 text-accent"><FiBox size={13} /></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-text-1">{view.title}</div><div className="truncate text-[10px] text-text-3">{plugin.manifest.name}</div></div><button onClick={onClose} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--icon-sm tmuxgo-icon-button" aria-label={t('common.close')} title={t('common.close')}><FiX size={15} /></button></header>
    <iframe ref={iframeRef} src={url} title={`${plugin.manifest.name}: ${view.title}`} sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-bg-0" />
  </section>
}
