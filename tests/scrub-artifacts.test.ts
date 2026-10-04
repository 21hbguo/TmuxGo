import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { collectSecrets, scrubText } from '../scripts/scrub-e2e-artifacts.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('collectSecrets picks TMUXGO secret-shaped env values above min length', () => {
  const secrets = collectSecrets({
    TMUXGO_AGENT_EVENT_TOKEN: 'deadbeef123456',
    TMUXGO_AUTH_E2E_PASSWORD: 'admin123',
    TMUXGO_ENV: '1', // 太短不采
    PATH: '/usr/bin',
  } as NodeJS.ProcessEnv)
  assert.ok(secrets.has('deadbeef123456'))
  assert.ok(secrets.has('admin123'))
  assert.ok(!secrets.has('1'))
  assert.ok(!secrets.has('/usr/bin'))
})

test('scrubText redacts env secrets and credential-shaped strings', () => {
  const text = [
    'token=deadbeef123456 done',
    'Authorization: Bearer abcdef1234567890',
    'x-tmuxgo-agent-token: feedface98765',
    'normal log line',
  ].join('\n')
  const out = scrubText(text, new Set(['deadbeef123456']))
  assert.ok(!out.includes('deadbeef123456'))
  assert.ok(!out.includes('abcdef1234567890'))
  assert.ok(!out.includes('feedface98765'))
  assert.ok(out.includes('normal log line'))
})

test('cli scrubs text artifacts in place and leaves binaries alone', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tmuxgo-scrub-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'nested'), { recursive: true })
  await writeFile(join(dir, 'trace.txt'), 'password admin123 secret', 'utf8')
  await writeFile(join(dir, 'nested', 'result.json'), '{"pw":"admin123"}', 'utf8')
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff])
  await writeFile(join(dir, 'trace.zip'), binary)

  const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/scrub-e2e-artifacts.ts'), dir], {
    encoding: 'utf8',
    env: { ...process.env, TMUXGO_AUTH_E2E_PASSWORD: 'admin123' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /redacted 2/)
  assert.ok(!(await readFile(join(dir, 'trace.txt'), 'utf8')).includes('admin123'))
  assert.ok(!(await readFile(join(dir, 'nested', 'result.json'), 'utf8')).includes('admin123'))
  assert.deepEqual(await readFile(join(dir, 'trace.zip')), binary) // zip 原样
})

test('cli exits 0 when artifact dirs are missing', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(root, 'scripts/scrub-e2e-artifacts.ts'), join(tmpdir(), 'tmuxgo-no-such-dir-xyz')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0)
})
