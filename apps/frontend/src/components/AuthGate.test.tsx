import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from './AuthGate'

const { getAuthStatus, login, t }=vi.hoisted(() => ({ getAuthStatus:vi.fn(), login:vi.fn(), t:(key:string) => key }))

vi.mock('@/lib/auth', () => ({
  changePassword:vi.fn(),
  getAuthStatus,
  login,
  onAuthChange:() => () => {},
  refreshAuth:vi.fn(),
}))
vi.mock('@/i18n', () => ({ useTranslation:() => ({ t }) }))

describe('AuthGate', () => {
  beforeEach(() => {
    getAuthStatus.mockResolvedValue({ enabled:true, authenticated:false })
    login.mockReset()
  })
  it('keeps a default-password login on the password change screen', async () => {
    const user=userEvent.setup()
    login.mockResolvedValue({ passwordChangeRequired:true })
    render(React.createElement(AuthGate, null, React.createElement('div', null, 'console')))
    await screen.findByRole('button', { name:'auth.submit' })
    await user.type(screen.getByRole('textbox'), 'admin')
    await user.type(screen.getByLabelText('auth.password'), 'admin123')
    await user.click(screen.getByRole('button', { name:'auth.submit' }))
    await waitFor(() => expect(screen.getByText('auth.passwordChangeTitle')).toBeInTheDocument())
    expect(screen.queryByText('console')).not.toBeInTheDocument()
  })
})
