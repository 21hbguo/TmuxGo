import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'

const execFileAsync = promisify(execFile)

test('links, runs, stores and removes a plugin', async (t) => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-test-'))
  const previousConfigRoot = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configRoot
  t.after(async () => {
    if (previousConfigRoot === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigRoot
    await rm(configRoot, { recursive: true, force: true })
  })
  const pluginRoot = path.join(configRoot, 'fixture')
  await mkdir(path.join(pluginRoot, 'ui'), { recursive: true })
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.fixture', name: 'Test Fixture', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { actions: [{ id: 'echo-context', title: 'Echo Context', command: [process.execPath, 'action.mjs'] }], views: [{ id: 'main', title: 'Fixture', entry: 'ui/index.html', placement: 'activity' }] } }))
  await writeFile(path.join(pluginRoot, 'action.mjs'), "process.stdout.write(JSON.parse(process.env.TMUXGO_CONTEXT_JSON).hostId)")
  await writeFile(path.join(pluginRoot, 'ui', 'index.html'), '<!doctype html><script src="/api/plugins/runtime.js"></script><div>fixture</div>')
  const { pluginRoutes } = await import('../apps/gateway/src/routes/plugins.ts')
  const app = Fastify()
  await app.register(pluginRoutes, { prefix: '/api' })
  const linked = await app.inject({ method: 'POST', url: '/api/plugins/link', payload: { path: pluginRoot } })
  assert.equal(linked.statusCode, 200)
  assert.equal(linked.json().pluginId, 'test.fixture')
  const list = await app.inject({ method: 'GET', url: '/api/plugins' })
  assert.equal(list.json().plugins.length, 1)
  const invoked = await app.inject({ method: 'POST', url: '/api/plugins/test.fixture/actions/echo-context/invoke', payload: { context: { hostId: 'local' } } })
  assert.equal(invoked.statusCode, 200)
  assert.equal(invoked.json().status, 'success')
  assert.equal(invoked.json().stdout, 'local')
  const stored = await app.inject({ method: 'PUT', url: '/api/plugins/test.fixture/storage/config', payload: { value: { enabled: true } } })
  assert.equal(stored.statusCode, 200)
  const value = await app.inject({ method: 'GET', url: '/api/plugins/test.fixture/storage/config' })
  assert.deepEqual(value.json().value, { enabled: true })
  const asset = await app.inject({ method: 'GET', url: '/api/plugins/test.fixture/assets/ui/index.html' })
  assert.equal(asset.statusCode, 200)
  assert.match(asset.headers['content-security-policy'] || '', /connect-src 'none'/)
  const disabled = await app.inject({ method: 'PATCH', url: '/api/plugins/test.fixture/enabled', payload: { enabled: false } })
  assert.equal(disabled.json().state, 'disabled')
  const blocked = await app.inject({ method: 'POST', url: '/api/plugins/test.fixture/actions/echo-context/invoke', payload: { context: {} } })
  assert.equal(blocked.statusCode, 400)
  const removed = await app.inject({ method: 'DELETE', url: '/api/plugins/test.fixture' })
  assert.equal(removed.statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugins' })).json().plugins.length, 0)
  await app.close()
})

test('rejects invalid and duplicate manifest contributions', async () => {
  const { parsePluginManifest } = await import('../apps/gateway/src/lib/plugin-manifest.ts')
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  assert.throws(() => parsePluginManifest({ schemaVersion: 1, id: '../bad', name: 'Bad', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform] }))
  assert.throws(() => parsePluginManifest({ schemaVersion: 1, id: 'test.duplicate', name: 'Duplicate', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { actions: [{ id: 'run', title: 'Run', command: ['true'] }, { id: 'run', title: 'Run again', command: ['true'] }] } }))
  assert.throws(() => parsePluginManifest({ schemaVersion: 1, id: 'test.script-view', name: 'Script View', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { views: [{ id: 'main', title: 'Main', entry: 'ui/main.js', placement: 'activity' }] } }))
})

