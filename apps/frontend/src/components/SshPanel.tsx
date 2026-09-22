'use client'
import { useEffect, useState } from 'react'
import { FiCode, FiFileText, FiRefreshCw, FiStar } from 'react-icons/fi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import {
  useAddSshConfigHost,
  useCreateHost,
  useDeleteHost,
  useHosts,
  useHostsConfig,
  useRemoveAgent,
  useResolveSshHost,
  useSaveHostsConfig,
  useSaveSshConfig,
  useSessions,
  useSshConfig,
  useTestHost,
} from '@/hooks/useApi'
import { type CredentialStoreFile, type HostStoreFile } from '@/lib/api'
import { useTranslation } from '@/i18n'
import { useClipboard } from '@/hooks/useClipboard'
import { Button } from './Button'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { Select } from './Select'

function StatusDot({ host }: { host: any }) {
  const isOnline = host.agent ? host.agent.online === true : host.status === 'online'
  const isWarn = !host.agent && (host.status === 'unknown' || host.status === 'unreachable')
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? 'bg-green-400' : isWarn ? 'bg-yellow-400' : 'bg-danger'}`}
    />
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="shrink-0 text-text-3">{label}</span>
      <span className="min-w-0 truncate text-text-1">{value}</span>
    </div>
  )
}

function baseName(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

// `user@host` / `host` 快速输入 → Host 块字段（对齐 VSCode Remote-SSH 的添加语义）
function parseQuickAddInput(raw: string) {
  const value = raw.trim()
  if (!value || /[\s#]/.test(value)) return null
  const at = value.lastIndexOf('@')
  if (at < 0) return { alias: value, hostName: value }
  const user = value.slice(0, at)
  const host = value.slice(at + 1)
  if (!user || !host) return null
  return { alias: host, hostName: host, user }
}

export function SshPanel() {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const sshPanelOpen = useConsoleStore((state) => state.sshPanelOpen)
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const toggleSshPanel = useConsoleStore((state) => state.toggleSshPanel)
  const { data: hosts = [], refetch: refetchHosts } = useHosts()
  const createHost = useCreateHost()
  const deleteHost = useDeleteHost()
  const testHost = useTestHost()
  const removeAgent = useRemoveAgent()
  const resolveHost = useResolveSshHost()
  const addSshConfigHost = useAddSshConfigHost()
  const saveSshConfig = useSaveSshConfig()
  const { copy } = useClipboard()
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [attachHostId, setAttachHostId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [quickAddDraft, setQuickAddDraft] = useState('')
  const [hostIdDraft, setHostIdDraft] = useState('')
  const [hostNameDraft, setHostNameDraft] = useState('')
  const [hostAddressDraft, setHostAddressDraft] = useState('')
  const [hostUserDraft, setHostUserDraft] = useState('')
  const [hostPortDraft, setHostPortDraft] = useState('22')
  const [hostPasswordDraft, setHostPasswordDraft] = useState('')
  const [hostPrivateKeyPathDraft, setHostPrivateKeyPathDraft] = useState('')
  const [hostGroupsDraft, setHostGroupsDraft] = useState('')
  const [hostTagsDraft, setHostTagsDraft] = useState('')
  const [hostFavoriteDraft, setHostFavoriteDraft] = useState(false)
  const [hostUseAgentDraft, setHostUseAgentDraft] = useState(true)
  const [hostJumpHostDraft, setHostJumpHostDraft] = useState('')
  const [hostKnownHostsPolicyDraft, setHostKnownHostsPolicyDraft] = useState<'strict' | 'accept-new' | 'off'>(
    'accept-new',
  )
  const [hostDialogOpen, setHostDialogOpen] = useState(false)
  const [hostDialogMode, setHostDialogMode] = useState<'create' | 'edit'>('create')
  const [hostDialogSshConfig, setHostDialogSshConfig] = useState(false)
  const [hostActionMessage, setHostActionMessage] = useState('')
  const [pendingDeleteHostId, setPendingDeleteHostId] = useState<string | null>(null)
  const [userMapDraft, setUserMapDraft] = useState('')
  const [allowedHostsDraft, setAllowedHostsDraft] = useState('')
  const [jsonConfigOpen, setJsonConfigOpen] = useState(false)
  const [hostsJsonDraft, setHostsJsonDraft] = useState('')
  const [credentialsJsonDraft, setCredentialsJsonDraft] = useState('')
  const [jsonConfigError, setJsonConfigError] = useState('')
  const [sshConfigOpen, setSshConfigOpen] = useState(false)
  const [sshConfigDraft, setSshConfigDraft] = useState('')
  const [sshConfigError, setSshConfigError] = useState('')
  const [resolvedDetails, setResolvedDetails] = useState<
    Record<
      string,
      | {
          hostname: string
          user: string
          port: number
          identityFiles: string[]
          proxyJump: string
          forwardAgent: string
          strictHostKeyChecking: string
        }
      | 'error'
    >
  >({})
  const hostsConfig = useHostsConfig(jsonConfigOpen)
  const saveHostsConfig = useSaveHostsConfig()
  const sshConfig = useSshConfig(sshConfigOpen)
  const { data: sessions = [] } = useSessions(attachHostId || '')
  const localHosts = hosts.filter((host: any) => host.id === 'local')
  const agentHosts = hosts.filter((host: any) => host.id !== 'local' && (host.agent || host.connectionMode === 'agent'))
  const remoteHosts = hosts.filter(
    (host: any) => host.id !== 'local' && !(host.agent || host.connectionMode === 'agent'),
  )
  const selectedHost = hosts.find((host: any) => host.id === selectedHostId) || null
  const pendingDeleteHost = hosts.find((host: any) => host.id === pendingDeleteHostId)
  const toggleGroup = (group: string) => setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }))
  // 远程主机按来源文件分组（VSCode Remote Explorer 语义）：每个 ssh config 文件一组，hosts.json 托管条目一组
  const remoteGroups = (() => {
    const groups = new Map<string, { title: string; hosts: any[] }>()
    for (const host of remoteHosts) {
      const key = host.source === 'sshconfig' && host.configFile ? host.configFile : 'hosts.json'
      const entry = groups.get(key) || { title: key === 'hosts.json' ? 'hosts.json' : baseName(key), hosts: [] }
      entry.hosts.push(host)
      groups.set(key, entry)
    }
    for (const group of groups.values())
      group.hosts.sort(
        (a, b) =>
          Number(b.favorite === true) - Number(a.favorite === true) ||
          String(a.name || a.id).localeCompare(String(b.name || b.id)),
      )
    return [...groups.entries()].sort(
      ([a], [b]) => (a === 'hosts.json' ? 1 : 0) - (b === 'hosts.json' ? 1 : 0) || a.localeCompare(b),
    )
  })()
  useEffect(() => {
    if (jsonConfigOpen && hostsConfig.data) {
      setHostsJsonDraft(JSON.stringify(hostsConfig.data.hosts, null, 2))
      setCredentialsJsonDraft(JSON.stringify(hostsConfig.data.credentials, null, 2))
    }
  }, [jsonConfigOpen, hostsConfig.data])
  useEffect(() => {
    if (sshConfigOpen && sshConfig.data) setSshConfigDraft(sshConfig.data.content)
  }, [sshConfigOpen, sshConfig.data])
  const openJsonConfig = () => {
    setJsonConfigError('')
    setJsonConfigOpen(true)
  }
  const closeJsonConfig = () => {
    setJsonConfigOpen(false)
    setJsonConfigError('')
  }
  const saveJsonConfig = async () => {
    setJsonConfigError('')
    let hosts: HostStoreFile | undefined
    let credentials: CredentialStoreFile | undefined
    try {
      if (hostsJsonDraft.trim()) hosts = JSON.parse(hostsJsonDraft) as HostStoreFile
      if (credentialsJsonDraft.trim()) credentials = JSON.parse(credentialsJsonDraft) as CredentialStoreFile
    } catch {
      setJsonConfigError(t('sshPanel.jsonConfigInvalid'))
      return
    }
    try {
      await saveHostsConfig.mutateAsync({ hosts, credentials })
      setJsonConfigOpen(false)
      setJsonConfigError('')
      pushToast({ type: 'success', message: t('sshPanel.jsonConfigSaved') })
    } catch (err: any) {
      setJsonConfigError(err?.message || t('sshPanel.jsonConfigSaveFailed'))
    }
  }
  const openSshConfig = () => {
    setSshConfigError('')
    setSshConfigOpen(true)
  }
  const closeSshConfig = () => {
    setSshConfigOpen(false)
    setSshConfigError('')
  }
  const saveSshConfigText = async () => {
    setSshConfigError('')
    try {
      await saveSshConfig.mutateAsync(sshConfigDraft)
      setSshConfigOpen(false)
      pushToast({ type: 'success', message: t('sshPanel.sshConfigSaved') })
    } catch (err: any) {
      setSshConfigError(err?.message || t('sshPanel.sshConfigSaveFailed'))
    }
  }
  const quickAddHost = async () => {
    const parsed = parseQuickAddInput(quickAddDraft)
    if (!parsed) {
      setHostActionMessage(t('sshPanel.quickAddInvalid'))
      return
    }
    try {
      await addSshConfigHost.mutateAsync(parsed)
      setQuickAddDraft('')
      setHostActionMessage(t('sshPanel.quickAddDone', { alias: parsed.alias }))
    } catch (err: any) {
      setHostActionMessage(err?.message || t('sshPanel.quickAddFailed'))
    }
  }
  const resetHostDraft = () => {
    setHostIdDraft('')
    setHostNameDraft('')
    setHostAddressDraft('')
    setHostUserDraft('')
    setHostPortDraft('22')
    setHostPasswordDraft('')
    setHostPrivateKeyPathDraft('')
    setHostGroupsDraft('')
    setHostTagsDraft('')
    setHostFavoriteDraft(false)
    setHostUseAgentDraft(true)
    setHostJumpHostDraft('')
    setHostKnownHostsPolicyDraft('accept-new')
    setHostDialogSshConfig(false)
  }
  const openCreateHostDialog = () => {
    resetHostDraft()
    setHostDialogMode('create')
    setHostDialogOpen(true)
    setHostActionMessage('')
  }
  const openEditHostDialog = (host: any) => {
    setHostIdDraft(host.id || '')
    setHostNameDraft(host.name || '')
    setHostAddressDraft(host.address || '')
    setHostUserDraft(host.user || '')
    setHostPortDraft(String(host.port || 22))
    setHostPasswordDraft('')
    setHostPrivateKeyPathDraft('')
    setHostGroupsDraft(Array.isArray(host.groups) ? host.groups.join(', ') : '')
    setHostTagsDraft(
      Array.isArray(host.userTags) ? host.userTags.join(', ') : Array.isArray(host.tags) ? host.tags.join(', ') : '',
    )
    setHostFavoriteDraft(host.favorite === true)
    setHostUseAgentDraft(host.usesAgent !== false)
    setHostJumpHostDraft(host.jumpHost || '')
    setHostKnownHostsPolicyDraft(host.knownHostsPolicy || 'accept-new')
    setHostDialogSshConfig(host.source === 'sshconfig')
    setHostDialogMode('edit')
    setHostDialogOpen(true)
    setHostActionMessage('')
  }
  const closeHostDialog = () => {
    setHostDialogOpen(false)
    setHostPasswordDraft('')
    setHostPrivateKeyPathDraft('')
  }
  const saveHost = async () => {
    setHostActionMessage('')
    try {
      await createHost.mutateAsync({
        id: hostIdDraft.trim(),
        name: hostNameDraft.trim() || undefined,
        address: hostAddressDraft.trim(),
        user: hostUserDraft.trim(),
        port: Number(hostPortDraft || '22') || 22,
        password: hostPasswordDraft ? hostPasswordDraft : undefined,
        privateKeyPath: hostPrivateKeyPathDraft || undefined,
        groups: hostGroupsDraft
          .split(',')
          .map((group) => group.trim())
          .filter(Boolean),
        tags: hostTagsDraft
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        favorite: hostFavoriteDraft,
        useAgent: hostUseAgentDraft,
        jumpHost: hostJumpHostDraft,
        knownHostsPolicy: hostKnownHostsPolicyDraft,
      })
      setHostActionMessage(t('sshPanel.saved'))
      closeHostDialog()
      resetHostDraft()
    } catch (err: any) {
      setHostActionMessage(err?.message || t('sshPanel.saveFailed'))
    }
  }
  const toggleFavorite = async (host: any) => {
    if (host.id === 'local' || host.connectionMode === 'agent') return
    try {
      await createHost.mutateAsync({
        id: host.id,
        address: host.address || host.id,
        user: host.user || host.id,
        port: host.port || 22,
        favorite: !host.favorite,
      })
    } catch (err: any) {
      pushToast({ type: 'error', message: err?.message || t('sshPanel.saveFailed') })
    }
  }
  const confirmDeleteHost = async () => {
    if (!pendingDeleteHostId) return
    const isAgent = !!(pendingDeleteHost?.agent || pendingDeleteHost?.connectionMode === 'agent')
    try {
      if (isAgent) await removeAgent.mutateAsync(pendingDeleteHostId)
      else await deleteHost.mutateAsync(pendingDeleteHostId)
      setHostActionMessage(t('sshPanel.removed'))
    } catch (err: any) {
      setHostActionMessage(err?.message || t('sshPanel.removeFailed'))
    }
    setPendingDeleteHostId(null)
  }
  const handleTest = async (host: any) => {
    setHostActionMessage('')
    try {
      const result = await testHost.mutateAsync(host.id)
      setHostActionMessage(t('sshPanel.testResult', { host: host.id, title: result.task.title }))
    } catch (err: any) {
      setHostActionMessage(err?.message || t('sshPanel.testFailed'))
    }
  }
  const handleResolve = async (host: any) => {
    try {
      const resolved = await resolveHost.mutateAsync(host.id)
      setResolvedDetails((prev) => ({ ...prev, [host.id]: resolved }))
    } catch {
      setResolvedDetails((prev) => ({ ...prev, [host.id]: 'error' }))
    }
  }
  const toggleAttach = (hostId: string) => {
    setSelectedHostId(hostId)
    setAttachHostId(attachHostId === hostId ? null : hostId)
  }
  const attachSession = (hostId: string, sessionId: string) => {
    setActiveHost(hostId)
    setActiveSession(sessionId)
    if (sshPanelOpen) toggleSshPanel()
  }
  const copyText = async (text: string) => {
    const ok = await copy(text)
    pushToast({ type: ok ? 'success' : 'error', message: ok ? t('sshPanel.copied') : t('clipboard.copyFailed') })
  }
  const renderGroup = (title: string, groupHosts: any[], subtitle?: string, groupKey?: string) => {
    if (!groupHosts.length) return null
    const collapsed = collapsedGroups[title] === true
    return (
      <div key={groupKey}>
        <button
          onClick={() => toggleGroup(title)}
          title={subtitle}
          className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-meta font-semibold text-text-3 hover:bg-bg-2"
        >
          <span className="text-caption">{collapsed ? '▶' : '▼'}</span>
          <span>{title}</span>
          <span className="ml-auto rounded-full bg-bg-2 px-1.5 py-0.5 text-caption">{groupHosts.length}</span>
        </button>
        {!collapsed && (
          <div>
            {groupHosts.map((host: any) => {
              const isSshConfig = host.source === 'sshconfig'
              const isAgent = !!(host.agent || host.connectionMode === 'agent')
              const resolved = resolvedDetails[host.id]
              return (
                <div key={host.id}>
                  <div className="group flex items-center gap-1 pr-2">
                    <button
                      onClick={() => setSelectedHostId(selectedHostId === host.id ? null : host.id)}
                      className={`min-w-0 flex-1 border-l-2 px-3 py-2 text-left ${selectedHostId === host.id ? 'border-accent' : 'border-transparent'}`}
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot host={host} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1 truncate text-sm text-text-1">
                            <span className="truncate">{host.name || host.id}</span>
                            {host.favorite === true && (
                              <FiStar
                                aria-hidden="true"
                                size={10}
                                className="shrink-0 text-yellow-400"
                                fill="currentColor"
                              />
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-text-3">
                            {isSshConfig
                              ? `${host.user ? `${host.user}@` : ''}${host.address || host.id}${host.port && host.port !== 22 ? `:${host.port}` : ''}`
                              : `${host.user ? `${host.user}@` : ''}${host.address || host.id}:${host.port || 22}`}
                          </div>
                        </div>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
                      {!isAgent && host.id !== 'local' && (
                        <Chip onClick={() => void toggleFavorite(host)}>{host.favorite ? '★' : '☆'}</Chip>
                      )}
                      <Chip onClick={() => openEditHostDialog(host)}>{t('sshPanel.edit')}</Chip>
                      <Chip
                        onClick={() => {
                          setSelectedHostId(host.id)
                          void handleTest(host)
                        }}
                      >
                        {t('sshPanel.test')}
                      </Chip>
                      <Chip onClick={() => toggleAttach(host.id)}>{t('sshPanel.attach')}</Chip>
                      {!isSshConfig && (
                        <Chip tone="danger" onClick={() => setPendingDeleteHostId(host.id)}>
                          {t('sshPanel.delete')}
                        </Chip>
                      )}
                    </div>
                  </div>
                  {selectedHostId === host.id && (
                    <div className="border-b border-[var(--line)] bg-bg-2 px-3 py-2">
                      <div className="mb-1 text-caption uppercase tracking-[0.18em] text-text-3">
                        {t('sshPanel.details')}
                      </div>
                      <div className="space-y-1">
                        <DetailRow label={t('sshPanel.detail.address')} value={host.address || host.id} />
                        <DetailRow label={t('sshPanel.detail.user')} value={host.user || '-'} />
                        <DetailRow label={t('sshPanel.detail.port')} value={String(host.port || 22)} />
                        <DetailRow
                          label={t('sshPanel.detail.connectionMode')}
                          value={
                            host.connectionMode === 'local'
                              ? t('sshPanel.mode.local')
                              : host.connectionMode === 'agent'
                                ? t('sshPanel.mode.agent')
                                : host.connectionMode === 'ssh'
                                  ? t('sshPanel.mode.ssh')
                                  : '-'
                          }
                        />
                        <DetailRow
                          label={t('sshPanel.detail.source')}
                          value={
                            isSshConfig
                              ? `ssh config (${baseName(host.configFile || '')})`
                              : host.connectionMode === 'agent'
                                ? 'agent'
                                : 'hosts.json'
                          }
                        />
                        {isSshConfig && !!host.identityFile && (
                          <DetailRow label={t('sshPanel.detail.identityFile')} value={host.identityFile} />
                        )}
                        <DetailRow
                          label={t('sshPanel.detail.favorite')}
                          value={host.favorite ? t('sshPanel.yes') : t('sshPanel.no')}
                        />
                        <DetailRow
                          label={t('sshPanel.detail.groups')}
                          value={Array.isArray(host.groups) && host.groups.length ? host.groups.join(', ') : '-'}
                        />
                        <DetailRow
                          label={t('sshPanel.detail.tags')}
                          value={((host.userTags || host.tags || []) as string[]).join(', ') || '-'}
                        />
                        {isSshConfig ? (
                          <DetailRow label={t('sshPanel.detail.forwardAgent')} value={host.forwardAgent || '-'} />
                        ) : (
                          <DetailRow
                            label={t('sshPanel.detail.useAgent')}
                            value={host.usesAgent ? t('sshPanel.yes') : t('sshPanel.no')}
                          />
                        )}
                        <DetailRow label={t('sshPanel.detail.jumpHost')} value={host.jumpHost || '-'} />
                        <DetailRow
                          label={t('sshPanel.detail.knownHostsPolicy')}
                          value={
                            host.knownHostsPolicy === 'strict'
                              ? t('sshPanel.policy.strict')
                              : host.knownHostsPolicy === 'off'
                                ? t('sshPanel.policy.off')
                                : host.knownHostsPolicy === 'accept-new'
                                  ? t('sshPanel.policy.acceptNew')
                                  : '-'
                          }
                        />
                        <DetailRow
                          label={t('sshPanel.detail.latency')}
                          value={typeof host.latencyMs === 'number' ? `${host.latencyMs} ms` : '-'}
                        />
                        {host.lastConnectionError && (
                          <DetailRow label={t('sshPanel.detail.lastError')} value={host.lastConnectionError} />
                        )}
                      </div>
                      {isSshConfig && (
                        <div className="mt-2">
                          <Chip onClick={() => void handleResolve(host)}>{t('sshPanel.resolve')}</Chip>
                          {resolved === 'error' && (
                            <div className="mt-1 text-xs text-danger">{t('sshPanel.resolveFailed')}</div>
                          )}
                          {resolved && resolved !== 'error' && (
                            <div className="mt-1 space-y-1">
                              <DetailRow label="hostname" value={resolved.hostname || '-'} />
                              <DetailRow label="user" value={resolved.user || '-'} />
                              <DetailRow label="port" value={String(resolved.port)} />
                              <DetailRow label="identityfile" value={resolved.identityFiles.join(', ') || '-'} />
                              <DetailRow label="proxyjump" value={resolved.proxyJump || '-'} />
                              <DetailRow label="forwardagent" value={resolved.forwardAgent || '-'} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1">
      <div className="border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-text-1">{t('sshPanel.title')}</div>
          <div className="flex items-center gap-1">
            <button
              aria-label={t('sshPanel.refresh')}
              title={t('sshPanel.refresh')}
              onClick={() => void refetchHosts()}
              className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-7 w-7 text-meta"
            >
              <FiRefreshCw aria-hidden="true" size={13} />
            </button>
            <button
              aria-label={t('sshPanel.openConfig')}
              title={t('sshPanel.openConfig')}
              onClick={openSshConfig}
              className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-7 w-7 text-meta"
            >
              <FiFileText aria-hidden="true" size={13} />
            </button>
            <button
              aria-label={t('sshPanel.jsonConfig')}
              title={t('sshPanel.jsonConfig')}
              onClick={openJsonConfig}
              className="tmuxgo-toolbar-icon tmuxgo-toolbar-icon--sm h-7 w-7 text-meta"
            >
              <FiCode aria-hidden="true" size={13} />
            </button>
            <Chip tone="accent" onClick={openCreateHostDialog}>
              {t('sshPanel.newHost')}
            </Chip>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1">
          <input
            value={quickAddDraft}
            onChange={(event) => setQuickAddDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void quickAddHost()
            }}
            placeholder={t('sshPanel.quickAddHint')}
            className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-2 py-1 font-mono text-xs"
          />
          <Chip onClick={() => void quickAddHost()}>{t('sshPanel.quickAdd')}</Chip>
        </div>
        {!!hostActionMessage && <div className="mt-1 break-words text-xs text-text-2">{hostActionMessage}</div>}
      </div>
      <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {!hosts.length && <div className="p-3 text-xs text-text-3">{t('sshPanel.empty')}</div>}
        {renderGroup(t('sshPanel.local'), localHosts)}
        {remoteGroups.map(([key, group]) =>
          renderGroup(group.title, group.hosts, key === 'hosts.json' ? undefined : key, key),
        )}
        {renderGroup(t('sshPanel.agents'), agentHosts)}
      </div>
      {selectedHost && (
        <div className="border-t border-[var(--line)] p-3">
          <div className="flex items-center gap-1">
            <Chip tone="accent" onClick={() => void handleTest(selectedHost)}>
              {t('sshPanel.test')}
            </Chip>
            <Chip tone="accent" onClick={() => toggleAttach(selectedHost.id)}>
              {t('sshPanel.attach')}
            </Chip>
          </div>
          {attachHostId === selectedHost.id && (
            <div className="mt-2">
              <div className="mb-1 text-xs text-text-3">{t('sshPanel.selectSession')}</div>
              {!sessions.length && <div className="text-xs text-text-3">{t('sshPanel.noSessions')}</div>}
              {sessions.map((session: any) => (
                <button
                  key={session.id}
                  onClick={() => attachSession(selectedHost.id, session.id)}
                  className="block w-full truncate rounded-apple px-2 py-1 text-left text-sm text-text-1 hover:bg-bg-2"
                >
                  {session.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="border-t border-[var(--line)] p-3">
        <div className="mb-1 text-caption uppercase tracking-[0.18em] text-text-3">{t('sshPanel.entryConfig')}</div>
        <div className="text-xs text-text-3">{t('sshPanel.userMap')}</div>
        <div className="mt-1 flex items-center gap-1">
          <input
            value={userMapDraft}
            onChange={(event) => setUserMapDraft(event.target.value)}
            placeholder={t('sshPanel.userMapHint')}
            className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-2 py-1 text-sm"
          />
          <Chip onClick={() => void copyText(`TMUXGO_SSH_USER_MAP="${userMapDraft.trim()}"`)}>
            {t('sshPanel.copy')}
          </Chip>
        </div>
        <div className="mt-2 text-xs text-text-3">{t('sshPanel.allowedHosts')}</div>
        <div className="mt-1 flex items-center gap-1">
          <input
            value={allowedHostsDraft}
            onChange={(event) => setAllowedHostsDraft(event.target.value)}
            placeholder={t('sshPanel.allowedHostsHint')}
            className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded-apple px-2 py-1 text-sm"
          />
          <Chip onClick={() => void copyText(`TMUXGO_SSH_ALLOWED_HOSTS="${allowedHostsDraft.trim()}"`)}>
            {t('sshPanel.copy')}
          </Chip>
        </div>
        <div className="mt-2 text-xs text-text-3">{t('sshPanel.envHint')}</div>
        <div className="mt-2 text-xs text-text-3">{t('sshPanel.usage')}</div>
        <div className="mt-1 rounded-apple bg-bg-2 px-2 py-1 font-mono text-xs text-text-2">
          {t('sshPanel.usageExample')}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-text-3">
            {t('sshPanel.docPath')}: {t('sshPanel.docPathValue')}
          </span>
          <Chip onClick={() => void copyText(t('sshPanel.usageExample'))}>{t('sshPanel.copy')}</Chip>
        </div>
      </div>
      {hostDialogOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center tmuxgo-scrim p-4"
          onClick={closeHostDialog}
        >
          <div
            className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-[420px] rounded-apple border p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-medium text-text-1">
                {hostDialogMode === 'create' ? t('sshPanel.createTitle') : t('sshPanel.editTitle')}
              </h3>
              <Button variant="ghost" size="sm" aria-label="close" onClick={closeHostDialog}>
                ✕
              </Button>
            </div>
            {hostDialogSshConfig && (
              <div className="mb-2 rounded-apple bg-bg-2 px-2 py-1.5 text-xs text-text-3">
                {t('sshPanel.configManaged')}
              </div>
            )}
            <div className="space-y-2">
              <input
                value={hostIdDraft}
                disabled={hostDialogMode === 'edit'}
                onChange={(event) => setHostIdDraft(event.target.value)}
                placeholder={t('sshPanel.hostId')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              />
              <input
                value={hostNameDraft}
                onChange={(event) => setHostNameDraft(event.target.value)}
                placeholder={t('sshPanel.hostName')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
              />
              <input
                value={hostAddressDraft}
                disabled={hostDialogSshConfig}
                onChange={(event) => setHostAddressDraft(event.target.value)}
                placeholder={t('sshPanel.hostAddress')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              />
              <input
                value={hostUserDraft}
                disabled={hostDialogSshConfig}
                onChange={(event) => setHostUserDraft(event.target.value)}
                placeholder={t('sshPanel.hostUser')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              />
              <input
                value={hostPortDraft}
                disabled={hostDialogSshConfig}
                onChange={(event) => setHostPortDraft(event.target.value)}
                placeholder={t('sshPanel.hostPort')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              />
              <input
                type="password"
                value={hostPasswordDraft}
                onChange={(event) => setHostPasswordDraft(event.target.value)}
                placeholder={t('sshPanel.hostPassword')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
              />
              {hostDialogMode === 'edit' && <div className="text-xs text-text-3">{t('sshPanel.hostPasswordKeep')}</div>}
              {!hostDialogSshConfig && (
                <>
                  <input
                    value={hostPrivateKeyPathDraft}
                    onChange={(event) => setHostPrivateKeyPathDraft(event.target.value)}
                    placeholder={t('sshPanel.hostPrivateKeyPath')}
                    className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
                  />
                  {hostDialogMode === 'edit' && (
                    <div className="text-xs text-text-3">{t('sshPanel.hostPrivateKeyKeep')}</div>
                  )}
                  <input
                    value={hostJumpHostDraft}
                    onChange={(event) => setHostJumpHostDraft(event.target.value)}
                    placeholder={t('sshPanel.hostJumpHost')}
                    className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
                  />
                </>
              )}
              <input
                value={hostGroupsDraft}
                onChange={(event) => setHostGroupsDraft(event.target.value)}
                placeholder={t('sshPanel.hostGroups')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
              />
              <input
                value={hostTagsDraft}
                onChange={(event) => setHostTagsDraft(event.target.value)}
                placeholder={t('sshPanel.hostTags')}
                className="tmuxgo-control tmuxgo-input w-full rounded-apple px-2 py-1.5 text-sm"
              />
              <label className="flex items-center gap-2 px-1 text-sm text-text-2">
                <input
                  type="checkbox"
                  checked={hostFavoriteDraft}
                  onChange={(event) => setHostFavoriteDraft(event.target.checked)}
                  className="accent-accent"
                />
                {t('sshPanel.hostFavorite')}
              </label>
              {!hostDialogSshConfig && (
                <label className="flex items-center gap-2 px-1 text-sm text-text-2">
                  <input
                    type="checkbox"
                    checked={hostUseAgentDraft}
                    onChange={(event) => setHostUseAgentDraft(event.target.checked)}
                    className="accent-accent"
                  />
                  {t('sshPanel.hostUseAgent')}
                </label>
              )}
              <label className="flex items-center justify-between gap-3 px-1 text-sm text-text-2">
                <span>{t('sshPanel.hostKnownHostsPolicy')}</span>
                <Select
                  value={hostKnownHostsPolicyDraft}
                  onChange={(v) => setHostKnownHostsPolicyDraft(v as 'strict' | 'accept-new' | 'off')}
                  options={[
                    { value: 'strict', label: t('sshPanel.hostKnownHostsStrict') },
                    { value: 'accept-new', label: t('sshPanel.hostKnownHostsAcceptNew') },
                    { value: 'off', label: t('sshPanel.hostKnownHostsOff') },
                  ]}
                  className="rounded-apple px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button size="sm" onClick={closeHostDialog}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void saveHost()}>
                {t('sshPanel.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {sshConfigOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center tmuxgo-scrim p-4"
          onClick={closeSshConfig}
        >
          <div
            className="tmuxgo-glass tmuxgo-glass-dialog flex h-full max-h-[80vh] w-full max-w-[640px] flex-col rounded-apple border p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-medium text-text-1">{t('sshPanel.sshConfigTitle')}</h3>
              <Button variant="ghost" size="sm" aria-label="close" onClick={closeSshConfig}>
                ✕
              </Button>
            </div>
            {!sshConfig.data && <div className="text-xs text-text-3">{t('sshPanel.jsonConfigLoading')}</div>}
            {sshConfig.data && (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="font-mono text-[10px] text-text-3">
                  {t('sshPanel.jsonConfigPath', { path: sshConfig.data.path })}
                </div>
                <textarea
                  value={sshConfigDraft}
                  onChange={(event) => setSshConfigDraft(event.target.value)}
                  aria-label={t('sshPanel.sshConfigTitle')}
                  spellCheck={false}
                  className="tmuxgo-scrollbar min-h-0 w-full flex-1 resize-none rounded-apple bg-bg-2 p-2 font-mono text-xs text-text-1"
                />
                {!!sshConfigError && <div className="break-words text-xs text-danger">{sshConfigError}</div>}
                <div className="mt-auto flex items-center justify-end gap-2">
                  <Button size="sm" onClick={closeSshConfig}>
                    {t('sshPanel.jsonConfigCancel')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void saveSshConfigText()}>
                    {t('sshPanel.jsonConfigSave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {jsonConfigOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center tmuxgo-scrim p-4"
          onClick={closeJsonConfig}
        >
          <div
            className="tmuxgo-glass tmuxgo-glass-dialog flex h-full max-h-[80vh] w-full max-w-[640px] flex-col rounded-apple border p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-medium text-text-1">{t('sshPanel.jsonConfigTitle')}</h3>
              <Button variant="ghost" size="sm" aria-label="close" onClick={closeJsonConfig}>
                ✕
              </Button>
            </div>
            {!hostsConfig.data && <div className="text-xs text-text-3">{t('sshPanel.jsonConfigLoading')}</div>}
            {hostsConfig.data && (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div>
                  <div className="mb-1 text-xs text-text-3">{t('sshPanel.jsonConfigHosts')}</div>
                  <div className="mb-1 font-mono text-[10px] text-text-3">
                    {t('sshPanel.jsonConfigPath', { path: hostsConfig.data.hostsPath })}
                  </div>
                  <textarea
                    value={hostsJsonDraft}
                    onChange={(event) => setHostsJsonDraft(event.target.value)}
                    aria-label={t('sshPanel.jsonConfigHosts')}
                    spellCheck={false}
                    className="tmuxgo-scrollbar h-40 w-full resize-none rounded-apple bg-bg-2 p-2 font-mono text-xs text-text-1"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-text-3">{t('sshPanel.jsonConfigCredentials')}</div>
                  <div className="mb-1 font-mono text-[10px] text-text-3">
                    {t('sshPanel.jsonConfigPath', { path: hostsConfig.data.credentialsPath })}
                  </div>
                  <textarea
                    value={credentialsJsonDraft}
                    onChange={(event) => setCredentialsJsonDraft(event.target.value)}
                    aria-label={t('sshPanel.jsonConfigCredentials')}
                    spellCheck={false}
                    className="tmuxgo-scrollbar h-40 w-full resize-none rounded-apple bg-bg-2 p-2 font-mono text-xs text-text-1"
                  />
                </div>
                {!!jsonConfigError && <div className="break-words text-xs text-danger">{jsonConfigError}</div>}
                <div className="mt-auto flex items-center justify-end gap-2">
                  <Button size="sm" onClick={closeJsonConfig}>
                    {t('sshPanel.jsonConfigCancel')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void saveJsonConfig()}>
                    {t('sshPanel.jsonConfigSave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDeleteHostId}
        title={t('sshPanel.removeTitle')}
        message={
          pendingDeleteHost?.agent || pendingDeleteHost?.connectionMode === 'agent'
            ? t('sshPanel.removeAgentConfirm', { name: pendingDeleteHost?.name || pendingDeleteHostId || '' })
            : t('sshPanel.removeMessage', { name: pendingDeleteHost?.name || pendingDeleteHostId || '' })
        }
        confirmLabel={t('sshPanel.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingDeleteHostId(null)}
        onConfirm={confirmDeleteHost}
      />
    </div>
  )
}
