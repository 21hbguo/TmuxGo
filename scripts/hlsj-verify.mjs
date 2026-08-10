import fs from 'node:fs'
import os from 'node:os'

const ACCESS = fs.readFileSync('/tmp/tg-token', 'utf8').trim()
const r = await fetch('http://127.0.0.1:3001/api/auth/ws-ticket', { method: 'POST', headers: { authorization: 'Bearer ' + ACCESS } })
if (!r.ok) { console.log('ticket fail', r.status); process.exit(1) }
const { ticket } = await r.json()

const ws = new WebSocket('ws://127.0.0.1:3001/api/stream?ticket=' + ticket)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const listeners = []
let buf = ''
ws.onmessage = (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
  buf += text
  for (const fn of listeners) fn(text)
}
const send = (o) => ws.send(JSON.stringify(o))
const nowMs = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

send({ type: 'attach', hostId: 'hlsj', sessionName: 'tg-lat', cols: 100, rows: 30, exclusive: false })
const attachOk = await new Promise((res) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    if (buf.includes('"attached"')) { clearInterval(iv); res(true) }
    else if (Date.now() - t0 > 20000) { clearInterval(iv); res(false) }
  }, 100)
})
if (!attachOk) {
  console.log('attach 失败. 输出:', JSON.stringify(buf.slice(-500)))
  process.exit(1)
}
console.log('== 软件层 attach hlsj/tg-lat 成功')
await sleep(1500)
const delays = []
for (let i = 0; i < 6; i++) {
  const t0 = nowMs()
  send({ type: 'input', data: 'AB' })
  const got = await new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false) }, 5000)
    const listener = (text) => { if (text.includes('AB')) { cleanup(); resolve(true) } }
    const cleanup = () => { listeners.splice(listeners.indexOf(listener), 1); clearTimeout(timer) }
    listeners.push(listener)
  })
  if (got) delays.push(nowMs() - t0)
  send({ type: 'input', data: '\r' })
  await sleep(200)
}
delays.sort()
const mid = delays[Math.floor(delays.length / 2)]
console.log('== 软件层 ssh(hlsj attach)打字回显: 中位=' + mid.toFixed(1) + 'ms 原始=[' + delays.map((v) => v.toFixed(1)).join(', ') + ']')
send({ type: 'input', data: 'exit\r' })
ws.close()
process.exit(0)
