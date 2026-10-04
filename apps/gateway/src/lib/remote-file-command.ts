import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { getHostById, getHostCredentials, type HostRecord } from './hosts.js'
import { recordHostConnectionFailure } from './host-connectivity.js'
import {
  buildHostSshOptions,
  buildSshConfigArgs,
  buildSshMultiplexArgs,
  buildSshPortArgs,
  ensureSshMultiplexDir,
  getSshTarget,
  resolveHostPassword,
} from './ssh-options.js'
import { agentManager } from '../agent-manager.js'

const execFileAsync = promisify(execFile)
const knownAuthMarkers = ['Permission denied']
const knownHostKeyMarkers = ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED']
const knownTimeoutMarkers = ['Connection timed out', 'Operation timed out', 'No route to host']
const knownNetworkMarkers = ['Could not resolve hostname', 'Connection refused', 'Network is unreachable']
// 远端无 python 时的可识别标记：由 pythonChooser 打出，归一化成友好错误
const NO_PYTHON_MARKER = '__TMUXGO_NO_PYTHON__'
// 缓存脚本未落盘时的标记：触发一次带内自举（写文件 + 执行）而非直接报错
const RPC_COLD_MARKER = '__TMUXGO_RPC_COLD__'
const RPC_COLD_EXIT = 75

