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

// 所有走 ssh 的远程操作（tmux/git/文件）复用同一 ControlMaster 套接字，避免每次请求都做完整握手
export const sshMultiplexDir = path.join(os.tmpdir(), 'tmuxgo-ssh')
export function getSshControlPath(host: HostRecord) {
  return path.join(sshMultiplexDir, `${host.user}@${host.address}:${host.port}`)
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
  } catch {}
}
