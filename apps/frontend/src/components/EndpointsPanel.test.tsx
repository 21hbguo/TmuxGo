import { fireEvent, render } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { EndpointsPanel, endpointUrl, buildOwnersByPort, resolveChain, chainLabel } from './EndpointsPanel'

const useEndpointsMock = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useEndpoints: (...args: any[]) => useEndpointsMock(...args),
  useHosts: () => ({ data: [] }),
}))

const sampleData = {
  hostId: 'local',
  collectedAt: '2026-10-05T00:00:00.000Z',
  supported: true,
  sources: { nginx: 'ok', tailscale: 'ok', docker: 'ok', socket: 'ok' },
  endpoints: [
    {
      id: 'nginx-0',
      source: 'nginx',
      listen: '443 ssl',
      name: 'app.example.com',
      target: 'http://127.0.0.1:3001',
      detail: '/etc/nginx/sites-enabled/app',
      locations: [
        { path: '/', target: 'http://127.0.0.1:3001', kind: 'proxy' },
        { path: '/api/', target: 'http://127.0.0.1:8000', kind: 'proxy' },
      ],
    },
    { id: 'docker-0', source: 'docker', listen: '0.0.0.0:8082', name: 'searxng', target: ':8080/tcp', detail: 'img' },
    { id: 'socket-0', source: 'socket', listen: '*:22', name: 'sshd', target: '', detail: 'pid 1' },
    {
      id: 'ts-0',
      source: 'tailscale',
      listen: 'node.tailnet.ts.net:8445',
      name: 'tailscale serve',
      target: 'http://127.0.0.1:8082',
      detail: '',
    },
  ],
}

function renderPanel(mode: 'panel' | 'mobile' = 'panel') {
  return render(
    React.createElement(I18nProvider, null, React.createElement(EndpointsPanel, { mode, onClose: () => {} })),
  )
}

describe('EndpointsPanel', () => {
  beforeEach(() => {
    localStorage.setItem('tmuxgo-preferences', JSON.stringify({ language: 'en' }))
    useConsoleStore.setState({ activeHostId: 'local' } as any)
    useEndpointsMock.mockReturnValue({
      data: sampleData,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    })
  })
  it('groups endpoints by source and shows listen → target', () => {
    const { getByText, getAllByText } = renderPanel()
    expect(getByText('Nginx sites')).toBeTruthy()
    expect(getByText('Docker containers')).toBeTruthy()
    expect(getByText('Listeners')).toBeTruthy()
    expect(getByText('443 ssl')).toBeTruthy()
    expect(getAllByText(/127\.0\.0\.1:3001/).length).toBeGreaterThan(0)
    expect(getByText('*:22')).toBeTruthy()
  })
  it('expands nginx locations on click', () => {
    const { getByLabelText, getByText } = renderPanel()
    fireEvent.click(getByLabelText('2 paths'))
    expect(getByText('http://127.0.0.1:8000')).toBeTruthy()
  })
  it('filters rows by search query', () => {
    const { getByPlaceholderText, queryByText, getByText } = renderPanel()
    fireEvent.change(getByPlaceholderText('Search domains, ports or targets…'), { target: { value: 'searxng' } })
    expect(queryByText('443 ssl')).toBeNull()
    expect(getByText('0.0.0.0:8082')).toBeTruthy()
  })
  it('renders unsupported state when collection is unavailable', () => {
    useEndpointsMock.mockReturnValue({
      data: { ...sampleData, supported: false, endpoints: [] },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    })
    const { getByText } = renderPanel('mobile')
    expect(getByText(/unsupported/)).toBeTruthy()
  })
  it('renders copy/open affordances with derived URLs', () => {
    const { getAllByLabelText } = renderPanel()
    expect(getAllByLabelText('Copy URL').length).toBe(4)
    expect(getAllByLabelText('Open in new tab').length).toBe(4)
    expect(getAllByLabelText('Copy URL')[0].getAttribute('title')).toBe('https://app.example.com')
  })
  it('resolves relay targets down to the owning entity', () => {
    const { getByText } = renderPanel()
    expect(getByText(/⇒ searxng · img → :8080\/tcp/)).toBeTruthy()
  })
})

