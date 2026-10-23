// git-executor 是 git 操作的唯一执行层：本机走 execFile('git')，远端走 ssh/sshpass 拼一条
// shell 命令行。参数转义和错误分类错一次就是用户仓库数据丢失，所以三层通道分别测真行为：
// 本机跑真 git（argv 直传，不经 shell）、远端用 test-shims 桩 ssh 断言拼出来的命令行、
// agent 通道用 Object.assign 桩 executeShell（WS 通道本身由 agent-manager.test 覆盖）。
import '../test-env.js'
import assert from 'node:assert/strict'
import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import test, { after, type TestContext } from 'node:test'
import { execGit } from './git-executor.js'
import { agentManager } from '../agent-manager.js'
import { getHostConnectivity, removeHostConnectivity } from './host-connectivity.js'
import { upsertRemoteHost, type HostInput } from './hosts.js'
import { installShims, lastShimArgs } from '../test-shims.js'

const execFileAsync = promisify(execFile)

// ssh/sshpass 桩在整个文件生命周期内前置进 PATH：git-executor 每次调用都重新探测
// hasSshPass()（无模块级缓存），因此不需要像 tmux-executor 那样拆成两个文件
const shims = installShims(['ssh', 'sshpass'])
after(() => shims.restore())

async function runGit(cwd: string, args: string[]) {
  return execFileAsync('git', ['-C', cwd, ...args])
}

// 每个用例独立配置域 + 独立仓库：execGit('local') 直接跑用户可写的 git，绝不能落进真实仓库
async function createRepo(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-exec-'))
  const repository = path.join(base, 'repository')
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = path.join(base, 'config')
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    await rm(base, { recursive: true, force: true })
  })
  await runGit(base, ['init', '-b', 'main', 'repository'])
  await runGit(repository, ['config', 'user.email', 'test@tmuxgo.dev'])
  await runGit(repository, ['config', 'user.name', 'TmuxGo Test'])
  await runGit(repository, ['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(repository, 'base.txt'), 'base\n')
  await runGit(repository, ['add', 'base.txt'])
  await runGit(repository, ['commit', '-m', 'Initial commit'])
  return repository
}

async function withRemoteHost(t: TestContext, host: HostInput) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-exec-remote-'))
  const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = path.join(base, 'config')
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    removeHostConnectivity(host.id)
    delete process.env.SHIM_SSH_STDOUT
    delete process.env.SHIM_SSH_STDERR
    delete process.env.SHIM_SSH_EXIT
    delete process.env.SHIM_PASSWORD_STDOUT
    delete process.env.SHIM_PASSWORD_STDERR
    delete process.env.SHIM_PASSWORD_EXIT
    await rm(base, { recursive: true, force: true })
  })
  await upsertRemoteHost(host)
}

const keyHost: HostInput = { id: 'ssh-key', address: '192.0.2.110', user: 'dev', port: 22 }
const passwordHost: HostInput = {
  id: 'ssh-password',
  address: '192.0.2.110',
  user: 'dev',
  port: 22,
  password: 'pw-for-test',
}

test('runs local git with argv passed verbatim (quotes, spaces and -- separators survive)', async (t) => {
  const repository = await createRepo(t)
  // 文件名/提交信息里塞满 shell 元字符：本机通道是 execFile（无 shell），必须原样到达 git；
  // 一旦有人把实现换成 exec/拼接字符串，这些断言就会红
  const fileName = `weird 'name' "quoted" --dashed $(echo).txt`
  const message = `subject with 'single' "double" --flag $(touch pwned) \`tick\``
  await writeFile(path.join(repository, fileName), 'payload\n')
  await execGit('local', ['add', '--', fileName], repository)
  await execGit('local', ['commit', '-m', message], repository)

  const subject = await runGit(repository, ['log', '-1', '--format=%s'])
  assert.equal(subject.stdout.trim(), message)
  const tracked = await runGit(repository, ['ls-files', '-z'])
  assert.ok(tracked.stdout.split('\0').includes(fileName))
  // 命令替换没有被执行：仓库里不该出现 pwned
  const leftover = await runGit(repository, ['status', '--porcelain'])
  assert.equal(leftover.stdout.trim(), '')
  assert.equal((await readFile(path.join(repository, 'base.txt'), 'utf8')).trim(), 'base')
})

