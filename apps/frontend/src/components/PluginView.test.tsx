import { act, render, waitFor } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { PluginView } from './PluginView'

const invokePluginAction = vi.fn()
const storageSet = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  usePlugins: () => ({ data: { plugins: [{ pluginId: 'test.plugin', enabled: true, state: 'active', manifest: { schemaVersion: 1, id: 'test.plugin', name: 'Test Plugin', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: ['linux'], contributes: { actions: [{ id: 'run', title: 'Run', command: ['test'] }], views: [{ id: 'main', title: 'Plugin View', entry: 'ui/index.html', placement: 'activity' }] } } }] } }),
}))
vi.mock('@/lib/runtime-endpoints', () => ({ getApiBase: () => '' }))
vi.mock('@/lib/api', () => ({
  api: { plugins: { invoke: (...args: any[]) => invokePluginAction(...args), storage: { list: vi.fn(), get: vi.fn(), set: (...args: any[]) => storageSet(...args), remove: vi.fn() } } },
}))

function dispatchPluginMessage(source: MessageEventSource | null, data: Record<string, unknown>) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source })
  act(() => window.dispatchEvent(event))
}

describe('PluginView', () => {
  beforeEach(() => {
    localStorage.setItem('tmuxgo-preferences', JSON.stringify({ language: 'en' }))
    invokePluginAction.mockReset()
    storageSet.mockReset()
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-dev', activePaneId: 'local:%1', toasts: [] } as any)
  })
  it('uses a script-only sandbox and sends host context after the view is ready', async () => {
    const { container } = render(React.createElement(I18nProvider, null, React.createElement(PluginView, { pluginId: 'test.plugin', viewId: 'main', onClose: () => {} })))
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage')
    dispatchPluginMessage(iframe.contentWindow, { source: 'tmuxgo-plugin', type: 'ready', pluginId: 'test.plugin', viewId: 'main' })
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'tmuxgo-host', type: 'context', pluginId: 'test.plugin', viewId: 'main', context: { hostId: 'local', sessionId: 'session-dev', paneId: 'local:%1', source: 'plugin-view', pluginId: 'test.plugin', viewId: 'main' } }), '*'))
  })
  it('rejects messages from other windows and keeps host-owned action context', async () => {
    invokePluginAction.mockResolvedValue({ status: 'success', stdout: '', stderr: '' })
    const { container } = render(React.createElement(I18nProvider, null, React.createElement(PluginView, { pluginId: 'test.plugin', viewId: 'main', onClose: () => {} })))
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    dispatchPluginMessage(window, { source: 'tmuxgo-plugin', type: 'request', id: 'spoofed', pluginId: 'test.plugin', viewId: 'main', method: 'action.invoke', params: { actionId: 'run' } })
    expect(invokePluginAction).not.toHaveBeenCalled()
    dispatchPluginMessage(iframe.contentWindow, { source: 'tmuxgo-plugin', type: 'request', id: 'valid', pluginId: 'test.plugin', viewId: 'main', method: 'action.invoke', params: { actionId: 'run', context: { hostId: 'remote', sessionId: 'session-other', paneId: 'remote:%9', extra: 'value' } } })
    await waitFor(() => expect(invokePluginAction).toHaveBeenCalledWith('test.plugin', 'run', { hostId: 'local', sessionId: 'session-dev', paneId: 'local:%1', extra: 'value', source: 'plugin-view', pluginId: 'test.plugin', viewId: 'main' }))
  })
})
