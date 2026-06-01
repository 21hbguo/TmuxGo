import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

export interface HostRecord {
  id: string
  name: string
  address: string
  user: string
  port: number
  auth: 'auto'
  password: string
  passwordEnv: string
  createdAt: string
  updatedAt: string
}
interface HostStoreFile {
  version: 1
  hosts: HostRecord[]
}
export interface HostInput {
  id: string
  name?: string
  address: string
  user: string
  port?: number
  auth?: 'auto'
  password?: string
  passwordEnv?: string
}
const localHost: HostRecord = {
  id: 'local',
  name: 'local-machine',
  address: '127.0.0.1',
  user: '',
  port: 22,
  auth: 'auto',
  password: '',
  passwordEnv: '',
  createdAt: '',
  updatedAt: '',
}
function getConfigDir() {
  const baseDir = process.env.TMUXGO_CONFIG_DIR?.trim()
  if (baseDir) return baseDir
  return path.join(os.homedir(), '.tmuxgo')
}
function getHostsPath() {
  return path.join(getConfigDir(), 'hosts.json')
}
function isValidHostId(value: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value)
}
function sanitizeHostId(value: string) {
  const hostId = value.trim()
  if (!isValidHostId(hostId) || hostId === 'local') throw new Error('Invalid host id')
  return hostId
}
function sanitizeHostName(value: string | undefined, hostId: string) {
  const hostName = (value || hostId).trim()
  if (!hostName) throw new Error('Invalid host name')
  return hostName
}
function sanitizeHostAddress(value: string) {
  const address = value.trim()
  if (!address || address.length > 255) throw new Error('Invalid host address')
  return address
}
function sanitizeHostUser(value: string) {
  const user = value.trim()
  if (!user || user.length > 64) throw new Error('Invalid host user')
  return user
}
function sanitizeHostPort(value: number | undefined) {
  const port = typeof value === 'number' ? value : 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid host port')
  return port
}
function sanitizePasswordEnv(value: string | undefined) {
  const envName = (value || '').trim()
  if (!envName) return ''
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName)) throw new Error('Invalid password env name')
  return envName
}
function sanitizePassword(value: string | undefined) {
  if (typeof value !== 'string') return ''
  if (value.length > 1024) throw new Error('Invalid password length')
  return value
}
function normalizeHostRecord(raw: any): HostRecord {
  const id = sanitizeHostId(String(raw?.id || ''))
  return {
    id,
    name: sanitizeHostName(typeof raw?.name === 'string' ? raw.name : undefined, id),
    address: sanitizeHostAddress(String(raw?.address || '')),
    user: sanitizeHostUser(String(raw?.user || '')),
    port: sanitizeHostPort(typeof raw?.port === 'number' ? raw.port : Number(raw?.port)),
    auth: 'auto',
    password: sanitizePassword(typeof raw?.password === 'string' ? raw.password : ''),
    passwordEnv: sanitizePasswordEnv(typeof raw?.passwordEnv === 'string' ? raw.passwordEnv : ''),
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw?.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
  }
}
async function ensureConfigDir() {
  await fs.mkdir(getConfigDir(), { recursive: true })
}
async function readHostStore(): Promise<HostStoreFile> {
  const filePath = getHostsPath()
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as HostStoreFile
    const hosts = Array.isArray(parsed?.hosts) ? parsed.hosts.map((item) => normalizeHostRecord(item)) : []
    return { version: 1, hosts }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { version: 1, hosts: [] }
    throw err
  }
}
async function writeHostStore(store: HostStoreFile) {
  await ensureConfigDir()
  const filePath = getHostsPath()
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
}
export function getLocalHostRecord() {
  return localHost
}
export async function listRemoteHosts() {
  const store = await readHostStore()
  return store.hosts
}
export async function listAllHosts() {
  const remoteHosts = await listRemoteHosts()
  return [localHost, ...remoteHosts]
}
export async function getHostById(hostId: string) {
  if (hostId === 'local') return localHost
  const remoteHosts = await listRemoteHosts()
  return remoteHosts.find((item) => item.id === hostId) || null
}
export async function upsertRemoteHost(input: HostInput) {
  const hostId = sanitizeHostId(input.id)
  const now = new Date().toISOString()
  const store = await readHostStore()
  const existing = store.hosts.find((item) => item.id === hostId) || null
  const host: HostRecord = {
    id: hostId,
    name: sanitizeHostName(input.name, hostId),
    address: sanitizeHostAddress(input.address),
    user: sanitizeHostUser(input.user),
    port: sanitizeHostPort(input.port),
    auth: 'auto',
    password: input.password === undefined ? (existing?.password || '') : sanitizePassword(input.password),
    passwordEnv: input.passwordEnv === undefined ? (existing?.passwordEnv || '') : sanitizePasswordEnv(input.passwordEnv),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  const nextHosts = store.hosts.filter((item) => item.id !== hostId)
  nextHosts.push(host)
  nextHosts.sort((a, b) => a.id.localeCompare(b.id))
  await writeHostStore({ version: 1, hosts: nextHosts })
  return host
}
export async function removeRemoteHost(hostIdRaw: string) {
  const hostId = sanitizeHostId(hostIdRaw)
  const store = await readHostStore()
  const exists = store.hosts.some((item) => item.id === hostId)
  if (!exists) return false
  const nextHosts = store.hosts.filter((item) => item.id !== hostId)
  await writeHostStore({ version: 1, hosts: nextHosts })
  return true
}
