import { execTmux } from './tmux-executor.js'
import { stripTerminalControlSequences } from './terminal-output.js'

// 跨 pane 搜索的内容通道：网关不留 scrollback（stream-cell 的 TerminalGrid 只有视口），
// 前端 xterm buffer 只覆盖已挂载终端，所以历史只能经 tmux capture-pane 现取。
// 实测成本（80 列 pane）：1000 行 ≈ 21KB / 3-4ms，8 pane 并发 ≈ 10-40ms，可按需抓。
export const PANE_SEARCH_DEFAULT_LINES = 1000
export const PANE_SEARCH_MAX_LINES = 5000
// history_size 只在「行被挤出视口顶部」时增长，同一屏被重写（进度条、TUI 重绘）不会变，
// 所以缓存不能只认令牌，还要一个短 TTL 兜底；TTL 内命中直接复用上次抓到的文本行。
const CAPTURE_TTL_MS = 4000
const CAPTURE_CACHE_MAX = 48
// 单次响应的命中上限：搜 "a" 这类宽泛关键词时 1000 行 × 8 pane 能出几千条，
// 前端列表也吃不下，超出按顺序截断并置 truncated
export const PANE_SEARCH_MAX_HITS = 200
const PREVIEW_MAX_CHARS = 240

export interface PaneSearchHit {
  paneId: string
  windowIndex: number
  paneIndex: number
  paneTitle: string
  windowName: string
  // line 为「抓取缓冲区」内的 1 起行号（含末尾空行，与 capture-pane 输出行序一致），
  // 前端按 lineFromEnd 更稳地换算到 xterm buffer 行（见 PaneSearchPanel）
  line: number
  lineFromEnd: number
  preview: string
  historySize: number
}

export interface PaneSearchPaneResult {
  paneId: string
  windowIndex: number
  paneIndex: number
  paneTitle: string
  windowName: string
  historySize: number
  capturedLines: number
  hits: number
  cached: boolean
}

export interface PaneSearchResult {
  ok: true
  query: string
  mode: 'literal' | 'regex'
  maxLines: number
  hits: PaneSearchHit[]
  panes: PaneSearchPaneResult[]
  truncated: boolean
  elapsedMs: number
}

interface CaptureEntry {
  lines: string[]
  historySize: number
  capturedAt: number
}
const captureCache = new Map<string, CaptureEntry>()
// 同请求 in-flight 复用：前端输入框每敲一个字符可能打一发，重复的（同 session/query/深度）
// 请求共享同一个 Promise，避免同一秒内多份 capture 把 tmux server 打满
const inflight = new Map<string, Promise<PaneSearchResult>>()

interface PaneMeta {
  paneId: string
  windowIndex: number
  paneIndex: number
  paneTitle: string
  windowName: string
  historySize: number
  paneHeight: number
}

function cacheKey(hostId: string, paneId: string, historySize: number) {
  return `${hostId}\0${paneId}\0${historySize}`
}

function readCache(key: string): CaptureEntry | null {
  const entry = captureCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.capturedAt > CAPTURE_TTL_MS) {
    captureCache.delete(key)
    return null
  }
  // LRU 触碰：Map 保插入序，删后重插即移到队尾
  captureCache.delete(key)
  captureCache.set(key, entry)
  return entry
}

function writeCache(key: string, entry: CaptureEntry) {
  captureCache.set(key, entry)
  while (captureCache.size > CAPTURE_CACHE_MAX) {
    const oldest = captureCache.keys().next().value
    if (oldest === undefined) break
    captureCache.delete(oldest)
  }
}

// 测试/诊断缝：清空抓取缓存（不影响 in-flight）
export function clearPaneSearchCache() {
  captureCache.clear()
}
export function paneSearchCacheSize() {
  return captureCache.size
}

// list-panes 一次拿全 pane + history_size：history_size 是廉价变更令牌，
// 令牌未变且 TTL 内就直接用缓存文本，避免每次搜索都重抓全部 pane
async function listPaneMeta(hostId: string, sessionName: string): Promise<PaneMeta[]> {
  const { stdout } = await execTmux(hostId, [
    'list-panes',
    '-s',
    '-t',
    sessionName,
    '-F',
    [
      '#{pane_id}',
      '#{window_index}',
      '#{pane_index}',
      '#{pane_title}',
      '#{window_name}',
      '#{history_size}',
      '#{pane_height}',
    ].join('\t'),
  ])
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [paneId, windowIndex, paneIndex, paneTitle, windowName, historySize, paneHeight] = line.split('\t')
      return {
        paneId,
        windowIndex: Number(windowIndex) || 0,
        paneIndex: Number(paneIndex) || 0,
        paneTitle: paneTitle || 'shell',
        windowName: windowName || '',
        historySize: Number(historySize) || 0,
        paneHeight: Number(paneHeight) || 0,
      }
    })
    .filter((pane) => /^%\d+$/.test(pane.paneId))
}

