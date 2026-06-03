import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
let userAgent=''
vi.mock('next/headers', () => ({
  headers: () => ({ get: (name: string) => name==='user-agent' ? userAgent : null }),
}))
vi.mock('@/components/ConsoleLayout', () => ({
  ConsoleLayout: ({ initialIsMobile }: { initialIsMobile: boolean }) => React.createElement('div', { 'data-testid': 'console-layout', 'data-mobile': String(initialIsMobile) }),
}))
describe('app/page', () => {
  it('marks mobile user agents as mobile', async () => {
    userAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    const { default: Home } = await import('./page')
    render(React.createElement(Home))
    expect(screen.getByTestId('console-layout')).toHaveAttribute('data-mobile', 'true')
  })
  it('marks desktop user agents as non-mobile', async () => {
    userAgent='Mozilla/5.0 (X11; Linux x86_64)'
    const { default: Home } = await import('./page')
    render(React.createElement(Home))
    expect(screen.getByTestId('console-layout')).toHaveAttribute('data-mobile', 'false')
  })
})
