import '../test-env.js'
import assert from 'node:assert/strict'
import net from 'net'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'

// auth 开关在模块加载时读取环境变量，先置空密码再走免 ticket 路径
process.env.TMUXGO_AUTH_PASSWORD = ''
const { vncRoutes } = await import('./vnc.js')

// 找一个 5900-5999 内的空闲端口做假 RFB 服务；全被占用则跳过
async function findVncPort(): Promise<number | null> {
  for (let port = 5920; port < 6000; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  return null
}

test('vnc route pipes binary WebSocket frames to the loopback VNC server', async (t) => {
  const vncPort = await findVncPort()
  if (vncPort === null) return t.skip('no free port in VNC range')
  const received: Buffer[] = []
  const server = net.createServer((socket) => {
    socket.write('RFB 003.008\n')
    socket.on('data', (chunk) => {
      received.push(chunk)
      socket.write('ack')
    })
  })
  await new Promise<void>((resolve) => server.listen(vncPort, '127.0.0.1', resolve))
  const app = Fastify()
  await app.register(websocket)
  await app.register(vncRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const gatewayPort = typeof address === 'object' && address ? address.port : 0
  t.after(async () => {
    await app.close()
    server.close()
  })
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/vnc?hostId=local&port=${vncPort}`)
  ws.binaryType = 'arraybuffer'
  const greeting = await new Promise<ArrayBuffer>((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(event.data as ArrayBuffer), { once: true })
    ws.addEventListener('close', (event) => reject(new Error(`closed ${event.code} ${event.reason}`)), { once: true })
  })
  assert.equal(Buffer.from(greeting).toString(), 'RFB 003.008\n')
  const ack = new Promise<ArrayBuffer>((resolve) =>
    ws.addEventListener('message', (event) => resolve(event.data as ArrayBuffer), { once: true }),
  )
  ws.send(Buffer.from('hello'))
  assert.equal(Buffer.from(await ack).toString(), 'ack')
  assert.equal(received[0]?.toString(), 'hello')
  ws.close()
})

test('vnc route rejects ports outside the display range', async (t) => {
  const app = Fastify()
  await app.register(websocket)
  await app.register(vncRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const gatewayPort = typeof address === 'object' && address ? address.port : 0
  t.after(() => app.close())
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/vnc?hostId=local&port=80`)
  const code = await new Promise<number>((resolve) =>
    ws.addEventListener('close', (event) => resolve(event.code), { once: true }),
  )
  assert.equal(code, 1008)
})
