import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshPanel } from './SshPanel'
import { useConsoleStore } from '@/stores/useConsoleStore'

const useHostsMock = vi.fn()
const mutateCreateHost = vi.fn()
const mutateDeleteHost = vi.fn()
const mutateTestHost = vi.fn()
const mutateRemoveAgent = vi.fn()
const mutateSaveHostsConfig = vi.fn()
const mutateSaveSshConfig = vi.fn()
const mutateAddSshConfigHost = vi.fn()
const mutateResolveHost = vi.fn()
const useSessionsMock = vi.fn()
const useSshConfigMock = vi.fn()
const refetchHostsMock = vi.fn()
const hostRows: any[] = [
  { id: 'local', name: 'Local Host', address: '127.0.0.1', user: 'root', port: 22, status: 'online', source: 'local' },
  {
    id: 'hlsj',
    name: 'hlsj',
    address: '100.73.105.110',
    user: 'hhl',
    port: 22,
    status: 'unknown',
    source: 'sshconfig',
    configFile: '/home/x/.ssh/config',
    identityFile: '~/.ssh/id_hlsj',
  },
  {
    id: 'web-prod',
    name: 'Web Prod',
    address: '1.2.3.4',
    user: 'ubuntu',
    port: 22,
    status: 'offline',
    groups: ['prod'],
    favorite: true,
    usesAgent: false,
    source: 'store',
  },
  {
    id: 'edge',
    name: 'Edge Agent',
    address: '10.0.0.5',
    user: 'admin',
    port: 2222,
    status: 'online',
    agent: { online: true, version: '1.2.3' },
    connectionMode: 'agent',
  },
]
const hostsConfigData = {
  hostsPath: '/data/hosts.json',
  credentialsPath: '/data/host-credentials.json',
  hosts: { version: 2, hosts: [{ id: 'web-prod', address: '1.2.3.4' }] },
  credentials: { version: 1, credentials: { 'web-prod': { user: 'ubuntu' } } },
}

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => useHostsMock(),
  useCreateHost: () => ({ mutateAsync: mutateCreateHost }),
  useDeleteHost: () => ({ mutateAsync: mutateDeleteHost }),
  useTestHost: () => ({ mutateAsync: mutateTestHost }),
  useRemoveAgent: () => ({ mutateAsync: mutateRemoveAgent }),
  useHostsConfig: () => ({ data: hostsConfigData }),
  useSaveHostsConfig: () => ({ mutateAsync: mutateSaveHostsConfig }),
  useSshConfig: (...args: any[]) => useSshConfigMock(...args),
  useSaveSshConfig: () => ({ mutateAsync: mutateSaveSshConfig }),
  useAddSshConfigHost: () => ({ mutateAsync: mutateAddSshConfigHost }),
  useResolveSshHost: () => ({ mutateAsync: mutateResolveHost }),
  useSessions: (...args: any[]) => useSessionsMock(...args),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const map: Record<string, string> = {
        'sshPanel.title': 'SSH',
        'sshPanel.newHost': 'New Host',
        'sshPanel.local': 'Local',
        'sshPanel.remote': 'Remote Hosts',
        'sshPanel.agents': 'Agents',
        'sshPanel.empty': 'No hosts',
        'sshPanel.edit': 'Edit',
        'sshPanel.test': 'Test',
        'sshPanel.attach': 'Attach',
        'sshPanel.delete': 'Delete',
        'sshPanel.details': 'Details',
        'sshPanel.selectSession': 'Select a session',
        'sshPanel.noSessions': 'No sessions',
        'sshPanel.testResult': '{host}: {title}',
        'sshPanel.testFailed': 'Test failed',
        'sshPanel.hostId': 'Host id',
        'sshPanel.hostName': 'Display name',
        'sshPanel.hostAddress': 'Address',
        'sshPanel.hostUser': 'User',
        'sshPanel.hostPort': 'Port',
        'sshPanel.hostPassword': 'Password',
        'sshPanel.hostPrivateKeyPath': 'Private key path',
        'sshPanel.hostJumpHost': 'Jump host',
        'sshPanel.hostGroups': 'Groups',
        'sshPanel.hostTags': 'Tags',
        'sshPanel.hostFavorite': 'Favorite host',
        'sshPanel.hostUseAgent': 'Use SSH Agent',
        'sshPanel.hostKnownHostsPolicy': 'Host key policy',
        'sshPanel.hostKnownHostsStrict': 'Strict',
        'sshPanel.hostKnownHostsAcceptNew': 'Accept new',
        'sshPanel.hostKnownHostsOff': 'Off',
        'sshPanel.createTitle': 'New Host',
        'sshPanel.editTitle': 'Edit Host',
        'sshPanel.save': 'Save Host',
        'sshPanel.hostPasswordKeep': 'keep-password',
        'sshPanel.hostPrivateKeyKeep': 'keep-key',
        'sshPanel.detail.address': 'Addr',
        'sshPanel.detail.user': 'User',
        'sshPanel.detail.port': 'Port',
        'sshPanel.detail.connectionMode': 'Mode',
        'sshPanel.detail.favorite': 'Fav',
        'sshPanel.detail.groups': 'Groups',
        'sshPanel.detail.tags': 'Tags',
        'sshPanel.detail.useAgent': 'Agent',
        'sshPanel.detail.jumpHost': 'Jump',
        'sshPanel.detail.knownHostsPolicy': 'Policy',
        'sshPanel.detail.latency': 'Latency',
        'sshPanel.detail.lastError': 'Last error',
        'sshPanel.mode.local': 'Local',
        'sshPanel.mode.ssh': 'SSH',
        'sshPanel.mode.agent': 'Agent',
        'sshPanel.policy.strict': 'Strict',
        'sshPanel.policy.acceptNew': 'Accept new',
        'sshPanel.policy.off': 'Off',
        'sshPanel.yes': 'Yes',
        'sshPanel.no': 'No',
        'sshPanel.entryConfig': 'SSH Entry Config',
        'sshPanel.userMap': 'User mapping (TMUXGO_SSH_USER_MAP)',
        'sshPanel.allowedHosts': 'Allowed hosts (TMUXGO_SSH_ALLOWED_HOSTS)',
        'sshPanel.usage': 'Usage',
        'sshPanel.usageExample': 'ssh tmuxgo@gateway attach --host <host> --session <name>',
        'sshPanel.docPath': 'Deploy docs',
        'sshPanel.docPathValue': 'apps/gateway/docs/ssh-gateway-deploy.md',
        'sshPanel.jsonConfig': 'JSON Config',
        'sshPanel.jsonConfigTitle': 'Edit JSON Config',
        'sshPanel.jsonConfigHosts': 'Hosts (hosts.json)',
        'sshPanel.jsonConfigCredentials': 'Credentials (host-credentials.json)',
        'sshPanel.jsonConfigSave': 'Save',
        'sshPanel.jsonConfigCancel': 'Cancel',
        'sshPanel.jsonConfigInvalid': 'Invalid JSON',
        'sshPanel.jsonConfigSaved': 'Config saved',
        'sshPanel.jsonConfigPath': 'Path: {path}',
        'sshPanel.jsonConfigLoading': 'Loading…',
        'sshPanel.removeAgentConfirm': 'Remove agent {name} history?',
        'sshPanel.openConfig': 'Open SSH Config',
        'sshPanel.sshConfigTitle': 'SSH Config',
        'sshPanel.sshConfigSaved': 'SSH config saved',
        'sshPanel.sshConfigSaveFailed': 'Save failed',
        'sshPanel.configManaged': 'Managed by ssh config',
        'sshPanel.detail.source': 'Source',
        'sshPanel.detail.identityFile': 'Identity file',
        'sshPanel.quickAdd': 'Add',
        'sshPanel.quickAddHint': 'user@host or host',
        'sshPanel.quickAddInvalid': 'Invalid input',
        'sshPanel.quickAddDone': 'Added {alias}',
        'sshPanel.quickAddFailed': 'Add failed',
        'sshPanel.resolve': 'Resolve',
        'sshPanel.resolveFailed': 'Resolve failed',
        'common.cancel': 'Cancel',
      }
      const value = map[key] ?? key
      if (params) {
        return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), value)
      }
      return value
    },
  }),
}))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null,
}))

