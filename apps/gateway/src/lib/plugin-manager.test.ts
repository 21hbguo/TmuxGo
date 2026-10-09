import '../test-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { PluginManager } from './plugin-manager.js'
import { listScopedApiTokens, verifyScopedApiToken } from './access-scope.js'

test('runs plugin commands without inheriting sensitive gateway environment', async () => {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const previousPassword = process.env.TMUXGO_AUTH_PASSWORD
  const previousGatewayPassword = process.env.GATEWAY_PASSWORD
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-manager-'))
  try {
    process.env.TMUXGO_CONFIG_DIR = path.join(temp, 'config')
    process.env.TMUXGO_AUTH_PASSWORD = 'secret-password'
    process.env.GATEWAY_PASSWORD = 'gateway-secret'
    const pluginRoot = path.join(temp, 'plugin')
    const scriptPath = path.join(pluginRoot, 'env.js')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'tmuxgo-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'env-check',
        name: 'Env Check',
        version: '1.0.0',
        minTmuxGoVersion: '0.1.0',
        platforms: ['linux', 'macos', 'windows'],
        permissions: ['actions.execute'],
        contributes: { actions: [{ id: 'print', title: 'Print env', command: [process.execPath, scriptPath] }] },
      }),
      'utf8',
    )
    await writeFile(
      scriptPath,
      "const keys=['TMUXGO_AUTH_PASSWORD','GATEWAY_PASSWORD','PATH','TMUXGO_PLUGIN_ID','TMUXGO_API_URL','TMUXGO_API_TOKEN'];console.log(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]||null]))))",
      'utf8',
    )
    const manager = new PluginManager()
    await manager.link(pluginRoot)
    await manager.setGrantedPermissions('env-check', ['actions.execute'])
    const log = await manager.invokeAction('env-check', 'print', {})
    assert.equal(log.status, 'success')
    const env = JSON.parse(log.stdout)
    assert.equal(env.TMUXGO_AUTH_PASSWORD, null)
    assert.equal(env.GATEWAY_PASSWORD, null)
    assert.equal(env.TMUXGO_PLUGIN_ID, 'env-check')
    assert.match(env.TMUXGO_API_URL, new RegExp('/api$'))
    assert.equal(env.TMUXGO_API_TOKEN, null)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    if (previousPassword === undefined) delete process.env.TMUXGO_AUTH_PASSWORD
    else process.env.TMUXGO_AUTH_PASSWORD = previousPassword
    if (previousGatewayPassword === undefined) delete process.env.GATEWAY_PASSWORD
    else process.env.GATEWAY_PASSWORD = previousGatewayPassword
    await rm(temp, { recursive: true, force: true })
  }
})

test('injects a scoped api token only when api.access is granted and revokes it afterwards', async () => {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-token-'))
  try {
    process.env.TMUXGO_CONFIG_DIR = path.join(temp, 'config')
    const pluginRoot = path.join(temp, 'plugin')
    const scriptPath = path.join(pluginRoot, 'env.js')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'tmuxgo-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'api-check',
        name: 'Api Check',
        version: '1.0.0',
        minTmuxGoVersion: '0.1.0',
        platforms: ['linux', 'macos', 'windows'],
        permissions: ['actions.execute', 'api.access'],
        contributes: { actions: [{ id: 'print', title: 'Print env', command: [process.execPath, scriptPath] }] },
      }),
      'utf8',
    )
    await writeFile(scriptPath, "process.stdout.write(process.env.TMUXGO_API_TOKEN || '')", 'utf8')
    const manager = new PluginManager()
    await manager.link(pluginRoot)
    // 未授予：注空串，也不签发
    await manager.setGrantedPermissions('api-check', ['actions.execute'])
    assert.equal(listScopedApiTokens().length, 0)
    await manager.setGrantedPermissions('api-check', ['actions.execute', 'api.access'])
    const log = await manager.invokeAction('api-check', 'print', {})
    assert.equal(log.status, 'success')
    assert.match(log.stdout, /^tgk_/)
    const granted = verifyScopedApiToken(log.stdout)
    assert.equal(granted?.name, 'plugin-api-check')
    assert.deepEqual(granted?.scope, { hosts: '*', readOnly: true })
    // 二次调用复用同一 token，不重复签发
    const again = await manager.invokeAction('api-check', 'print', {})
    assert.equal(again.stdout, log.stdout)
    assert.equal(listScopedApiTokens().length, 1)
    // 收回权限即吊销：token 进 access-scopes.json 留档但 verify 失效
    await manager.setGrantedPermissions('api-check', ['actions.execute'])
    assert.equal(verifyScopedApiToken(log.stdout), null)
    assert.equal(listScopedApiTokens().length, 1)
    assert.equal(listScopedApiTokens()[0].revokedAt !== null, true)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(temp, { recursive: true, force: true })
  }
})

