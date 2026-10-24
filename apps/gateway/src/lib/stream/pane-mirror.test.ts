import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { PaneMirror } from './pane-mirror.js'
import { RESYNC_RESET_SEQ } from './stream-config.js'

const ESC = String.fromCharCode(27)
const strip = (text: string) =>
  text.split(ESC).reduce((acc, part, i) => (i === 0 ? part : acc + part.replace(/^\[[0-9;?]*[a-zA-Z]/, '')), '')

test('serializes the mirrored screen for attach', async (t) => {
  const mirror = new PaneMirror('local', 'dev', 20, 4)
  t.after(() => mirror.dispose())
  mirror.feed('hello\r\nworld')
  mirror.feed('\r\n\u001b[32mok\u001b[0m')
  const snapshot = await mirror.snapshot()
  // 前置复位序列：客户端按原子替换处理，与 output_resync 边界同语义
  assert.ok(snapshot.startsWith(RESYNC_RESET_SEQ))
  const screen = strip(snapshot.slice(RESYNC_RESET_SEQ.length))
  assert.match(screen, /hello/)
  assert.match(screen, /world/)
  assert.match(screen, /ok/)
  // 颜色属性不能丢：镜像存在的意义就是把画面喂回真终端
  assert.ok(snapshot.includes(`${ESC}[32m`), '颜色属性要保留')
})

test('replays only the bytes after the reported sequence', async (t) => {
  const mirror = new PaneMirror('local', 'dev', 20, 4)
  t.after(() => mirror.dispose())
  mirror.feed('one')
  mirror.feed('two')
  mirror.feed('three')
  assert.equal(mirror.seq, 3)
  assert.equal(mirror.since(1), 'twothree')
  // 已是最新：空增量，不重发整屏
  assert.equal(mirror.since(3), '')
  // 环里没有这段（序号越界/被挤出）→ null，调用方回退整快照
  assert.equal(mirror.since(-1), null)
})

test('drops the oldest bytes when the ring overflows and reports a miss', async (t) => {
  const mirror = new PaneMirror('local', 'dev', 20, 4, 8)
  t.after(() => mirror.dispose())
  mirror.feed('aaaa')
  mirror.feed('bbbb')
  mirror.feed('cccc')
  // 环上限 8 字节：最老的一段被挤出。客户端要 seq 1 之后的（2、3）仍在环里，
  // 要 0 之后的就缺了 seq 1 —— 只能整快照
  assert.equal(mirror.since(0), null)
  assert.equal(mirror.since(1), 'bbbbcccc')
  assert.equal(mirror.since(2), 'cccc')
})

test('keeps alt-screen content for attach', async (t) => {
  const mirror = new PaneMirror('local', 'dev', 20, 4)
  t.after(() => mirror.dispose())
  // 模拟 vim 类全屏程序：进 alt buffer 后写内容
  mirror.feed('\u001b[?1049h\u001b[H\u001b[2JALT-UI')
  const screen = strip((await mirror.snapshot()).slice(RESYNC_RESET_SEQ.length))
  assert.match(screen, /ALT-UI/)
})

test('baseline seeding keeps the ring and seq untouched', async (t) => {
  const mirror = new PaneMirror('local', 'dev', 20, 4)
  t.after(() => mirror.dispose())
  mirror.seedBaseline('BASELINE-LINE')
  assert.equal(mirror.seq, 0)
  assert.equal(mirror.warm, true)
  // 只有基线没有 live 输出：没有可补的增量，必须整快照
  assert.equal(mirror.since(0), null)
  assert.match(strip(await mirror.snapshot()), /BASELINE-LINE/)
})

test('reports size mismatches so attach can fall back to redraw', (t) => {
  const mirror = new PaneMirror('local', 'dev', 80, 24)
  t.after(() => mirror.dispose())
  assert.equal(mirror.matches(80, 24), true)
  assert.equal(mirror.matches(100, 30), false)
  mirror.resize(100, 30)
  assert.equal(mirror.matches(100, 30), true)
})