describe('SshPanel', () => {
  beforeEach(() => {
    useHostsMock.mockReset()
    mutateCreateHost.mockReset()
    mutateDeleteHost.mockReset()
    mutateTestHost.mockReset()
    mutateRemoveAgent.mockReset()
    mutateSaveHostsConfig.mockReset()
    mutateSaveSshConfig.mockReset()
    mutateAddSshConfigHost.mockReset()
    mutateResolveHost.mockReset()
    useSshConfigMock.mockReset()
    useSessionsMock.mockReset()
    refetchHostsMock.mockReset()
    useHostsMock.mockReturnValue({ data: hostRows, refetch: refetchHostsMock })
    useSessionsMock.mockReturnValue({ data: [] })
    mutateCreateHost.mockResolvedValue({ id: 'created' })
    mutateDeleteHost.mockResolvedValue({ success: true })
    mutateTestHost.mockResolvedValue({ task: { title: 'ready' } })
    mutateRemoveAgent.mockResolvedValue({ success: true })
    mutateSaveHostsConfig.mockResolvedValue({ hosts: hostsConfigData.hosts, credentials: hostsConfigData.credentials })
    mutateSaveSshConfig.mockResolvedValue({ path: '/home/x/.ssh/config' })
    mutateAddSshConfigHost.mockResolvedValue({ path: '/home/x/.ssh/config', alias: 'new-host' })
    mutateResolveHost.mockResolvedValue({
      hostname: '100.73.105.110',
      user: 'hhl',
      port: 22,
      identityFiles: ['~/.ssh/id_hlsj'],
      proxyJump: '',
      forwardAgent: 'yes',
      strictHostKeyChecking: 'ask',
    })
    useSshConfigMock.mockReturnValue({
      data: { path: '/home/x/.ssh/config', content: 'Host hlsj\n  HostName 100.73.105.110\n', hosts: [] },
    })
    useConsoleStore.setState({
      sshPanelOpen: false,
      activeHostId: '',
      activeSessionId: '',
      toasts: [],
    } as any)
  })

  it('renders host tree grouped by section', () => {
    render(<SshPanel />)
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByText('hosts.json')).toBeInTheDocument()
    expect(screen.getByText('config')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Local Host')).toBeInTheDocument()
    expect(screen.getByText('Web Prod')).toBeInTheDocument()
    expect(screen.getByText('hlsj')).toBeInTheDocument()
    expect(screen.getByText('Edge Agent')).toBeInTheDocument()
    expect(screen.getByText('root@127.0.0.1:22')).toBeInTheDocument()
    expect(screen.getByText('ubuntu@1.2.3.4:22')).toBeInTheDocument()
    expect(screen.getByText('hhl@100.73.105.110')).toBeInTheDocument()
  })

  it('collapses and expands host groups', () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByText('hosts.json'))
    expect(screen.queryByText('Web Prod')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('hosts.json'))
    expect(screen.getByText('Web Prod')).toBeInTheDocument()
  })

  it('hides delete on sshconfig rows and shows config-managed details', () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByText('hlsj'))
    expect(screen.getByText('ssh config (config)')).toBeInTheDocument()
    expect(screen.getByText('~/.ssh/id_hlsj')).toBeInTheDocument()
    // hlsj 行无 Delete;Delete 只剩 local / web-prod / edge
    expect(screen.getAllByText('Delete')).toHaveLength(3)
  })

  it('quick-adds a host via ssh config append', async () => {
    render(<SshPanel />)
    fireEvent.change(screen.getByPlaceholderText('user@host or host'), { target: { value: 'alice@new-box' } })
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() =>
      expect(mutateAddSshConfigHost).toHaveBeenCalledWith({ alias: 'new-box', hostName: 'new-box', user: 'alice' }),
    )
    await waitFor(() => expect(screen.getByText('Added new-box')).toBeInTheDocument())
  })

  it('opens the ssh config editor and saves the file', async () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByLabelText('Open SSH Config'))
    expect(screen.getByLabelText('SSH Config')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('SSH Config'), { target: { value: 'Host x\n  HostName 1.1.1.1\n' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mutateSaveSshConfig).toHaveBeenCalledWith('Host x\n  HostName 1.1.1.1\n'))
  })

  it('disables connection fields when editing a config-managed host', () => {
    render(<SshPanel />)
    fireEvent.click(screen.getAllByText('Edit')[1])
    expect(screen.getByText('Managed by ssh config')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Host id')).toBeDisabled()
    expect(screen.getByPlaceholderText('Address')).toBeDisabled()
    expect(screen.getByPlaceholderText('User')).toBeDisabled()
    expect(screen.queryByPlaceholderText('Private key path')).not.toBeInTheDocument()
  })

  it('opens the create host dialog and saves a new host', async () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByText('New Host'))
    expect(screen.getByPlaceholderText('Host id')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Host id'), { target: { value: 'new-box' } })
    fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'New Box' } })
    fireEvent.change(screen.getByPlaceholderText('Address'), { target: { value: '9.9.9.9' } })
    fireEvent.change(screen.getByPlaceholderText('User'), { target: { value: 'deploy' } })
    fireEvent.click(screen.getByText('Save Host'))
    await waitFor(() =>
      expect(mutateCreateHost).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-box', name: 'New Box', address: '9.9.9.9', user: 'deploy', port: 22 }),
      ),
    )
  })

  it('backfills the edit host dialog and disables the id field', () => {
    render(<SshPanel />)
    fireEvent.click(screen.getAllByText('Edit')[0])
    expect(screen.getByPlaceholderText('Host id')).toBeDisabled()
    expect(screen.getByPlaceholderText('Host id')).toHaveValue('local')
    expect(screen.getByPlaceholderText('Address')).toHaveValue('127.0.0.1')
    expect(screen.getByPlaceholderText('User')).toHaveValue('root')
  })

  it('deletes a host after confirmation', async () => {
    render(<SshPanel />)
    fireEvent.click(screen.getAllByText('Delete')[0])
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateDeleteHost).toHaveBeenCalledWith('local'))
  })

  it('runs a connection test and shows the task title', async () => {
    mutateTestHost.mockResolvedValueOnce({ task: { title: 'ping ok' } })
    render(<SshPanel />)
    fireEvent.click(screen.getAllByText('Test')[0])
    await waitFor(() => expect(mutateTestHost).toHaveBeenCalledWith('local'))
    await waitFor(() => expect(screen.getByText('local: ping ok')).toBeInTheDocument())
  })

  it('attaches to a session and closes the ssh panel', async () => {
    useSessionsMock.mockReturnValue({
      data: [
        { id: 'sess-1', name: 'main' },
        { id: 'sess-2', name: 'logs' },
      ],
    })
    useConsoleStore.setState({ sshPanelOpen: true, activeHostId: '', activeSessionId: '' } as any)
    render(<SshPanel />)
    fireEvent.click(screen.getAllByText('Attach')[0])
    expect(screen.getByText('main')).toBeInTheDocument()
    fireEvent.click(screen.getByText('main'))
    await waitFor(() => expect(useConsoleStore.getState().activeHostId).toBe('local'))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('sess-1'))
    await waitFor(() => expect(useConsoleStore.getState().sshPanelOpen).toBe(false))
  })

  it('renders the ssh entry config section', () => {
    render(<SshPanel />)
    expect(screen.getByText('SSH Entry Config')).toBeInTheDocument()
    expect(screen.getByText('User mapping (TMUXGO_SSH_USER_MAP)')).toBeInTheDocument()
    expect(screen.getByText('Allowed hosts (TMUXGO_SSH_ALLOWED_HOSTS)')).toBeInTheDocument()
    expect(screen.getByText('ssh tmuxgo@gateway attach --host <host> --session <name>')).toBeInTheDocument()
    expect(screen.getByText('Deploy docs: apps/gateway/docs/ssh-gateway-deploy.md')).toBeInTheDocument()
  })

  it('deletes an agent row via removeAgent', async () => {
    render(<SshPanel />)
    fireEvent.click(screen.getAllByText('Delete')[2])
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateRemoveAgent).toHaveBeenCalledWith('edge'))
    expect(mutateDeleteHost).not.toHaveBeenCalled()
  })

  it('opens the json config editor with both textareas', () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByLabelText('JSON Config'))
    expect(screen.getByLabelText('Hosts (hosts.json)')).toBeInTheDocument()
    expect(screen.getByLabelText('Credentials (host-credentials.json)')).toBeInTheDocument()
    expect(screen.getByLabelText('Hosts (hosts.json)')).toHaveValue(JSON.stringify(hostsConfigData.hosts, null, 2))
  })

  it('saves json config via saveHostsConfig', async () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByLabelText('JSON Config'))
    const nextHosts = { version: 2, hosts: [{ id: 'web-prod', address: '5.6.7.8' }] }
    fireEvent.change(screen.getByLabelText('Hosts (hosts.json)'), { target: { value: JSON.stringify(nextHosts) } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(mutateSaveHostsConfig).toHaveBeenCalledWith({
        hosts: nextHosts,
        credentials: hostsConfigData.credentials,
      }),
    )
    await waitFor(() => expect(screen.queryByLabelText('Hosts (hosts.json)')).not.toBeInTheDocument())
  })

  it('shows an error for invalid json and does not save', async () => {
    render(<SshPanel />)
    fireEvent.click(screen.getByLabelText('JSON Config'))
    fireEvent.change(screen.getByLabelText('Hosts (hosts.json)'), { target: { value: '{bad json' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('Invalid JSON')).toBeInTheDocument())
    expect(mutateSaveHostsConfig).not.toHaveBeenCalled()
  })
})