test('trims the host id and rejects empty or unknown hosts', async () => {
  await assert.rejects(execGit('', ['status'], '/tmp'), { message: 'Missing host id' })
  await assert.rejects(execGit('   ', ['status'], '/tmp'), { message: 'Missing host id' })
  await assert.rejects(execGit('ghost-host', ['status'], '/tmp'), { message: 'Host "ghost-host" not found' })
})

test('maps non-repository failures to the git message and keeps the cause', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-git-exec-bare-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })
  const error = await execGit('local', ['status'], base).then(
    () => null,
    (err: Error) => err,
  )
  assert.ok(error, 'non-repository directory must fail')
  // git 的文案随 locale 变化（本机是中文），只断言「透传了 git 自己的 stderr」而不是英文串
  assert.match(error.message, /^fatal:/)
  assert.ok(error.message.length > 'fatal:'.length)
  assert.ok((error as Error & { cause?: unknown }).cause, 'original exec error must be preserved as cause')
})

test('acceptExitCodeOne turns the "no value" exit into an empty result, otherwise it throws', async (t) => {
  const repository = await createRepo(t)
  // rev-parse --verify -q 在 ref 不存在时退 1（git 的正常否定语义），status 端点靠这个判 MERGE_HEAD
  const accepted = await execGit('local', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], repository, undefined, true)
  assert.deepEqual(accepted, { stdout: '', stderr: '' })
  await assert.rejects(execGit('local', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], repository))
  // 存在时正常返回哈希
  const head = await execGit('local', ['rev-parse', '--verify', '-q', 'HEAD'], repository, undefined, true)
  assert.equal(head.stdout.trim().length, 40)
})

test('remote key-auth channel quotes cwd and every arg into one remote command', async (t) => {
  await withRemoteHost(t, keyHost)
  process.env.SHIM_SSH_STDOUT = ' M file with space.txt\n'
  process.env.SHIM_SSH_EXIT = '0'
  const cwd = `/tmp/repo with 'quote'`
  const result = await execGit('ssh-key', ['add', '--', `a b's.txt`], cwd)
  assert.equal(result.stdout, ' M file with space.txt\n')

  const sshArgs = lastShimArgs(shims, 'ssh') ?? []
  assert.equal(shims.count('sshpass'), 0, 'key-auth host must not go through sshpass')
  assert.ok(sshArgs.includes('-T'), 'no pty for git')
  assert.equal(sshArgs[sshArgs.length - 2], '--', 'remote command must follow -- so it cannot parse as an ssh flag')
  assert.equal(sshArgs[sshArgs.length - 1], `cd '/tmp/repo with '\\''quote'\\''' && git 'add' '--' 'a b'\\''s.txt'`)
  assert.ok(sshArgs.includes('dev@192.0.2.110'))
  assert.ok(sshArgs.includes('BatchMode=yes'), 'no password configured -> BatchMode must stay on')
  assert.equal(
    sshArgs.some((arg) => arg.includes('ssh-key')),
    false,
  )
})

test('remote channel accepts exit code 1 only when the caller allows it', async (t) => {
  await withRemoteHost(t, keyHost)
  process.env.SHIM_SSH_STDOUT = ''
  process.env.SHIM_SSH_STDERR = ''
  process.env.SHIM_SSH_EXIT = '1'
  assert.deepEqual(await execGit('ssh-key', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], '/repo', undefined, true), {
    stdout: '',
    stderr: '',
  })
  await assert.rejects(execGit('ssh-key', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], '/repo'))
})

test('classifies ssh failures and records the host as offline', async (t) => {
  await withRemoteHost(t, keyHost)
  const cases: Array<{ stderr: string; expected: string }> = [
    { stderr: 'dev@192.0.2.110: Permission denied (publickey).', expected: 'SSH authentication failed' },
    { stderr: 'Host key verification failed.', expected: 'Host key verification failed' },
    { stderr: 'ssh: connect to host 192.0.2.110 port 22: Connection timed out', expected: 'SSH connection timed out' },
    {
      stderr: 'ssh: Could not resolve hostname nope: Name or service not known',
      expected: 'SSH network is unreachable',
    },
  ]
  for (const item of cases) {
    process.env.SHIM_SSH_EXIT = '255'
    process.env.SHIM_SSH_STDERR = item.stderr
    await assert.rejects(execGit('ssh-key', ['status'], '/repo'), { message: item.expected })
    assert.equal(getHostConnectivity('ssh-key')?.status, 'offline')
    assert.equal(getHostConnectivity('ssh-key')?.lastError, item.expected)
  }
  // 未知错误原样透传（不得吞成 "SSH 失败"），且不算连接故障
  removeHostConnectivity('ssh-key')
  process.env.SHIM_SSH_STDERR = 'fatal: not a git repository (or any parent)'
  await assert.rejects(execGit('ssh-key', ['status'], '/repo'), {
    message: 'fatal: not a git repository (or any parent)',
  })
  assert.equal(getHostConnectivity('ssh-key'), undefined)
})