test('api.write upgrades the token scope and rotate replaces the token', async () => {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-write-'))
  try {
    process.env.TMUXGO_CONFIG_DIR = path.join(temp, 'config')
    const pluginRoot = path.join(temp, 'plugin')
    const scriptPath = path.join(pluginRoot, 'env.js')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'tmuxgo-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'api-write',
        name: 'Api Write',
        version: '1.0.0',
        minTmuxGoVersion: '0.1.0',
        platforms: ['linux', 'macos', 'windows'],
        permissions: ['actions.execute', 'api.access', 'api.write'],
        contributes: { actions: [{ id: 'print', title: 'Print env', command: [process.execPath, scriptPath] }] },
      }),
      'utf8',
    )
    await writeFile(scriptPath, "process.stdout.write(process.env.TMUXGO_API_TOKEN || '')", 'utf8')
    const manager = new PluginManager()
    await manager.link(pluginRoot)
    // 只授 api.access → readOnly；补授 api.write 后旧 token 吊销，下次调用重签为可写
    await manager.setGrantedPermissions('api-write', ['actions.execute', 'api.access'])
    const ro = await manager.invokeAction('api-write', 'print', {})
    assert.equal(verifyScopedApiToken(ro.stdout)?.scope.readOnly, true)
    await manager.setGrantedPermissions('api-write', ['actions.execute', 'api.access', 'api.write'])
    assert.equal(verifyScopedApiToken(ro.stdout), null)
    const rw = await manager.invokeAction('api-write', 'print', {})
    assert.notEqual(rw.stdout, ro.stdout)
    assert.equal(verifyScopedApiToken(rw.stdout)?.scope.readOnly, undefined)
    // rotate：旧 token 立即失效，新 token 生效且不同
    const rotated = await manager.rotateApiToken('api-write')
    assert.notEqual(rotated.token, rw.stdout)
    assert.equal(verifyScopedApiToken(rw.stdout), null)
    assert.equal(verifyScopedApiToken(rotated.token)?.name, 'plugin-api-write')
    const after = await manager.invokeAction('api-write', 'print', {})
    assert.equal(after.stdout, rotated.token)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(temp, { recursive: true, force: true })
  }
})

test('rejects manifests declaring api.write without api.access', async () => {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-badwrite-'))
  try {
    process.env.TMUXGO_CONFIG_DIR = path.join(temp, 'config')
    const pluginRoot = path.join(temp, 'plugin')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'tmuxgo-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'bad-write',
        name: 'Bad Write',
        version: '1.0.0',
        minTmuxGoVersion: '0.1.0',
        platforms: ['linux'],
        permissions: ['api.write'],
      }),
      'utf8',
    )
    const manager = new PluginManager()
    await assert.rejects(manager.link(pluginRoot), /api\.write requires api\.access/)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(temp, { recursive: true, force: true })
  }
})

test('uninstalling a plugin revokes its api token even when keepData is set', async () => {
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-plugin-uninstall-'))
  try {
    process.env.TMUXGO_CONFIG_DIR = path.join(temp, 'config')
    const pluginRoot = path.join(temp, 'plugin')
    const scriptPath = path.join(pluginRoot, 'env.js')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'tmuxgo-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'api-uninstall',
        name: 'Api Uninstall',
        version: '1.0.0',
        minTmuxGoVersion: '0.1.0',
        platforms: ['linux', 'macos', 'windows'],
        permissions: ['actions.execute', 'api.access'],
        contributes: { actions: [{ id: 'print', title: 'Print env', command: [process.execPath, scriptPath] }] },
      }),
      'utf8',
    )
    await writeFile(scriptPath, "process.stdout.write(process.env.TMUXGO_API_TOKEN || '')", 'utf8')
    const manager = new PluginManager()
    await manager.link(pluginRoot)
    await manager.setGrantedPermissions('api-uninstall', ['actions.execute', 'api.access'])
    const log = await manager.invokeAction('api-uninstall', 'print', {})
    assert.equal(log.status, 'success')
    await manager.uninstall('api-uninstall', true)
    assert.equal(verifyScopedApiToken(log.stdout), null)
    await assert.rejects(
      readFile(path.join(process.env.TMUXGO_CONFIG_DIR, 'plugin-data', 'api-uninstall', 'api-token'), 'utf8'),
      { code: 'ENOENT' },
    )
  } finally {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(temp, { recursive: true, force: true })
  }
})
