import '../test-env.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { PluginManager } from './plugin-manager.js'

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
      "const keys=['TMUXGO_AUTH_PASSWORD','GATEWAY_PASSWORD','PATH','TMUXGO_PLUGIN_ID','TMUXGO_API_URL'];console.log(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]||null]))))",
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
