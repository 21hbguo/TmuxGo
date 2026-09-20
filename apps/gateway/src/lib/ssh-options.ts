import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { HostCredentials, HostRecord } from './hosts.js'

export function resolveHostPassword(credentials: HostCredentials) {
  if (credentials.password) return credentials.password
  if (!credentials.passwordEnv) return ''
  return process.env[credentials.passwordEnv] || ''
}
export function buildHostSshOptions(host: HostRecord, credentials: HostCredentials) {
  // sshconfig 主机：连接参数（IdentityFile/ProxyJump/IdentityAgent 等）由 ssh 原生解析 config，
  // 不再手动翻译 -i/-J/-l；仅保留主机密钥策略 overlay，保证 BatchMode 下首连可 accept-new
  if (host.source === 'sshconfig')
    return [
      '-o',
      `StrictHostKeyChecking=${host.knownHostsPolicy === 'strict' ? 'yes' : host.knownHostsPolicy === 'off' ? 'no' : 'accept-new'}`,
    ]
  const args: string[] = []
  if (credentials.privateKeyPath) args.push('-i', credentials.privateKeyPath)
  if (!host.useAgent) args.push('-o', 'IdentityAgent=none')
  if (host.jumpHost) args.push('-J', host.jumpHost)
  args.push(
    '-o',
    `StrictHostKeyChecking=${host.knownHostsPolicy === 'strict' ? 'yes' : host.knownHostsPolicy === 'off' ? 'no' : 'accept-new'}`,
  )
  return args
}
// sshconfig 主机不传 -p（Port 由 config 生效），目标只用 alias
export function buildSshPortArgs(host: HostRecord) {
  return host.source === 'sshconfig' ? [] : ['-p', String(host.port)]
}
export function getSshTarget(host: HostRecord) {
  return host.source === 'sshconfig' ? host.id : `${host.user}@${host.address}`
}

// 所有走 ssh 的远程操作（tmux/git/文件）复用同一 ControlMaster 套接字，避免每次请求都做完整握手
export const sshMultiplexDir = path.join(os.tmpdir(), 'tmuxgo-ssh')
export function getSshControlPath(host: HostRecord) {
  // alias 主机用 alias 命名（user 可能为空），并兜底清洗非法文件名字符
  const key = host.source === 'sshconfig' ? `alias-${host.id}` : `${host.user}@${host.address}:${host.port}`
  return path.join(sshMultiplexDir, key.replace(/[/\x00-\x1f]/g, '_'))
}
export function buildSshMultiplexArgs(host: HostRecord) {
  return ['-o', `ControlPath=${getSshControlPath(host)}`, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=600']
}
export async function ensureSshMultiplexDir() {
  await fs.mkdir(sshMultiplexDir, { recursive: true, mode: 0o700 })
}
export async function cleanupSshMultiplexSockets() {
  try {
    await fs.rm(sshMultiplexDir, { recursive: true, force: true })
  } catch {
    // 清理失败不阻断流程
  }
}