test('password hosts run through sshpass -e with the password only in the environment', async (t) => {
  await withRemoteHost(t, passwordHost)
  process.env.SHIM_PASSWORD_STDOUT = 'remote-out\n'
  process.env.SHIM_PASSWORD_EXIT = '0'
  const result = await execGit('ssh-password', ['log', '-n1'], '/srv/repo')
  assert.equal(result.stdout, 'remote-out\n')
  const sshpassArgs = lastShimArgs(shims, 'sshpass') ?? []
  assert.deepEqual(sshpassArgs.slice(0, 2), ['-e', 'ssh'])
  assert.ok(sshpassArgs.includes('BatchMode=no'), 'password channel needs interactive auth enabled')
  assert.equal(
    sshpassArgs.some((arg) => arg.includes('pw-for-test')),
    false,
    'password must never appear on the command line',
  )
  assert.ok((lastShimArgs(shims, 'ssh') ?? []).includes("cd '/srv/repo' && git 'log' '-n1'"))
  const envLine = shims
    .readLog()
    .filter((line) => line.startsWith('SSHPASS='))
    .at(-1)
  assert.equal(envLine, 'SSHPASS=pw-for-test')
})

test('password host without sshpass installed fails fast instead of silently using keys', async (t) => {
  await withRemoteHost(t, passwordHost)
  const previousPath = process.env.PATH
  // hasSshPass() 无缓存：把 PATH 指到空目录即可复现「配了密码但机器没 sshpass」
  process.env.PATH = '/nonexistent-tmuxgo-bin'
  t.after(() => {
    process.env.PATH = previousPath
  })
  await assert.rejects(execGit('ssh-password', ['status'], '/repo'), {
    message: 'SSH password configured but sshpass is not installed',
  })
})

test('agent channel wins over ssh and escapes the same way', async (t) => {
  await withRemoteHost(t, keyHost)
  const calls: string[] = []
  const sshCallsBefore = shims.count('ssh')
  Object.assign(agentManager, {
    getAgent: (id: string) =>
      id === 'ssh-key' ? ({ id, online: true } as unknown as ReturnType<typeof agentManager.getAgent>) : undefined,
    executeShell: async (_id: string, command: string) => {
      calls.push(command)
      return { stdout: 'agent-out\n', stderr: '', exitCode: 0 }
    },
  })
  t.after(() => {
    delete (agentManager as unknown as Record<string, unknown>).getAgent
    delete (agentManager as unknown as Record<string, unknown>).executeShell
  })

  const result = await execGit('ssh-key', ['commit', '-m', `it's ok`], `/srv/repo's dir`)
  assert.deepEqual(result, { stdout: 'agent-out\n', stderr: '' })
  assert.deepEqual(calls, [`cd '/srv/repo'\\''s dir' && git 'commit' '-m' 'it'\\''s ok'`])
  // 双通道主机：agent 在线时不走 ssh（SSH 记录仅为兜底）
  assert.equal(shims.count('ssh'), sshCallsBefore)
})

test('agent channel honours acceptExitCodeOne and normalizes ssh-ish failures', async (t) => {
  await withRemoteHost(t, keyHost)
  let exitCode = 1
  Object.assign(agentManager, {
    getAgent: (id: string) =>
      id === 'ssh-key' ? ({ id, online: true } as unknown as ReturnType<typeof agentManager.getAgent>) : undefined,
    executeShell: async () => ({ stdout: '', stderr: '', exitCode }),
  })
  t.after(() => {
    delete (agentManager as unknown as Record<string, unknown>).getAgent
    delete (agentManager as unknown as Record<string, unknown>).executeShell
  })
  assert.deepEqual(await execGit('ssh-key', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], '/repo', undefined, true), {
    stdout: '',
    stderr: '',
  })
  await assert.rejects(execGit('ssh-key', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], '/repo'))
  exitCode = 128
  Object.assign(agentManager, {
    executeShell: async () => ({ stdout: '', stderr: 'Permission denied (publickey).', exitCode }),
  })
  await assert.rejects(execGit('ssh-key', ['status'], '/repo'), { message: 'SSH authentication failed' })
})
