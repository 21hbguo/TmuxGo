import { useState } from 'react'
import { FiBox, FiExternalLink, FiGithub, FiLink, FiPlay, FiRefreshCw, FiTrash2 } from 'react-icons/fi'
import { useInstallGitHubPlugin, useInvokePluginAction, useLinkPlugin, usePlugins, usePreviewGitHubPlugin, useSetPluginEnabled, useUninstallPlugin } from '@/hooks/useApi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import type { GitHubPluginPreview, PluginInfo } from '@/types'
import { ConfirmDialog } from './ConfirmDialog'

function PluginState({ plugin }: { plugin: PluginInfo }) {
  const { t } = useTranslation()
  const className = plugin.state === 'active' ? 'bg-emerald-500/12 text-emerald-300' : plugin.state === 'disabled' ? 'bg-bg-1 text-text-3' : 'bg-red-500/12 text-red-300'
  return <span className={`rounded px-2 py-0.5 text-[10px] ${className}`}>{t(`plugins.state.${plugin.state}` as any)}</span>
}
export function PluginSettings() {
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { data, isLoading, refetch } = usePlugins()
  const linkPlugin = useLinkPlugin()
  const setEnabled = useSetPluginEnabled()
  const uninstall = useUninstallPlugin()
  const invoke = useInvokePluginAction()
  const previewGitHub = usePreviewGitHubPlugin()
  const installGitHub = useInstallGitHubPlugin()
  const [localPath, setLocalPath] = useState('')
  const [githubSource, setGithubSource] = useState('')
  const [githubRef, setGithubRef] = useState('')
  const [preview, setPreview] = useState<GitHubPluginPreview | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PluginInfo | null>(null)
  const plugins = data?.plugins || []
  const context = { hostId: activeHostId || 'local', sessionId: activeSessionId || '', paneId: activePaneId || '', source: 'settings' }
  const notifyError = (error: unknown) => pushToast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  const handleLink = async () => {
    if (!localPath.trim()) return
    try {
      const plugin = await linkPlugin.mutateAsync(localPath.trim())
      setLocalPath('')
      pushToast({ type: 'success', message: t('plugins.linked', { name: plugin.manifest.name }) })
    } catch (error) {
      notifyError(error)
    }
  }
  const handlePreview = async () => {
    if (!githubSource.trim()) return
    try {
      setPreview(await previewGitHub.mutateAsync({ source: githubSource.trim(), ref: githubRef.trim() || undefined }))
    } catch (error) {
      notifyError(error)
    }
  }
  const handleInstall = async () => {
    if (!preview) return
    try {
      const plugin = await installGitHub.mutateAsync({ source: preview.source, resolvedCommit: preview.resolvedCommit, ref: githubRef.trim() || undefined })
      setPreview(null)
      setGithubSource('')
      setGithubRef('')
      pushToast({ type: 'success', message: t('plugins.installed', { name: plugin.manifest.name }) })
    } catch (error) {
      notifyError(error)
    }
  }
  const handleInvoke = async (plugin: PluginInfo, actionId: string) => {
    try {
      const log = await invoke.mutateAsync({ pluginId: plugin.pluginId, actionId, context })
      if (log.status !== 'success') throw new Error(log.error || log.stderr || t('plugins.actionFailed'))
      pushToast({ type: 'success', message: log.stdout.trim() || t('plugins.actionComplete') })
    } catch (error) {
      notifyError(error)
    }
  }
  return <div className="space-y-5">
    <div className="grid gap-3 md:grid-cols-2">
      <section className="rounded border border-[var(--line)] bg-bg-2 p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-1"><FiLink size={15} />{t('plugins.localLink')}</div>
        <div className="flex gap-2"><input value={localPath} onChange={(event) => setLocalPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleLink() }} placeholder={t('plugins.localPath')} className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs" /><button onClick={() => void handleLink()} disabled={!localPath.trim() || linkPlugin.isPending} className="tmuxgo-button tmuxgo-button--primary tmuxgo-button--icon-sm tmuxgo-icon-button" aria-label={t('plugins.link')} title={t('plugins.link')}><FiLink size={14} /></button></div>
      </section>
      <section className="rounded border border-[var(--line)] bg-bg-2 p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-1"><FiGithub size={15} />{t('plugins.githubInstall')}</div>
        <div className="grid grid-cols-[1fr_88px_32px] gap-2"><input value={githubSource} onChange={(event) => { setGithubSource(event.target.value); setPreview(null) }} placeholder="owner/repo[/subdir]" className="tmuxgo-control tmuxgo-input min-w-0 rounded px-2 py-1.5 font-mono text-xs" /><input value={githubRef} onChange={(event) => { setGithubRef(event.target.value); setPreview(null) }} placeholder="ref" className="tmuxgo-control tmuxgo-input min-w-0 rounded px-2 py-1.5 font-mono text-xs" /><button onClick={() => void handlePreview()} disabled={!githubSource.trim() || previewGitHub.isPending} className="tmuxgo-button tmuxgo-button--primary tmuxgo-button--icon-sm tmuxgo-icon-button" aria-label={t('plugins.preview')} title={t('plugins.preview')}><FiExternalLink size={14} /></button></div>
      </section>
    </div>
    {preview && <section className="rounded border border-accent/35 bg-accent/[0.06] p-4">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="text-sm font-medium text-text-1">{preview.manifest.name} <span className="ml-1 font-mono text-xs text-text-3">v{preview.manifest.version}</span></div><div className="mt-1 truncate font-mono text-[10px] text-text-3">{preview.source}@{preview.resolvedCommit.slice(0, 12)}</div></div><button onClick={() => void handleInstall()} disabled={installGitHub.isPending} className="tmuxgo-button tmuxgo-button--primary tmuxgo-button--sm">{preview.replacing ? t('plugins.update') : t('plugins.install')}</button></div>
      <div className="mt-3 text-xs text-text-2">{t('plugins.trustWarning')}</div>
      {!!(preview.manifest.build?.length || preview.manifest.contributes?.actions?.length || preview.manifest.contributes?.events?.length) && <div className="mt-2 space-y-1 break-all font-mono text-[10px] text-text-3">{preview.manifest.build?.map((build, index) => <div key={`build-${index}`}>build $ {build.command.join(' ')}</div>)}{preview.manifest.contributes?.actions?.map((action) => <div key={`action-${action.id}`}>action:{action.id} $ {action.command.join(' ')}</div>)}{preview.manifest.contributes?.events?.map((event, index) => <div key={`event-${event.on}-${index}`}>event:{event.on} $ {event.command.join(' ')}</div>)}</div>}
    </section>}
    <div className="flex items-center justify-between"><div><h3 className="text-sm font-medium text-text-1">{t('plugins.installedTitle')}</h3><p className="mt-1 text-xs text-text-3">{t('plugins.installedCount', { count: plugins.length })}</p></div><button onClick={() => void refetch()} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--icon-sm tmuxgo-icon-button" aria-label={t('common.refresh')} title={t('common.refresh')}><FiRefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /></button></div>
    <div className="space-y-2">
      {!isLoading && !plugins.length && <div className="rounded border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm text-text-3">{t('plugins.empty')}</div>}
      {plugins.map((plugin) => <section key={plugin.pluginId} className="rounded border border-[var(--line)] bg-bg-2 p-3">
        <div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-bg-1 text-text-2"><FiBox size={16} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-text-1">{plugin.manifest.name}</span><PluginState plugin={plugin} /><span className="font-mono text-[10px] text-text-3">v{plugin.manifest.version}</span></div><div className="mt-1 truncate text-xs text-text-3">{plugin.manifest.description || plugin.pluginId}</div><div className="mt-1 truncate font-mono text-[10px] text-text-3">{plugin.source.kind === 'github' ? `${plugin.source.owner}/${plugin.source.repo}${plugin.source.subdir ? `/${plugin.source.subdir}` : ''}@${plugin.source.resolvedCommit?.slice(0, 8) || ''}` : plugin.root}</div>{plugin.error && <div className="mt-2 text-xs text-red-300">{plugin.error}</div>}</div><button onClick={() => void setEnabled.mutateAsync({ pluginId: plugin.pluginId, enabled: !plugin.enabled }).catch(notifyError)} className={`relative h-6 w-10 shrink-0 rounded-full ${plugin.enabled ? 'bg-accent' : 'bg-bg-1'}`} aria-label={t('plugins.toggle')} aria-pressed={plugin.enabled}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${plugin.enabled ? 'right-1' : 'left-1'}`} /></button></div>
        {(plugin.manifest.contributes?.actions?.length || plugin.manifest.contributes?.views?.length) && <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--line)] pt-3">{plugin.manifest.contributes?.actions?.map((action) => <button key={action.id} onClick={() => void handleInvoke(plugin, action.id)} disabled={plugin.state !== 'active' || invoke.isPending} className="tmuxgo-chip flex items-center gap-1.5"><FiPlay size={11} />{action.title}</button>)}{plugin.manifest.contributes?.views?.map((view) => <button key={view.id} onClick={() => window.dispatchEvent(new CustomEvent('tmuxgo-open-plugin-view', { detail: { pluginId: plugin.pluginId, viewId: view.id } }))} disabled={plugin.state !== 'active'} className="tmuxgo-chip flex items-center gap-1.5"><FiExternalLink size={11} />{view.title}</button>)}<button onClick={() => setPendingDelete(plugin)} className="tmuxgo-chip tmuxgo-chip--danger ml-auto flex items-center gap-1.5"><FiTrash2 size={12} />{t('plugins.uninstall')}</button></div>}
        {!plugin.manifest.contributes?.actions?.length && !plugin.manifest.contributes?.views?.length && <div className="mt-3 flex justify-end border-t border-[var(--line)] pt-3"><button onClick={() => setPendingDelete(plugin)} className="tmuxgo-chip tmuxgo-chip--danger flex items-center gap-1.5"><FiTrash2 size={12} />{t('plugins.uninstall')}</button></div>}
      </section>)}
    </div>
    <ConfirmDialog open={!!pendingDelete} title={t('plugins.uninstallTitle')} message={t('plugins.uninstallMessage', { name: pendingDelete?.manifest.name || '' })} confirmLabel={t('plugins.uninstall')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDelete(null)} onConfirm={() => { if (!pendingDelete) return; void uninstall.mutateAsync({ pluginId: pendingDelete.pluginId }).then(() => setPendingDelete(null)).catch(notifyError) }} />
  </div>
}