describe('endpoint chains', () => {
  const eps = [
    {
      id: 'ts',
      source: 'tailscale',
      listen: 'h.ts.net:8445',
      name: 'tailscale serve',
      target: 'http://127.0.0.1:26785',
    },
    { id: 'd', source: 'docker', listen: '0.0.0.0:26785', name: 'sub2api', target: ':26786', detail: '' },
    { id: 's', source: 'socket', listen: '*:26785', name: 'docker-proxy', target: '', detail: 'pid 9' },
  ] as any[]
  const owners = buildOwnersByPort(eps)
  it('resolves tailscale relay → docker container → internal port', () => {
    const chain = resolveChain(owners, new Set(['ts']), 'http://127.0.0.1:26785')
    expect(chain.map((o) => o.id)).toEqual(['d'])
    expect(chainLabel(chain)).toBe('sub2api → :26786')
  })
  it('prefers docker owner over raw socket and never revisits', () => {
    const chain = resolveChain(owners, new Set(['ts']), 'http://127.0.0.1:26785')
    expect(chain[0].source).toBe('docker')
  })
  it('does not resolve bare container-internal ports further', () => {
    const chain = resolveChain(owners, new Set(['d']), ':26786')
    expect(chain).toEqual([])
  })
  it('breaks on unresolvable or missing targets', () => {
    expect(resolveChain(owners, new Set(['s']), '')).toEqual([])
    expect(resolveChain(owners, new Set(['x']), '/var/www/html')).toEqual([])
  })
})

describe('endpointUrl', () => {
  const item = (source: string, listen: string, name = '') => ({ id: 'x', source, listen, name, target: '' }) as any
  it('derives https URL from nginx server_name + ssl listen', () => {
    expect(endpointUrl(item('nginx', '443 ssl', 'app.example.com'))).toBe('https://app.example.com')
    expect(endpointUrl(item('nginx', '443 ssl', 'app.example.com'))).toBe('https://app.example.com')
  })
  it('keeps non-default port on named nginx sites', () => {
    expect(endpointUrl(item('nginx', '8443 ssl', 'a.com'))).toBe('https://a.com:8443')
    expect(endpointUrl(item('nginx', '80', 'a.com'))).toBe('http://a.com')
  })
  it('falls back to loopback for unnamed/wildcard listeners', () => {
    expect(endpointUrl(item('nginx', '80', '_'), '127.0.0.1')).toBe('http://127.0.0.1:80')
    expect(endpointUrl(item('socket', '*:22'), '127.0.0.1')).toBe('http://127.0.0.1:22')
    expect(endpointUrl(item('docker', '0.0.0.0:8082, [::]:8082'), '127.0.0.1')).toBe('http://127.0.0.1:8082')
  })
  it('uses remote host address for wildcard binds', () => {
    expect(endpointUrl(item('socket', '*:7890'), '10.0.0.5')).toBe('http://10.0.0.5:7890')
    expect(endpointUrl(item('socket', '*:7890'))).toBeNull()
  })
  it('keeps real bound IPs and tailnet hosts verbatim', () => {
    expect(endpointUrl(item('tailscale', 'node.tailnet.ts.net:443'))).toBe('https://node.tailnet.ts.net')
    expect(endpointUrl(item('tailscale', 'node.tailnet.ts.net:8443'))).toBe(
      'https://node.tailnet.ts.net:8443',
    )
    expect(endpointUrl(item('socket', '192.168.1.5:8080'), '127.0.0.1')).toBe('http://192.168.1.5:8080')
  })
  it('rejects unusable listen values', () => {
    expect(endpointUrl(item('socket', 'unix:/run/x.sock'), '127.0.0.1')).toBeNull()
    expect(endpointUrl(item('nginx', 'unknown'), '127.0.0.1')).toBeNull()
  })
})