test('persists linked plugins and allows broken entries to be disabled and removed', async (t) => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-persist-'))
  const previousConfigRoot = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configRoot
  t.after(async () => {
    if (previousConfigRoot === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigRoot
    await rm(configRoot, { recursive: true, force: true })
  })
  const pluginRoot = path.join(configRoot, 'fixture')
  await mkdir(pluginRoot, { recursive: true })
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.persisted', name: 'Persisted', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform] }))
  const { PluginManager } = await import('../apps/gateway/src/lib/plugin-manager.ts')
  const first = new PluginManager()
  await first.link(pluginRoot)
  const second = new PluginManager()
  assert.equal((await second.listPlugins())[0].pluginId, 'test.persisted')
  await unlink(path.join(pluginRoot, 'tmuxgo-plugin.json'))
  assert.equal((await second.listPlugins())[0].state, 'error')
  const disabled = await second.setEnabled('test.persisted', false)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.state, 'error')
  await second.uninstall('test.persisted')
  assert.equal((await second.listPlugins()).length, 0)
  assert.deepEqual(JSON.parse(await readFile(path.join(configRoot, 'plugins.json'), 'utf8')).plugins, [])
})

test('runs event hooks and enforces the command concurrency limit', async (t) => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-events-'))
  const previousConfigRoot = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configRoot
  t.after(async () => {
    if (previousConfigRoot === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigRoot
    await rm(configRoot, { recursive: true, force: true })
  })
  const pluginRoot = path.join(configRoot, 'fixture')
  await mkdir(pluginRoot, { recursive: true })
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.events', name: 'Events', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { actions: [{ id: 'wait', title: 'Wait', command: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 250)'] }], events: [{ on: 'session.created', command: [process.execPath, '-e', 'process.stdout.write(JSON.parse(process.env.TMUXGO_CONTEXT_JSON).sessionName)'] }] } }))
  const { PluginManager } = await import('../apps/gateway/src/lib/plugin-manager.ts')
  const manager = new PluginManager()
  await manager.link(pluginRoot)
  await manager.emit('session.created', { sessionName: 'audit-session' })
  let eventLog
  for (let index = 0; index < 50; index++) {
    eventLog = (await manager.listLogs('test.events')).find((log) => log.event === 'session.created' && log.status === 'success')
    if (eventLog) break
    await delay(20)
  }
  assert.equal(eventLog?.stdout, 'audit-session')
  const results = await Promise.allSettled(Array.from({ length: 17 }, () => manager.invokeAction('test.events', 'wait')))
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(rejected.length, 1)
  assert.match(String((rejected[0] as PromiseRejectedResult).reason), /Maximum concurrent plugin commands reached/)
  await manager.shutdown()
})

