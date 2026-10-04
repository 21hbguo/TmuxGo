import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { I18nProvider } from '@/i18n'
import type { Session } from '@/types'
import { SessionLayoutImportDialog } from './SessionLayoutImportDialog'

const applyLayoutMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  api: { sessions: { applyLayout: (...args: unknown[]) => applyLayoutMock(...args) } },
}))

const sessions: Session[] = [
  {
    id: 'local:dev',
    hostId: 'local',
    name: 'dev',
    createdAt: '',
    lastActiveAt: '',
    windowCount: 2,
  },
]
const layoutJson = JSON.stringify({
  kind: 'tmuxgo.session-layout',
  version: 1,
  name: 'imported-dev',
  sourceHostId: 'local',
  windows: [
    { name: 'editor', panes: [{ command: 'vim', env: { TOKEN: 'must-not-render' } }, {}] },
    { name: 'server', panes: [{}] },
  ],
})
function renderDialog(onApplied = vi.fn()) {
  return render(
    <I18nProvider>
      <SessionLayoutImportDialog
        open
        hostId="local"
        sessions={sessions}
        activeSessionId="local:dev"
        onApplied={onApplied}
        onClose={vi.fn()}
      />
    </I18nProvider>,
  )
}
async function chooseLayout(text = layoutJson) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([text], 'layout.json', { type: 'application/json' })] } })
  if (text === layoutJson) await screen.findByText('imported-dev')
}

beforeEach(() => applyLayoutMock.mockReset())
afterEach(cleanup)

describe('SessionLayoutImportDialog', () => {
  it('previews windows and panes without rendering sensitive layout fields', async () => {
    renderDialog()
    await chooseLayout()
    expect(screen.getByText('2 个窗口，3 个 pane')).toBeTruthy()
    expect(screen.getByText('editor')).toBeTruthy()
    expect(screen.getByText('server')).toBeTruthy()
    expect(screen.queryByText('must-not-render')).toBeNull()
  })

  it('applies append mode to the selected existing session', async () => {
    applyLayoutMock.mockResolvedValue({ session: sessions[0], mode: 'append' })
    const onApplied = vi.fn()
    renderDialog(onApplied)
    await chooseLayout()
    fireEvent.change(screen.getByRole('combobox', { name: '应用方式' }), { target: { value: 'append' } })
    fireEvent.click(screen.getByRole('button', { name: '应用布局' }))
    await waitFor(() => expect(applyLayoutMock).toHaveBeenCalledTimes(1))
    expect(applyLayoutMock).toHaveBeenCalledWith('local', {
      layout: expect.objectContaining({ name: 'imported-dev' }),
      mode: 'append',
      name: undefined,
      sessionId: 'local:dev',
      replace: false,
    })
    expect(onApplied).toHaveBeenCalledWith(sessions[0], 'append')
  })

  it('requires confirmation before replacing an existing session', async () => {
    applyLayoutMock.mockResolvedValue({ session: sessions[0], mode: 'create' })
    renderDialog()
    await chooseLayout()
    fireEvent.change(screen.getByRole('combobox', { name: '应用方式' }), { target: { value: 'replace' } })
    fireEvent.click(screen.getByRole('button', { name: '应用布局' }))
    expect(screen.getByRole('dialog', { name: '确认替换会话' })).toBeTruthy()
    expect(applyLayoutMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }))
    await waitFor(() => expect(applyLayoutMock).toHaveBeenCalledTimes(1))
    expect(applyLayoutMock).toHaveBeenCalledWith('local', expect.objectContaining({ mode: 'create', replace: true }))
  })

  it('sanitizes sensitive parse failures', async () => {
    renderDialog()
    await chooseLayout(JSON.stringify({ kind: 'token=secret' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('布局文件无效或格式不受支持')
    expect(screen.queryByText(/token=secret/)).toBeNull()
  })
})
