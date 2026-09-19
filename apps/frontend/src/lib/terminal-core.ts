interface TerminalCoreOptions {
  container: HTMLElement
  preferences: { cursorBlink: boolean; fontSize: number; fontFamily: string }
  isMobile: boolean
  scrollback: number
  ensureAppFontLoaded: (fontFamily: string, fontSize: number) => Promise<unknown>
  isLinkOpenGesture: (event: MouseEvent) => boolean
  openUrl: (url: string) => void
  createFileLinks: (bufferLineNumber: number) => any[]
  scheduleRendererStyleCorrection: () => void
  clearRendererCache: () => void
  recordRenderer: (renderer: 'dom' | 'webgl') => void
}
export async function createTerminalCore(options: TerminalCoreOptions) {
  const fontReady = options.ensureAppFontLoaded(options.preferences.fontFamily, options.preferences.fontSize)
  const { Terminal } = await import('@xterm/xterm')
  const { WebLinksAddon } = await import('@xterm/addon-web-links')
  const { Unicode11Addon } = await import('@xterm/addon-unicode11')
  if (!options.container.isConnected) return null
  const style = getComputedStyle(document.documentElement)
  const getVar = (name: string) => style.getPropertyValue(name).trim()
  const terminal = new Terminal({
    theme: {
      background: `rgb(${getVar('--bg-1')})`,
      foreground: `rgb(${getVar('--text-1')})`,
      cursor: `rgb(${getVar('--accent')})`,
      selectionBackground: `rgb(${getVar('--accent')} / 0.2)`,
    },
    cursorBlink: options.preferences.cursorBlink,
    cursorStyle: 'bar',
    allowTransparency: false,
    fontSize: options.preferences.fontSize,
    fontFamily: options.preferences.fontFamily,
    fontWeight: '400',
    fontWeightBold: '700',
    letterSpacing: 0,
    lineHeight: 1,
    minimumContrastRatio: 4.5,
    customGlyphs: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    scrollback: options.scrollback,
  })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  terminal.loadAddon(
    new WebLinksAddon((event: MouseEvent, uri: string) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      if (!options.isLinkOpenGesture(event)) return
      options.openUrl(uri)
    }),
  )
  terminal.open(options.container)
  const linkProvider = terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber: number, callback: (links: any[] | undefined) => void) => {
      const links = options.createFileLinks(bufferLineNumber)
      callback(links.length ? links : undefined)
    },
  })
  let rendererType: 'dom' | 'webgl' = 'dom'
  if (!options.isMobile) {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      const webglAddon = new WebglAddon()
      // addon 内部等 webglcontextrestored 约 3s，仍未恢复才 fire onContextLoss；
      // 此时 dispose 回退 DOM renderer，避免 GL context 永久丢失后整屏空白
      webglAddon.onContextLoss(() => {
        options.recordRenderer('dom')
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
      rendererType = 'webgl'
    } catch {}
  }
  options.recordRenderer(rendererType)
  if (terminal.element instanceof HTMLElement) {
    terminal.element.style.width = '100%'
    terminal.element.style.height = '100%'
    terminal.element.style.display = 'block'
    const screen = terminal.element.querySelector('.xterm-screen') as HTMLElement | null
    const viewport = terminal.element.querySelector('.xterm-viewport') as HTMLElement | null
    if (screen) {
      screen.style.position = 'absolute'
      screen.style.inset = '0'
      screen.style.width = '100%'
      screen.style.height = '100%'
    }
    if (viewport) {
      viewport.style.width = '100%'
      viewport.style.height = '100%'
      viewport.style.overflow = 'hidden'
      viewport.style.background = 'transparent'
      viewport.style.scrollbarWidth = 'none'
      viewport.style.setProperty('-ms-overflow-style', 'none')
    }
    options.scheduleRendererStyleCorrection()
  }
  options.clearRendererCache()
  return { terminal, fontReady, disposables: [linkProvider] }
}
