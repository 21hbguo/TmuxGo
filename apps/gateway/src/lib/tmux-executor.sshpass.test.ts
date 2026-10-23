// sshpass 存在这一侧的分支：hasSshPass() 结果在模块级缓存且无重置缝，与
// tmux-executor.test.ts（把缓存钉成「缺失」）互斥，因此单独一个测试文件，
// 由 node --test 各自开进程，缓存从头解析。
import '../test-env.js'
import assert from 'node:assert/strict'
import test, { after, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execHostShell, execTmux, verifyHostConnectivity } from './tmux-executor.js'
import { upsertRemoteHost, type HostInput } from './hosts.js'
import { installShims, lastShimArgs } from '../test-shims.js'

// 必须在任何 executor 调用前前置：首次 hasSshPass() 探测决定整个进程的结果
const shims = installShims(['ssh', 'sshpass'])
after(() => shims.restore())

const passwordHost: HostInput = {
  id: 'ssh-password',
  address: '192.0.2.110',
  user: 'dev',
  port: 22,
  password: 'pw-for-test',
}

async function withHostStore(t: TestContext, hosts: HostInput[]) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-executor-sshpass-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  for (const host of hosts) await upsertRemoteHost(host)
}

test('execTmux sends password auth through sshpass with SSHPASS in the environment', async (t) => {
  await withHostStore(t, [passwordHost])
  process.env.SHIM_PASSWORD_STDOUT = 'remote-panes\n'
  process.env.SHIM_PASSWORD_EXIT = '0'
  const tmux = await execTmux('ssh-password', ['list-panes'])
  assert.equal(tmux.stdout, 'remote-panes\n')
  assert.equal(tmux.host.id, 'ssh-password')
  const sshpassArgs = lastShimArgs(shims, 'sshpass') ?? []
  // sshpass -e ssh ...：密码只经环境变量下发，命令行里绝不能出现明文
  assert.deepEqual(sshpassArgs.slice(0, 2), ['-e', 'ssh'])
  assert.ok(sshpassArgs.includes('BatchMode=no'), '密码通道必须允许交互式认证')
  assert.ok(sshpassArgs.some((arg) => arg.includes('list-panes')))
  assert.equal(
    sshpassArgs.some((arg) => arg.includes('pw-for-test')),
    false,
  )
  const sshCall =
    shims
      .readLog()
      .filter((line) => line.startsWith('ssh\t'))
      .at(-1) ?? ''
  assert.ok(sshCall.includes('list-panes'))
  assert.equal(sshCall.includes('pw-for-test'), false)
  assert.equal(
    shims
      .readLog()
      .filter((line) => line.startsWith('SSHPASS='))
      .at(-1),
    'SSHPASS=pw-for-test',
  )

  const shell = await execHostShell('ssh-password', 'printf hi')
  assert.equal(shell.stdout, 'remote-panes\n')
  assert.ok((lastShimArgs(shims, 'sshpass') ?? []).some((arg) => arg.includes("sh -lc 'printf hi'")))
})

test('verifyHostConnectivity falls back to the password channel and classifies its outcome', async (t) => {
  await withHostStore(t, [passwordHost])
  // 密钥通道失败、密码通道成功
  process.env.SHIM_SSH_STDERR = 'dev@192.0.2.110: Permission denied (publickey).'
  process.env.SHIM_SSH_EXIT = '255'
  process.env.SHIM_PASSWORD_STDOUT = 'tmuxgo-ok\n'
  process.env.SHIM_PASSWORD_EXIT = '0'
  assert.deepEqual(await verifyHostConnectivity('ssh-password'), {
    ok: true,
    message: 'ssh ready',
    mode: 'password',
  })
  // 密码通道连上了但回显不是约定串：判认证失败，不得算 ready
  process.env.SHIM_PASSWORD_STDOUT = ''
  assert.deepEqual(await verifyHostConnectivity('ssh-password'), {
    ok: false,
    message: 'SSH authentication failed',
    mode: 'password',
    code: 'AUTHENTICATION_ERROR',
  })
  // 密码通道也失败：走与密钥通道同一套错误归一化
  process.env.SHIM_PASSWORD_STDERR = 'Host key verification failed.'
  process.env.SHIM_PASSWORD_EXIT = '255'
  assert.deepEqual(await verifyHostConnectivity('ssh-password'), {
    ok: false,
    message: 'Host key verification failed',
    mode: 'password',
    code: 'HOST_KEY_ERROR',
  })
})

test('sshpass failures surface through the same error normalization', async (t) => {
  await withHostStore(t, [passwordHost])
  process.env.SHIM_PASSWORD_STDERR = 'ssh: connect to host 192.0.2.110 port 22: Connection refused'
  process.env.SHIM_PASSWORD_EXIT = '255'
  await assert.rejects(execTmux('ssh-password', ['list-panes']), /SSH network is unreachable/)
  await assert.rejects(execHostShell('ssh-password', 'printf hi'), /SSH network is unreachable/)
})
