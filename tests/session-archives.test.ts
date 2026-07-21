import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { sessionArchiveRoutes } from '../apps/gateway/src/routes/session-archives'

const execFileAsync = promisify(execFile)
test('captures visible and historical session output and manages archives', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-archives-'))
  const sessionName = `tmuxgo-archive-${process.pid}-${Date.now()}`
  const sessionId = `session-local-${sessionName}`
  process.env.TMUXGO_CONFIG_DIR = configDir
  const app = Fastify()
  await app.register(sessionArchiveRoutes, { prefix: '/api' })
  await execFileAsync('tmux', ['new-session', '-d', '-s', sessionName, "sh -c 'for i in $(seq 1 200); do echo archive-line-$i; done; sleep 10'"])
  await execFileAsync('tmux', ['resize-window', '-t', sessionName, '-x', '80', '-y', '12'])
  await new Promise((resolve) => setTimeout(resolve, 150))
  t.after(async () => {
    await app.close()
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
    delete process.env.TMUXGO_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
  })
  const visible = await app.inject({ method: 'POST', url: '/api/hosts/local/session-archives', payload: { sessionId, captureMode: 'visible', maxBytesPerSession: 4096, retentionDays: 7 } })
  assert.equal(visible.statusCode, 200)
  assert.equal(visible.json().captureMode, 'visible')
  const visibleDetail = await app.inject({ method: 'GET', url: `/api/hosts/local/session-archives/${visible.json().id}` })
  assert.doesNotMatch(visibleDetail.json().panes[0].data, /archive-line-1\n/)
  assert.match(visibleDetail.json().panes[0].data, /archive-line-200/)
  const history = await app.inject({ method: 'POST', url: '/api/hosts/local/session-archives', payload: { sessionId, captureMode: 'history', maxBytesPerSession: 8192, retentionDays: 7 } })
  assert.equal(history.statusCode, 200)
  assert.ok(history.json().size <= 8192)
  const historyDetail = await app.inject({ method: 'GET', url: `/api/hosts/local/session-archives/${history.json().id}` })
  assert.equal(historyDetail.statusCode, 200)
  assert.match(historyDetail.json().panes[0].data, /archive-line-1\n/)
  assert.match(historyDetail.json().panes[0].data, /archive-line-200/)
  const list = await app.inject({ method: 'GET', url: `/api/hosts/local/session-archives?sessionId=${encodeURIComponent(sessionId)}` })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().archives.length, 2)
  assert.equal('panes' in list.json().archives[0], false)
  const removed = await app.inject({ method: 'DELETE', url: `/api/hosts/local/session-archives/${visible.json().id}` })
  assert.equal(removed.statusCode, 200)
  const finalList = await app.inject({ method: 'GET', url: '/api/hosts/local/session-archives' })
  assert.equal(finalList.json().archives.length, 1)
})
