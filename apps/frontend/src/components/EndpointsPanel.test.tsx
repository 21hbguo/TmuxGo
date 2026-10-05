import { fireEvent, render } from '@testing-library/react'
import React from 'react'
import { vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { EndpointsPanel } from './EndpointsPanel'

const useEndpointsMock = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useEndpoints: (...args: any[]) => useEndpointsMock(...args),
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
})