async function capturePaneLines(
  hostId: string,
  paneId: string,
  maxLines: number,
  paneHeight: number,
): Promise<string[]> {
  // capture-pane 的 -S -N 是「从视口顶部再往上 N 行」，不是「最后 N 行」：输出的行数
  // 恒为 N + 视口高度。所以深度参数要减去视口高度，语义才是「目标深度 N 行」；
  // 视口本身必须整块参与匹配（否则命中行在屏上时用户跳不过去），因此 N < rows 时按 rows 抓。
  const depth = Math.max(0, maxLines - paneHeight)
  // 不加 -e：颜色序列让体积膨胀 2.2×，匹配前反正要 strip，纯文本更省带宽（预览不留色）
  const args =
    depth > 0 ? ['capture-pane', '-p', '-S', `-${depth}`, '-t', paneId] : ['capture-pane', '-p', '-t', paneId]
  const { stdout } = await execTmux(hostId, args, { timeoutMs: 8000 })
  return stdout.split('\n')
}

function buildMatcher(query: string, mode: 'literal' | 'regex'): (line: string) => number {
  if (mode === 'regex') {
    let re: RegExp
    try {
      re = new RegExp(query, 'i')
    } catch {
      // 非法正则按字面量处理：搜索框不该因用户敲了半个 `[` 就报错
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    return (line) => re.exec(line)?.index ?? -1
  }
  const needle = query.toLowerCase()
  return (line) => line.toLowerCase().indexOf(needle)
}

function buildPreview(line: string, index: number) {
  const trimmedEnd = line.replace(/\s+$/, '')
  if (trimmedEnd.length <= PREVIEW_MAX_CHARS) return trimmedEnd.trimStart()
  // 命中位置靠后时把窗口往前挪，保证关键词在预览里可见
  const start = Math.max(0, Math.min(index - Math.floor(PREVIEW_MAX_CHARS / 3), trimmedEnd.length - PREVIEW_MAX_CHARS))
  const slice = trimmedEnd.slice(start, start + PREVIEW_MAX_CHARS)
  return `${start > 0 ? '…' : ''}${slice.trimEnd()}${start + PREVIEW_MAX_CHARS < trimmedEnd.length ? '…' : ''}`
}

export interface PaneSearchOptions {
  hostId: string
  sessionName: string
  query: string
  mode?: 'literal' | 'regex'
  lines?: number
  maxHits?: number
}

async function runSearch(options: PaneSearchOptions): Promise<PaneSearchResult> {
  const started = Date.now()
  const mode = options.mode === 'regex' ? 'regex' : 'literal'
  const maxLines = Math.min(Math.max(1, Math.floor(options.lines ?? PANE_SEARCH_DEFAULT_LINES)), PANE_SEARCH_MAX_LINES)
  const maxHits = Math.min(options.maxHits ?? PANE_SEARCH_MAX_HITS, PANE_SEARCH_MAX_HITS)
  const query = options.query
  const match = buildMatcher(query, mode)
  const panes = await listPaneMeta(options.hostId, options.sessionName)
  // 逐 pane 抓取：并发上限 4，够吃掉 8 pane 的两轮且不会把远端通道打满
  const concurrency = 4
  const captures: { meta: PaneMeta; lines: string[]; cached: boolean }[] = new Array(panes.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= panes.length) return
      const meta = panes[index]
      const key = cacheKey(options.hostId, meta.paneId, meta.historySize)
      const cached = readCache(key)
      if (cached) {
        captures[index] = { meta, lines: cached.lines, cached: true }
        continue
      }
      const lines = await capturePaneLines(options.hostId, meta.paneId, maxLines, meta.paneHeight)
      writeCache(key, { lines, historySize: meta.historySize, capturedAt: Date.now() })
      captures[index] = { meta, lines, cached: false }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, panes.length) }, worker))

  const hits: PaneSearchHit[] = []
  const paneResults: PaneSearchPaneResult[] = []
  let truncated = false
  for (const capture of captures) {
    if (!capture) continue
    const { meta, lines } = capture
    let hitCount = 0
    for (let i = 0; i < lines.length; i += 1) {
      const plain = stripTerminalControlSequences(lines[i]).replace(/\r/g, '')
      if (!plain.trim()) continue
      const index = match(plain)
      if (index < 0) continue
      hitCount += 1
      if (hits.length < maxHits) {
        hits.push({
          paneId: `${options.hostId}:${meta.paneId}`,
          windowIndex: meta.windowIndex,
          paneIndex: meta.paneIndex,
          paneTitle: meta.paneTitle,
          windowName: meta.windowName,
          line: i + 1,
          lineFromEnd: lines.length - i,
          preview: buildPreview(plain, index),
          historySize: meta.historySize,
        })
      } else {
        truncated = true
      }
    }
    paneResults.push({
      paneId: `${options.hostId}:${meta.paneId}`,
      windowIndex: meta.windowIndex,
      paneIndex: meta.paneIndex,
      paneTitle: meta.paneTitle,
      windowName: meta.windowName,
      historySize: meta.historySize,
      capturedLines: lines.length,
      hits: hitCount,
      cached: capture.cached,
    })
  }
  return {
    ok: true,
    query,
    mode,
    maxLines,
    hits,
    panes: paneResults,
    truncated,
    elapsedMs: Date.now() - started,
  }
}

export async function searchSessionPanes(options: PaneSearchOptions): Promise<PaneSearchResult> {
  const key = [
    options.hostId,
    options.sessionName,
    options.mode || 'literal',
    options.lines ?? PANE_SEARCH_DEFAULT_LINES,
    options.maxHits ?? PANE_SEARCH_MAX_HITS,
    options.query,
  ].join('\0')
  const running = inflight.get(key)
  if (running) return running
  const task = runSearch(options).finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}
// 测试缝：in-flight 表面（并发去重断言用）
export function paneSearchInflightSize() {
  return inflight.size
}
