import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

// ws 的 @types 在本仓 bundler 解析下偶发丢导出（namespace 化），走 createRequire 取类本体 + 本地接口描述用到的面
const WsImpl = createRequire(import.meta.url)('ws') as new (url: string, opts?: { maxPayload?: number }) => CdpSocket
interface CdpSocket {
  readyState: number
  send(data: string): void
  close(): void
  on(event: 'message', fn: (raw: Buffer) => void): void
  on(event: 'open' | 'close' | 'error', fn: (err?: unknown) => void): void
  once(event: 'open' | 'close' | 'error', fn: (err?: unknown) => void): void
  off(event: 'open' | 'close' | 'error', fn: (err?: unknown) => void): void
}
const WS_OPEN = 1

export interface BrowserPage {
  id: string
  url: string
  title: string
  type: string
}
export type BrowserState = 'idle' | 'launching' | 'ready' | 'error'
export interface BrowserStatus {
  state: BrowserState
  engine: string | null
  pid: number | null
  cdpPort: number | null
  pages: BrowserPage[]
  activeTargetId: string | null
  error?: string
}
interface PendingCmd {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}
interface ViewClient {
  sessionId: string | null
  targetId: string | null
  send: (msg: Record<string, unknown>) => void
}

const configDir = () => process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo')
const profileDir = () => path.join(configDir(), 'browser-profile')

// 浏览器二进制探测顺序：env 覆盖 > playwright 缓存（无头壳最省内存）> PATH 系统浏览器
export function resolveBrowserBinary(env = process.env): { bin: string; headlessShell: boolean } | null {
  if (env.TMUXGO_BROWSER_PATH && existsSync(env.TMUXGO_BROWSER_PATH))
    return { bin: env.TMUXGO_BROWSER_PATH, headlessShell: env.TMUXGO_BROWSER_PATH.includes('headless') }
  const cache = path.join(os.homedir(), '.cache/ms-playwright')
  try {
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
      .sort()
      .reverse()
    for (const d of dirs) {
      const bin = path.join(cache, d, 'chrome-headless-shell-linux64/chrome-headless-shell')
      if (existsSync(bin)) return { bin, headlessShell: true }
    }
  } catch {
    /* best-effort，失败静默 */
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    for (const dir of (env.PATH || '').split(path.delimiter)) {
      const bin = path.join(dir, name)
      if (dir && existsSync(bin)) return { bin, headlessShell: false }
    }
  }
  return null
}

// 元素快照序列化器：可见可交互元素打 data-tg-ref 编号（agent 按编号寻址，dsh-browser 同款思路）
const SNAPSHOT_JS = `(() => {
  const SEL = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[onclick],[tabindex]:not([tabindex="-1"]),summary,label,[contenteditable="true"]'
  let i = 0
  const elements = []
  for (const el of document.querySelectorAll(SEL)) {
    if (elements.length >= 300) break
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    const ref = 'e' + i++
    el.setAttribute('data-tg-ref', ref)
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || el.value || '').trim().slice(0, 80)
    elements.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || el.getAttribute('role') || '', name })
  }
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000), elements }
})()`

// ref → 视口坐标：scrollIntoView 后取中心点，配合 Input.dispatch* 走真实输入管线（兼容 React/Vue 事件）
const REF_RECT_JS = `(ref) => {
  const el = document.querySelector('[data-tg-ref="' + ref + '"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}`

const KEYMAP: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}

const CDP_CONNECT_TIMEOUT_MS = 10000
const SCREENCAST_QUALITY = 70

export class BrowserInstance extends EventEmitter {
  private proc: ChildProcess | null = null
  private ws: CdpSocket | null = null
  private nextId = 1
  private pending = new Map<number, PendingCmd>()
  private sessionEventHandlers = new Map<string, Map<string, Set<(params: unknown) => void>>>()
  private targets = new Map<string, BrowserPage>()
  private clients = new Set<ViewClient>()
  private clientSeq = 0
  private screencastSeq = new Map<string, number>()
  activeTargetId: string | null = null
  state: BrowserState = 'idle'
  engine: string | null = null
  cdpPort: number | null = null
  error: string | null = null

  status(): BrowserStatus {
    return {
      state: this.state,
      engine: this.engine,
      pid: this.proc?.pid ?? null,
      cdpPort: this.cdpPort,
      pages: [...this.targets.values()],
      activeTargetId: this.activeTargetId,
      error: this.error ?? undefined,
    }
  }

