import { test } from '@playwright/test'
import { ensureSession, openSession } from './session'

test('debug terminal gutter metrics', async ({ page, request }) => {
  const name = `tmuxgo_gutter_${Date.now()}`
  const session = await ensureSession(request, name)
  await openSession(page, session, { expectHeader: false })
  await page.waitForFunction(() => {
    const t = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    return !!t?.cols && !!t?.rows && document.querySelector('[data-terminal] canvas')
  }, undefined, { timeout: 15000 })
  await page.waitForTimeout(1200)
  const metrics = await page.evaluate(() => {
    const terminal = document.querySelector('[data-terminal]') as HTMLElement | null
    const xterm = terminal?.querySelector('.xterm') as HTMLElement | null
    const viewport = terminal?.querySelector('.xterm-viewport') as HTMLElement | null
    const screen = terminal?.querySelector('.xterm-screen') as HTMLElement | null
    const rows = terminal?.querySelector('.xterm-rows') as HTMLElement | null
    const canvas = screen?.querySelector('canvas') as HTMLCanvasElement | null
    const rect = (node: Element | null) => node ? (node as HTMLElement).getBoundingClientRect().toJSON() : null
    const style = (node: Element | null) => node ? getComputedStyle(node as Element) : null
    return {
      terminalRect: rect(terminal),
      xtermRect: rect(xterm),
      viewportRect: rect(viewport),
      screenRect: rect(screen),
      rowsRect: rect(rows),
      canvasRect: rect(canvas),
      terminalStyle: terminal ? {
        paddingTop: style(terminal)?.paddingTop,
        paddingRight: style(terminal)?.paddingRight,
        paddingBottom: style(terminal)?.paddingBottom,
        paddingLeft: style(terminal)?.paddingLeft,
        overflow: style(terminal)?.overflow,
      } : null,
      viewportStyle: viewport ? {
        overflow: style(viewport)?.overflow,
        background: style(viewport)?.backgroundColor,
      } : null,
      screenStyle: screen ? {
        position: style(screen)?.position,
        inset: `${style(screen)?.top}/${style(screen)?.right}/${style(screen)?.bottom}/${style(screen)?.left}`,
      } : null,
      rowsStyle: rows ? {
        width: style(rows)?.width,
        height: style(rows)?.height,
      } : null,
      canvasStyle: canvas ? {
        width: style(canvas)?.width,
        height: style(canvas)?.height,
      } : null,
      term: (() => {
        const t = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
        return {
          cols: t?.cols || 0,
          rows: t?.rows || 0,
          fontSize: t?.options?.fontSize || 0,
          lineHeight: t?.options?.lineHeight || 0,
          proposed: (() => {
            try {
              return t?._addonManager?._addons?.find((item: any) => item?.instance?.proposeDimensions)?.instance?.proposeDimensions?.() || null
            } catch {
              return null
            }
          })(),
          cell: {
            width: t?._core?._renderService?.dimensions?.css?.cell?.width || 0,
            height: t?._core?._renderService?.dimensions?.css?.cell?.height || 0,
          },
        }
      })(),
      state: (() => {
        const t = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
        return {
          hasSessionOverlay: !!document.querySelector('[data-terminal] + div'),
          title: document.title,
          activeSessionLabel: document.querySelector('button[class*="border-accent"] .truncate')?.textContent || '',
          rendererType: t?._core?._renderService ? 'canvas' : 'unknown',
        }
      })(),
    }
  })
  console.log(JSON.stringify(metrics, null, 2))
})