function escapeShellSingleQuoted(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`
}
export function normalizeRemoteFileErrorMessage(raw: string, fallback: string) {
  const value = raw.trim() || fallback
  if (value.includes(NO_PYTHON_MARKER)) return 'Remote host has no python3/python (file features need Python)'
  if (knownHostKeyMarkers.some((marker) => value.includes(marker))) return 'Host key verification failed'
  if (knownTimeoutMarkers.some((marker) => value.includes(marker))) return 'SSH connection timed out'
  if (knownNetworkMarkers.some((marker) => value.includes(marker))) return 'SSH network is unreachable'
  if (knownAuthMarkers.some((marker) => value.includes(marker))) return 'SSH authentication failed'
  return value
}
// python3 优先、退回 python；两者都无打出标记 exit 127
function pythonChooser() {
  return `PY="$(command -v python3 || command -v python || true)"; [ -n "$PY" ] || { echo ${NO_PYTHON_MARKER} >&2; exit 127; }`
}
// 远端一次性流式脚本（上传写盘/下载读盘/目录打包）统一走 python 选择器。
// 注意不能加 `--`：`python3 -c cmd -- arg` 会把 '--' 留在 sys.argv[1]
export function buildRemotePythonCommand(script: string, args: string[]) {
  const quotedArgs = args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')
  return `${pythonChooser()}; exec "$PY" -c ${escapeShellSingleQuoted(script)}${quotedArgs ? ` ${quotedArgs}` : ''}`
}
function rpcScriptName(script: string) {
  return `file-rpc-${createHash('sha256').update(script).digest('hex').slice(0, 12)}.py`
}
// 热路径：缓存命中直接 exec 文件（省 ~15KB 脚本传输 + -c 全量解析）；
// 未命中以 exit 75 + 标记通知调用方走冷启动
function buildRpcWarmCommand(script: string, args: string[]) {
  const name = rpcScriptName(script)
  const quotedArgs = args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')
  return `${pythonChooser()}; f="$HOME/.tmuxgo/${name}"; [ -f "$f" ] || { echo ${RPC_COLD_MARKER} >&2; exit ${RPC_COLD_EXIT}; }; exec "$PY" "$f"${quotedArgs ? ` ${quotedArgs}` : ''}`
}
// 冷路径：base64 解码落盘 + pid 后缀临时名 + os.replace 原子改名，并发/中断不留半成品
function buildRpcColdCommand(script: string, args: string[]) {
  const name = rpcScriptName(script)
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  const writer = `import base64,os,pathlib,sys\nd=os.path.expanduser("~/.tmuxgo");os.makedirs(d,exist_ok=True)\nf=os.path.join(d,sys.argv[1]);t=f+".tmp-"+str(os.getpid())\npathlib.Path(t).write_bytes(base64.b64decode(sys.argv[2]));os.replace(t,f)`
  const quotedArgs = args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')
  return `${pythonChooser()}; "$PY" -c ${escapeShellSingleQuoted(writer)} ${escapeShellSingleQuoted(name)} ${escapeShellSingleQuoted(encoded)} && exec "$PY" "$HOME/.tmuxgo/${name}"${quotedArgs ? ` ${quotedArgs}` : ''}`
}
interface RemoteShellResult {
  stdout: string
  stderr: string
  exitCode: number
}
async function hasSshPass() {
  try {
    await execFileAsync('sshpass', ['-V'])
    return true
  } catch {
    return false
  }
}
export async function getRemoteFileHost(hostIdRaw: string) {
  const hostId = hostIdRaw.trim()
  if (!hostId) throw new Error('Missing host id')
  const host = await getHostById(hostId)
  if (!host) throw new Error(`Host "${hostId}" not found`)
  return host
}
async function buildSshExecArgs(
  host: HostRecord,
  remoteCommand: string,
  credentials: Awaited<ReturnType<typeof getHostCredentials>>,
) {
  return [
    ...(await buildSshConfigArgs(host)),
    ...buildSshPortArgs(host),
    '-o',
    'ConnectTimeout=8',
    '-o',
    `BatchMode=${resolveHostPassword(credentials) ? 'no' : 'yes'}`,
    ...buildSshMultiplexArgs(host),
    ...buildHostSshOptions(host, credentials),
    '-T',
    getSshTarget(host),
    '--',
    remoteCommand,
  ]
}
async function dispatchRemoteShell(
  hostId: string,
  host: HostRecord | null,
  command: string,
  timeoutMs: number,
): Promise<RemoteShellResult> {
  if (host) {
    const credentials = await getHostCredentials(host.id)
    const password = resolveHostPassword(credentials)
    await ensureSshMultiplexDir()
    const sshArgs = await buildSshExecArgs(host, command, credentials)
    try {
      const result = password
        ? await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], {
            timeout: timeoutMs,
            env: { ...process.env, SSHPASS: password },
            maxBuffer: 32 * 1024 * 1024,
          })
        : await execFileAsync('ssh', sshArgs, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
      return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 }
    } catch (err: any) {
      return {
        stdout: String(err?.stdout || ''),
        stderr: `${err?.stderr || ''}\n${err?.message || ''}`,
        exitCode: typeof err?.code === 'number' ? err.code : 1,
      }
    }
  }
  try {
    // agent 端 handleShell 已固定 sh -lc 执行，这里直接传裸命令
    const result = await agentManager.executeShell(hostId, command, timeoutMs)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  } catch (err: any) {
    return { stdout: '', stderr: String(err?.message || 'Agent shell failed'), exitCode: 1 }
  }
}
// 供 attach 版本探测等非文件场景复用的远端 sh -c 通道（含 sshpass/multiplex 处理）
export async function execRemoteHostShell(host: HostRecord, command: string, timeoutMs = 10000) {
  return dispatchRemoteShell(host.id, host, command, timeoutMs)
}
export async function runRemoteFilePython<T>(hostId: string, script: string, args: string[]): Promise<T> {
  const agent = agentManager.getAgent(hostId)
  const online = agent?.online === true
  // agent 在线优先走 WS 通道（与 tmux/git/终端的 agent-first 语义一致）；
  // agent 离线但主机有 SSH 记录时回落 SSH
  const host = online ? null : await getRemoteFileHost(hostId)
  const run = (command: string) => dispatchRemoteShell(hostId, host, command, 120000)
  let result = await run(buildRpcWarmCommand(script, args))
  if (result.exitCode === RPC_COLD_EXIT || result.stderr.includes(RPC_COLD_MARKER)) {
    result = await run(buildRpcColdCommand(script, args))
  }
  if (result.exitCode !== 0) {
    const message = normalizeRemoteFileErrorMessage(`${result.stderr}\n${result.stdout}`, 'Remote file command failed')
    if (host) recordHostConnectionFailure(host.id, message)
    throw new Error(message)
  }
  return JSON.parse(result.stdout) as T
}
export async function spawnRemoteFileCommand(host: HostRecord, remoteCommand: string, signal?: AbortSignal) {
  const credentials = await getHostCredentials(host.id)
  const password = resolveHostPassword(credentials)
  await ensureSshMultiplexDir()
  const sshArgs = [
    ...(await buildSshConfigArgs(host)),
    ...buildSshPortArgs(host),
    '-o',
    'ConnectTimeout=8',
    '-o',
    `BatchMode=${password ? 'no' : 'yes'}`,
    ...buildSshMultiplexArgs(host),
    ...buildHostSshOptions(host, credentials),
    '-T',
    getSshTarget(host),
    '--',
    remoteCommand,
  ]
  let child
  if (password) {
    if (!(await hasSshPass())) throw new Error('SSH password configured but sshpass is not installed')
    child = spawn('sshpass', ['-e', 'ssh', ...sshArgs], {
      env: { ...process.env, SSHPASS: password },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } else {
    child = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  }
  if (!signal) return child
  const abort = () => child.kill('SIGTERM')
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  child.once('close', () => signal.removeEventListener('abort', abort))
  return child
}
export function quoteRemoteFileShellValue(value: string) {
  return escapeShellSingleQuoted(value)
}