  private broadcast(msg: Record<string, unknown>) {
    for (const c of this.clients) c.send(msg)
  }

  private setState(state: BrowserState, error?: string) {
    this.state = state
    this.error = error ?? null
    this.broadcast({ type: 'status', state, error })
  }

  async launch(): Promise<void> {
    if (this.state === 'ready' || this.state === 'launching') return
    const resolved = resolveBrowserBinary()
    if (!resolved) throw new Error('NO_BROWSER_BINARY')
    this.engine = resolved.bin
    mkdirSync(profileDir(), { recursive: true })
    // 清掉上次运行残留的端口文件，防止 waitForPort 读到旧端口
    try {
      rmSync(path.join(profileDir(), 'DevToolsActivePort'))
    } catch {
      /* best-effort，失败静默 */
    }
    this.setState('launching')
    // Ubuntu 23.10+ 的 AppArmor 默认禁 userns sandbox：先正常启动，秒退则补 --no-sandbox 重试一次
    this.spawnBrowser(resolved, false)
    try {
      this.cdpPort = await this.waitForPort()
      const wsUrl = await this.fetchWsUrl()
      await this.connectSocket(wsUrl)
      await this.cmd('Target.setDiscoverTargets', { discover: true })
      this.setState('ready')
      const first = [...this.targets.values()][0]
      this.activeTargetId = first?.id ?? null
    } catch (err) {
      this.proc?.kill('SIGKILL')
      this.proc = null
      this.setState('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  private spawnBrowser(resolved: { bin: string; headlessShell: boolean }, noSandbox: boolean) {
    const args = [
      ...(resolved.headlessShell ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir()}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(noSandbox ? ['--no-sandbox'] : []),
      // --remote-debugging-port=0 时真实端口落在 user-data-dir/DevToolsActivePort 首行
      'about:blank',
    ]
    this.proc = spawn(resolved.bin, args, { stdio: 'ignore' })
    this.proc.on('exit', (code) => {
      this.proc = null
      if (this.state === 'launching' && !noSandbox) {
        // sandbox 起不来的典型现场（秒退 + 无 DevToolsActivePort）：降级重试
        this.spawnBrowser(resolved, true)
        return
      }
      this.teardownSocket()
      this.setState('error', `browser exited (code ${code})`)
    })
  }

  private waitForPort(): Promise<number> {
    const file = path.join(profileDir(), 'DevToolsActivePort')
    const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim())
          if (port > 0) return resolve(port)
        } catch {
          /* best-effort，失败静默 */
        }
        if (Date.now() > deadline) return reject(new Error('DevToolsActivePort timeout'))
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  private fetchWsUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${this.cdpPort}/json/version`, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(body).webSocketDebuggerUrl)
            } catch {
              reject(new Error('bad /json/version'))
            }
          })
        })
        .on('error', reject)
    })
  }

  private connectSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WsImpl(wsUrl, { maxPayload: 64 * 1024 * 1024 })
      const onOpen = () => {
        ws.off('error', onErr)
        resolve()
      }
      const onErr = (e: unknown) => reject(e instanceof Error ? e : new Error(String(e)))
      ws.once('open', onOpen)
      ws.once('error', onErr)
      ws.on('message', (raw) => this.onMessage(raw as Buffer))
      ws.on('close', () => {
        this.teardownSocket()
        if (this.state === 'ready') this.setState('error', 'CDP socket closed')
      })
      this.ws = ws
    })
  }

  private teardownSocket() {
    for (const p of this.pending.values()) p.reject(new Error('browser disconnected'))
    this.pending.clear()
    this.sessionEventHandlers.clear()
    this.targets.clear()
    this.activeTargetId = null
    this.ws = null
  }

  private onMessage(raw: Buffer) {
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
      result?: unknown
      error?: { message?: string }
    }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'))
      else p.resolve(msg.result)
      return
    }
    if (!msg.method) return
    // Target.* 是浏览器域事件（无 sessionId），维护 tab 清单并广播给前端
    if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
      const info = (msg.params as { targetInfo: { targetId: string; type: string; url: string; title: string } })
        .targetInfo
      if (info.type === 'page') {
        this.targets.set(info.targetId, { id: info.targetId, url: info.url, title: info.title, type: info.type })
        // setDiscoverTargets 的存量 target 是异步事件补进来的，首个 page 到位时补 activeTargetId
        if (!this.activeTargetId) this.activeTargetId = info.targetId
        this.emitTargets()
      }
      return
    }
    if (msg.method === 'Target.targetDestroyed') {
      const id = (msg.params as { targetId: string }).targetId
      this.targets.delete(id)
      if (this.activeTargetId === id) this.activeTargetId = [...this.targets.keys()][0] ?? null
      // 被关的页上有 view client 在看：解绑旧 session 并跟随到新活动页
      for (const client of this.clients) {
        if (client.targetId === id) {
          const oldSid = client.sessionId
          client.sessionId = null
          client.targetId = null
          if (oldSid) this.offSession(oldSid)
          if (this.activeTargetId) void this.bindClient(client, this.activeTargetId).catch(() => {})
        }
      }
      this.emitTargets()
      return
    }
    // session 域事件 → 按 sessionId 分发给订阅者（screencast 帧、页面事件）
    if (msg.sessionId) {
      const handlers = this.sessionEventHandlers.get(msg.sessionId)?.get(msg.method)
      if (handlers) for (const h of handlers) h(msg.params)
    }
  }

  private emitTargets() {
    this.broadcast({ type: 'targets', targets: [...this.targets.values()], activeTargetId: this.activeTargetId })
    // tab 集合变化时把还没绑页面的 view client 补绑到活动页（覆盖先连 WS 后 launch 的时序）
    if (this.state === 'ready' && this.activeTargetId) {
      for (const client of this.clients) {
        if (!client.sessionId) void this.bindClient(client, this.activeTargetId).catch(() => {})
      }
    }
  }

  cmd(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return Promise.reject(new Error('browser not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws!.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
  }

  onSessionEvent(sessionId: string, method: string, handler: (params: unknown) => void) {
    let byMethod = this.sessionEventHandlers.get(sessionId)
    if (!byMethod) {
      byMethod = new Map()
      this.sessionEventHandlers.set(sessionId, byMethod)
    }
    let set = byMethod.get(method)
    if (!set) {
      set = new Set()
      byMethod.set(method, set)
    }
    set.add(handler)
  }

  private offSession(sessionId: string) {
    this.sessionEventHandlers.delete(sessionId)
  }

  async attach(targetId: string): Promise<string> {
    const res = (await this.cmd('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    return res.sessionId
  }

  async detach(sessionId: string) {
    this.offSession(sessionId)
    await this.cmd('Target.detachFromTarget', { sessionId }).catch(() => {})
  }

  // ---- 前端 view client：一个 WS 客户端挂一条 page session，帧只发给它 ----

  async addClient(send: ViewClient['send']): Promise<ViewClient> {
    const client: ViewClient = { sessionId: null, targetId: null, send }
    this.clients.add(client)
    send({ type: 'status', state: this.state, error: this.error ?? undefined })
    send({ type: 'targets', targets: [...this.targets.values()], activeTargetId: this.activeTargetId })
    if (this.state === 'ready' && this.activeTargetId) await this.bindClient(client, this.activeTargetId)
    return client
  }

  async bindClient(client: ViewClient, targetId: string) {
    if (client.sessionId) await this.detach(client.sessionId)
    client.sessionId = await this.attach(targetId)
    client.targetId = targetId
    const sid = client.sessionId
    this.onSessionEvent(sid, 'Page.screencastFrame', (params) => {
      const p = params as {
        data: string
        sessionId: number
        metadata?: { deviceWidth?: number; deviceHeight?: number }
      }
      client.send({ type: 'frame', data: p.data, width: p.metadata?.deviceWidth, height: p.metadata?.deviceHeight })
      // screencast 每帧必须 ack，否则 Chrome 停止发帧
      void this.cmd('Page.screencastFrameAck', { sessionId: p.sessionId }, sid)
      if (!this.screencastSeq.has(sid)) this.screencastSeq.set(sid, 0)
    })
    this.onSessionEvent(sid, 'Page.frameNavigated', (params) => {
      const frame = (params as { frame?: { url?: string } }).frame
      if (frame?.url && !frame.url.startsWith('chrome-error://')) {
        const t = this.targets.get(targetId)
        if (t) t.url = frame.url
        client.send({ type: 'page', url: frame.url })
      }
    })
    await this.cmd('Page.enable', {}, sid)
    await this.startScreencast(client)
  }

  private async startScreencast(client: ViewClient, width = 1280, height = 800) {
    if (!client.sessionId) return
    await this.cmd(
      'Page.startScreencast',
      { format: 'jpeg', quality: SCREENCAST_QUALITY, maxWidth: width, maxHeight: height, everyNthFrame: 1 },
      client.sessionId,
    ).catch(() => {})
  }

  async clientInput(client: ViewClient, msg: Record<string, unknown>) {
    if (!client.sessionId) return
    const sid = client.sessionId
    const kind = msg.kind as string
    if (kind === 'mousemove' || kind === 'mousedown' || kind === 'mouseup') {
      const type = kind === 'mousemove' ? 'mouseMoved' : kind === 'mousedown' ? 'mousePressed' : 'mouseReleased'
      const button = (msg.button as string) || (kind === 'mousemove' ? 'none' : 'left')
      const params: Record<string, unknown> = { type, x: msg.x, y: msg.y, button }
      if (kind !== 'mousemove') params.clickCount = 1
      await this.cmd('Input.dispatchMouseEvent', params, sid).catch(() => {})
      return
    }
    if (kind === 'wheel') {
      await this.cmd(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 },
        sid,
      ).catch(() => {})
      return
    }
    if (kind === 'keydown' || kind === 'keyup') {
      const mapped = KEYMAP[msg.key as string]
      const params: Record<string, unknown> = {
        type: kind === 'keydown' ? 'rawKeyDown' : 'keyUp',
        key: mapped?.key ?? (msg.key as string),
        code: mapped?.code ?? (msg.code as string) ?? (msg.key as string),
      }
      if (mapped) {
        params.windowsVirtualKeyCode = mapped.vk
        params.nativeVirtualKeyCode = mapped.vk
        if (kind === 'keydown' && mapped.text) params.text = mapped.text
      }
      await this.cmd('Input.dispatchKeyEvent', params, sid).catch(() => {})
      return
    }
    // 文本输入走 insertText：IME 合成串一次性注入，避免逐键事件在输入框里丢字
    if (kind === 'char' && typeof msg.text === 'string') {
      await this.cmd('Input.insertText', { text: msg.text }, sid).catch(() => {})
    }
  }

  async clientResize(client: ViewClient, width: number, height: number) {
    if (!client.sessionId) return
    const w = Math.max(200, Math.min(3840, Math.floor(width)))
    const h = Math.max(200, Math.min(2160, Math.floor(height)))
    await this.cmd(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false },
      client.sessionId,
    ).catch(() => {})
    // 尺寸变化后重启 screencast，让 maxWidth/maxHeight 跟上新画布
    await this.cmd('Page.stopScreencast', {}, client.sessionId).catch(() => {})
    await this.startScreencast(client, w, h)
  }

  async clientTab(client: ViewClient, msg: { action: string; url?: string; targetId?: string }) {
    if (msg.action === 'open') {
      const t = await this.openPage(msg.url || 'about:blank')
      if (t) await this.bindClient(client, t.id)
      return
    }
    if (msg.action === 'close' && msg.targetId) {
      await this.closePage(msg.targetId)
      return
    }
    if (msg.action === 'activate' && msg.targetId) {
      this.activeTargetId = msg.targetId
      await this.cmd('Target.activateTarget', { targetId: msg.targetId }).catch(() => {})
      await this.bindClient(client, msg.targetId)
      this.emitTargets()
    }
  }

  async removeClient(client: ViewClient) {
    this.clients.delete(client)
    if (client.sessionId) await this.detach(client.sessionId)
  }

  // ---- agent 控制面方法 ----

  private async activeSession(): Promise<string> {
    if (!this.activeTargetId) throw new Error('NO_ACTIVE_PAGE')
    return this.attach(this.activeTargetId)
  }

  async openPage(url: string): Promise<BrowserPage | null> {
    const res = (await this.cmd('Target.createTarget', { url })) as { targetId: string }
    this.activeTargetId = res.targetId
    const t = this.targets.get(res.targetId)
    return t ?? { id: res.targetId, url, title: '', type: 'page' }
  }

  async closePage(targetId: string) {
    await this.cmd('Target.closeTarget', { targetId })
  }

  async navigate(url: string, targetId?: string) {
    // 无活动页时直接开新 tab，避免 attach('') 报错
    if (!targetId && !this.activeTargetId) {
      if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url
      await this.openPage(url)
      return { ok: true }
    }
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url
      return await this.cmd('Page.navigate', { url }, sid)
    } finally {
      await this.detach(sid)
    }
  }

  async history(action: 'back' | 'forward' | 'reload', targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      if (action === 'reload') return await this.cmd('Page.reload', {}, sid)
      const nav = (await this.cmd('Page.getNavigationHistory', {}, sid)) as {
        currentIndex: number
        entries: { id: number }[]
      }
      const idx = action === 'back' ? nav.currentIndex - 1 : nav.currentIndex + 1
      const entry = nav.entries[idx]
      if (entry) await this.cmd('Page.navigateToHistoryEntry', { entryId: entry.id }, sid)
      return { ok: !!entry }
    } finally {
      await this.detach(sid)
    }
  }

  async snapshot(targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      await this.cmd('Runtime.enable', {}, sid).catch(() => {})
      const res = (await this.cmd(
        'Runtime.evaluate',
        { expression: SNAPSHOT_JS, returnByValue: true, awaitPromise: true },
        sid,
      )) as { result?: { value?: unknown } }
      return res.result?.value
    } finally {
      await this.detach(sid)
    }
  }

  private async refPoint(ref: string, sid: string): Promise<{ x: number; y: number }> {
    const res = (await this.cmd(
      'Runtime.evaluate',
      { expression: `(${REF_RECT_JS})(${JSON.stringify(ref)})`, returnByValue: true },
      sid,
    )) as { result?: { value?: { x: number; y: number } | null } }
    const pt = res.result?.value
    if (!pt) throw new Error(`REF_NOT_FOUND:${ref}`)
    return pt
  }

  async click(ref: string, targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      const { x, y } = await this.refPoint(ref, sid)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sid)
      }
      return { ok: true, x, y }
    } finally {
      await this.detach(sid)
    }
  }

  async type(ref: string, text: string, targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      await this.refPoint(ref, sid)
      // focus 走 el.focus() 而非点击：避免点击触发 select/链接副作用
      await this.cmd(
        'Runtime.evaluate',
        {
          expression: `document.querySelector('[data-tg-ref="${ref}"]')?.focus()`,
          returnByValue: true,
        },
        sid,
      )
      await this.cmd('Input.insertText', { text }, sid)
      return { ok: true }
    } finally {
      await this.detach(sid)
    }
  }

  async press(key: string, targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      const mapped = KEYMAP[key] || { key, code: key, vk: 0 }
      const params: Record<string, unknown> = { key: mapped.key, code: mapped.code }
      if (mapped.vk) {
        params.windowsVirtualKeyCode = mapped.vk
        params.nativeVirtualKeyCode = mapped.vk
      }
      await this.cmd(
        'Input.dispatchKeyEvent',
        { ...params, type: 'rawKeyDown', ...(mapped.text ? { text: mapped.text } : {}) },
        sid,
      )
      await this.cmd('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, sid)
      return { ok: true }
    } finally {
      await this.detach(sid)
    }
  }

  async scroll(dx: number, dy: number, targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      await this.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: dx, deltaY: dy }, sid)
      return { ok: true }
    } finally {
      await this.detach(sid)
    }
  }

  async screenshot(targetId?: string): Promise<string> {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      await this.cmd('Page.enable', {}, sid).catch(() => {})
      const res = (await this.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, sid)) as { data: string }
      return res.data
    } finally {
      await this.detach(sid)
    }
  }

  async evalJs(expression: string, targetId?: string) {
    const sid = await this.attach(targetId || this.activeTargetId || '')
    try {
      const res = (await this.cmd(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sid,
      )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval failed')
      const json = JSON.stringify(res.result?.value)
      return json && json.length > 65536 ? json.slice(0, 65536) : json
    } finally {
      await this.detach(sid)
    }
  }

  async stop() {
    for (const client of [...this.clients]) await this.removeClient(client)
    if (this.proc) {
      const proc = this.proc
      this.proc = null
      proc.kill('SIGTERM')
      // 5s 内不退则 SIGKILL 兜底
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* best-effort，失败静默 */
        }
      }, 5000).unref()
    }
    this.teardownSocket()
    this.setState('idle')
  }
}

// 单实例管理（P0 仅 local host；远程经 agent relay 为 P1）
export const browserManager = {
  local: new BrowserInstance(),
  get(hostId: string): BrowserInstance | null {
    if (hostId === 'local') return this.local
    return null
  },
}
