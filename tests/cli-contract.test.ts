import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cliBin = join(root, 'apps/cli/bin/tmuxgo.mjs')

test('cli --help prints usage and exits 0 without side effects', () => {
  const result = spawnSync(process.execPath, [cliBin, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage: npx @21hbguo\/tmuxgo \[install\|status\|uninstall\]/)
})

test('cli rejects unknown commands', () => {
  const result = spawnSync(process.execPath, [cliBin, 'bogus'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /Unknown command: bogus/)
})

// npm pack 干跑校验打包契约：--ignore-scripts 跳过 prepack 全量构建，只验证 files 收集
test('cli package is packable and ships its entry files', () => {
  const result = spawnSync('npm', ['pack', '--workspace=@21hbguo/tmuxgo', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const [pack] = JSON.parse(result.stdout)
  const files = pack.files.map((file: { path: string }) => file.path)
  for (const expected of ['package.json', 'bin/tmuxgo.mjs', 'lib/cli.mjs', 'lib/server.mjs', 'lib/postinstall.mjs']) {
    assert.ok(files.includes(expected), `packed tarball is missing ${expected}`)
  }
})