test('terminates plugin process groups on timeout', { skip: process.platform === 'win32' }, async (t) => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-timeout-'))
  const previousConfigRoot = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configRoot
  t.after(async () => {
    if (previousConfigRoot === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigRoot
    await rm(configRoot, { recursive: true, force: true })
  })
  const pluginRoot = path.join(configRoot, 'fixture')
  await mkdir(pluginRoot, { recursive: true })
  const marker = path.join(configRoot, 'plugin-data', 'test.timeout', 'state', 'survived')
  const platform = process.platform === 'darwin' ? 'macos' : 'linux'
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.timeout', name: 'Timeout', version: '0.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], contributes: { actions: [{ id: 'timeout', title: 'Timeout', timeoutMs: 1000, command: [process.execPath, 'action.mjs'] }] } }))
  await writeFile(path.join(pluginRoot, 'action.mjs'), `import { spawn } from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`)}],{stdio:'ignore'});setTimeout(()=>{},5000)`)
  const { PluginManager } = await import('../apps/gateway/src/lib/plugin-manager.ts')
  const manager = new PluginManager()
  await manager.link(pluginRoot)
  const result = await manager.invokeAction('test.timeout', 'timeout')
  assert.equal(result.status, 'timeout')
  await delay(700)
  await assert.rejects(access(marker))
})

test('previews, installs and transactionally updates a pinned GitHub checkout', async (t) => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-github-'))
  const previousConfigRoot = process.env.TMUXGO_CONFIG_DIR
  const previousGitConfigCount = process.env.GIT_CONFIG_COUNT
  const previousGitConfigKey = process.env.GIT_CONFIG_KEY_0
  const previousGitConfigValue = process.env.GIT_CONFIG_VALUE_0
  const previousGitAllowProtocol = process.env.GIT_ALLOW_PROTOCOL
  process.env.TMUXGO_CONFIG_DIR = configRoot
  t.after(async () => {
    if (previousConfigRoot === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigRoot
    if (previousGitConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = previousGitConfigCount
    if (previousGitConfigKey === undefined) delete process.env.GIT_CONFIG_KEY_0
    else process.env.GIT_CONFIG_KEY_0 = previousGitConfigKey
    if (previousGitConfigValue === undefined) delete process.env.GIT_CONFIG_VALUE_0
    else process.env.GIT_CONFIG_VALUE_0 = previousGitConfigValue
    if (previousGitAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL
    else process.env.GIT_ALLOW_PROTOCOL = previousGitAllowProtocol
    await rm(configRoot, { recursive: true, force: true })
  })
  const repository = path.join(configRoot, 'repository')
  const pluginRoot = path.join(repository, 'packages', 'plugin')
  await mkdir(pluginRoot, { recursive: true })
  await execFileAsync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository })
  await execFileAsync('git', ['config', 'user.name', 'TmuxGo Test'], { cwd: repository })
  await execFileAsync('git', ['config', 'user.email', 'tmuxgo@example.invalid'], { cwd: repository })
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  await writeFile(path.join(pluginRoot, 'build.mjs'), "import { writeFileSync } from 'node:fs';writeFileSync('built.txt','ok')")
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.github', name: 'GitHub', version: '1.0.0', minTmuxGoVersion: '0.1.0', platforms: [platform], build: [{ command: [process.execPath, 'build.mjs'] }] }))
  await execFileAsync('git', ['add', '.'], { cwd: repository })
  await execFileAsync('git', ['commit', '--quiet', '-m', 'first'], { cwd: repository })
  const firstCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(repository).href}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/owner/repo.git'
  process.env.GIT_ALLOW_PROTOCOL = 'file'
  const { PluginManager } = await import('../apps/gateway/src/lib/plugin-manager.ts')
  const manager = new PluginManager()
  const firstPreview = await manager.previewGit('owner/repo/packages/plugin', 'main')
  assert.equal(firstPreview.resolvedCommit, firstCommit)
  assert.equal(firstPreview.replacing, false)
  const installed = await manager.installGit(firstPreview.source, firstPreview.resolvedCommit, 'main')
  assert.equal(installed.manifest.version, '1.0.0')
  assert.equal(await readFile(path.join(installed.root, 'built.txt'), 'utf8'), 'ok')
  await manager.setStorage('test.github', 'kept', { value: true })
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.github', name: 'GitHub', version: '1.1.0', minTmuxGoVersion: '0.1.0', platforms: [platform], build: [{ command: [process.execPath, 'build.mjs'] }] }))
  await execFileAsync('git', ['add', '.'], { cwd: repository })
  await execFileAsync('git', ['commit', '--quiet', '-m', 'second'], { cwd: repository })
  const secondCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
  const updatePreview = await manager.previewGit('owner/repo/packages/plugin', 'main')
  assert.equal(updatePreview.resolvedCommit, secondCommit)
  assert.equal(updatePreview.replacing, true)
  const updated = await manager.installGit(updatePreview.source, updatePreview.resolvedCommit, 'main')
  assert.equal(updated.manifest.version, '1.1.0')
  assert.deepEqual(await manager.getStorage('test.github', 'kept'), { value: true })
  await writeFile(path.join(pluginRoot, 'tmuxgo-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'test.github', name: 'GitHub', version: '2.0.0', minTmuxGoVersion: '0.1.0', platforms: [platform], build: [{ command: [process.execPath, '-e', 'process.exit(7)'] }] }))
  await execFileAsync('git', ['add', '.'], { cwd: repository })
  await execFileAsync('git', ['commit', '--quiet', '-m', 'broken'], { cwd: repository })
  const brokenPreview = await manager.previewGit('owner/repo/packages/plugin', 'main')
  await assert.rejects(manager.installGit(brokenPreview.source, brokenPreview.resolvedCommit, 'main'), /Plugin build failed/)
  const afterRollback = (await manager.listPlugins())[0]
  assert.equal(afterRollback.manifest.version, '1.1.0')
  assert.equal(afterRollback.source.resolvedCommit, secondCommit)
  assert.equal(JSON.parse(await readFile(path.join(afterRollback.root, 'tmuxgo-plugin.json'), 'utf8')).version, '1.1.0')
})
