// 无头录屏：把 index.html 的 15s 动画录成 webm，并报告音频起播偏移
// 用法: NODE_PATH=<dsh>/node_modules node src/record.js
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const VOICE_SECONDS = 15.192 // 配音总时长（ffprobe 实测）
const W = 1920
const H = 1080
const TAIL = 1.1 // 音频结束后多录一点，便于 -shortest 收尾

;(async () => {
  fs.mkdirSync(path.join(ROOT, 'video'), { recursive: true })
  const browser = await chromium.launch({
    // headless 下允许无手势自动播放：否则 audio.play() 被拒，动画时钟不启动
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  })
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: path.join(ROOT, 'video'), size: { width: W, height: H } },
  })
  const page = await context.newPage()
  page.on('console', (m) => console.log('[page]', m.type(), m.text()))
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))

  await page.goto('file://' + path.join(ROOT, 'src', 'index.html'))
  const wall = Date.now()
  await page.waitForTimeout((VOICE_SECONDS + TAIL) * 1000)

  const info = await page.evaluate(() => ({
    offset: window.__audioStartOffset === undefined ? null : window.__audioStartOffset,
    fallback: !!window.__clockFallback,
  }))
  await page.screenshot({ path: path.join(ROOT, 'video', 'last-frame.png') })
  await context.close() // 必须先关 context，webm 才会落盘
  await browser.close()

  const recSeconds = (Date.now() - wall) / 1000
  fs.writeFileSync(
    path.join(ROOT, 'video', 'record-meta.json'),
    JSON.stringify({ offset: info.offset, fallback: info.fallback, recSeconds, voiceSeconds: VOICE_SECONDS }, null, 2),
  )
  console.log('recorded. audioStartOffset=', info.offset, 'fallback=', info.fallback, 'rec=', recSeconds.toFixed(2))
})().catch((e) => {
  console.error('FAIL:', (e && e.stack) || e)
  process.exit(1)
})
