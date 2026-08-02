import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

export type KnownHostsPolicy = 'strict' | 'accept-new' | 'off'
export interface HostRecord {
  id: string
  name: string
  address: string
  user: string
  port: number
  auth: 'auto'
  useAgent: boolean
  jumpHost: string
  knownHostsPolicy: KnownHostsPolicy
  createdAt: string
  updatedAt: string
}
export interface HostCredentials {
  password: string
  passwordEnv: string
  privateKeyPath: string
}
interface HostStoreFile {
  version: 2
  hosts: HostRecord[]
}
interface CredentialStoreFile {
  version: 1
  credentials: Record<string, HostCredentials>
}
interface HostStoreData {
  store: HostStoreFile
  legacyCredentials: Record<string, HostCredentials>
  needsMigration: boolean
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
  privateKeyPath?: string
  useAgent?: boolean
  jumpHost?: string
  knownHostsPolicy?: KnownHostsPolicy
}
const emptyCredentials: HostCredentials = { password: '', passwordEnv: '', privateKeyPath: '' }
const localHost: HostRecord = {
  id: 'local',
  name: 'local-machine',
  address: '127.0.0.1',
  user: '',
  port: 22,
  auth: 'auto',
  useAgent: false,
  jumpHost: '',
  knownHostsPolicy: 'strict',
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
function getCredentialsPath() {
  return path.join(getConfigDir(), 'host-credentials.json')
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
function sanitizePrivateKeyPath(value: string | undefined) {
  const privateKeyPath = (value || '').trim()
  if (privateKeyPath.length > 4096 || /[\x00-\x1f]/.test(privateKeyPath)) throw new Error('Invalid private key path')
  return privateKeyPath
}
function sanitizeJumpHost(value: string | undefined) {
  const jumpHost = (value || '').trim()
  if (jumpHost.length > 255 || /[\s\x00-\x1f]/.test(jumpHost)) throw new Error('Invalid jump host')
  return jumpHost
}
function sanitizeKnownHostsPolicy(value: unknown): KnownHostsPolicy {
  return value === 'strict' || value === 'off' || value === 'accept-new' ? value : 'accept-new'
}
function nextUpdatedAt(previous: string | undefined) {
  const now = Date.now()
  const previousMs = Date.parse(previous || '')
  return new Date(!Number.isNaN(previousMs) && now <= previousMs ? previousMs + 1 : now).toISOString()
}
function normalizeCredentials(raw: any): HostCredentials {
  return {
    password: sanitizePassword(typeof raw?.password === 'string' ? raw.password : ''),
    passwordEnv: sanitizePasswordEnv(typeof raw?.passwordEnv === 'string' ? raw.passwordEnv : ''),
    privateKeyPath: sanitizePrivateKeyPath(typeof raw?.privateKeyPath === 'string' ? raw.privateKeyPath : ''),
  }
}
function hasCredentials(credentials: HostCredentials) {
  return !!(credentials.password || credentials.passwordEnv || credentials.privateKeyPath)
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
    useAgent: raw?.useAgent !== false,
    jumpHost: sanitizeJumpHost(typeof raw?.jumpHost === 'string' ? raw.jumpHost : ''),
    knownHostsPolicy: sanitizeKnownHostsPolicy(raw?.knownHostsPolicy),
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw?.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
  }
}
async function ensureConfigDir() {
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 })
  await fs.chmod(getConfigDir(), 0o700)
}
async function readHostStore(): Promise<HostStoreData> {
  const filePath = getHostsPath()
  try {
    await fs.chmod(filePath, 0o600)
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown; hosts?: unknown }
    const rawHosts = Array.isArray(parsed?.hosts) ? parsed.hosts : []
    const hosts = rawHosts.map((item) => normalizeHostRecord(item))
    const legacyCredentials: Record<string, HostCredentials> = {}
    for (const item of rawHosts) {
      const id = String((item as any)?.id || '')
      const credentials = normalizeCredentials(item)
      if (isValidHostId(id) && hasCredentials(credentials)) legacyCredentials[id] = credentials
    }
    const needsMigration = parsed.version !== 2 || rawHosts.some((item: any) => 'password' in (item || {}) || 'passwordEnv' in (item || {}) || 'privateKeyPath' in (item || {}))
    return { store: { version: 2, hosts }, legacyCredentials, needsMigration }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { store: { version: 2, hosts: [] }, legacyCredentials: {}, needsMigration: false }
    throw err
  }
}
async function readCredentialStore(): Promise<CredentialStoreFile> {
  const filePath = getCredentialsPath()
  try {
    await fs.chmod(filePath, 0o600)
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { credentials?: unknown }
    const credentials: Record<string, HostCredentials> = {}
    for (const [id, value] of Object.entries(parsed?.credentials || {})) {
      const normalized = normalizeCredentials(value)
      if (isValidHostId(id) && hasCredentials(normalized)) credentials[id] = normalized
    }
    return { version: 1, credentials }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { version: 1, credentials: {} }
    throw err
  }
}
async function writeJsonFile(filePath: string, value: unknown) {
  await ensureConfigDir()
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(tempPath, 0o600)
  await fs.rename(tempPath, filePath)
  await fs.chmod(filePath, 0o600)
}
async function writeHostStore(store: HostStoreFile) {
  await writeJsonFile(getHostsPath(), store)
}
async function writeCredentialStore(store: CredentialStoreFile) {
  await writeJsonFile(getCredentialsPath(), store)
}
async function readRemoteState() {
  const [hostData, credentialStore] = await Promise.all([readHostStore(), readCredentialStore()])
  let migratedCredentials = false
  for (const [id, credentials] of Object.entries(hostData.legacyCredentials)) {
    if (credentialStore.credentials[id]) continue
    credentialStore.credentials[id] = credentials
    migratedCredentials = true
  }
  if (hostData.needsMigration) await writeHostStore(hostData.store)
  if (migratedCredentials) await writeCredentialStore(credentialStore)
  return { store: hostData.store, credentials: credentialStore }
}
export function getLocalHostRecord() {
  return localHost
}
export async function listRemoteHosts() {
  const { store } = await readRemoteState()
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
export async function getHostCredentials(hostId: string) {
  if (hostId === 'local') return emptyCredentials
  const { credentials } = await readRemoteState()
  return credentials.credentials[hostId] || emptyCredentials
}
export async function upsertRemoteHost(input: HostInput) {
  const hostId = sanitizeHostId(input.id)
  const { store, credentials: credentialStore } = await readRemoteState()
  const existing = store.hosts.find((item) => item.id === hostId) || null
  const existingCredentials = credentialStore.credentials[hostId] || emptyCredentials
  const now = nextUpdatedAt(existing?.updatedAt)
  const host: HostRecord = {
    id: hostId,
    name: sanitizeHostName(input.name, hostId),
    address: sanitizeHostAddress(input.address),
    user: sanitizeHostUser(input.user),
    port: sanitizeHostPort(input.port),
    auth: 'auto',
    useAgent: input.useAgent === undefined ? (existing?.useAgent ?? true) : input.useAgent,
    jumpHost: input.jumpHost === undefined ? (existing?.jumpHost || '') : sanitizeJumpHost(input.jumpHost),
    knownHostsPolicy: input.knownHostsPolicy === undefined ? (existing?.knownHostsPolicy || 'accept-new') : sanitizeKnownHostsPolicy(input.knownHostsPolicy),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  const credentials: HostCredentials = {
    password: input.password === undefined ? existingCredentials.password : sanitizePassword(input.password),
    passwordEnv: input.passwordEnv === undefined ? existingCredentials.passwordEnv : sanitizePasswordEnv(input.passwordEnv),
    privateKeyPath: input.privateKeyPath === undefined ? existingCredentials.privateKeyPath : sanitizePrivateKeyPath(input.privateKeyPath),
  }
  const nextHosts = store.hosts.filter((item) => item.id !== hostId)
  nextHosts.push(host)
  nextHosts.sort((a, b) => a.id.localeCompare(b.id))
  if (hasCredentials(credentials)) credentialStore.credentials[hostId] = credentials
  else delete credentialStore.credentials[hostId]
  await Promise.all([writeHostStore({ version: 2, hosts: nextHosts }), writeCredentialStore(credentialStore)])
  return host
}
export async function removeRemoteHost(hostIdRaw: string) {
  const hostId = sanitizeHostId(hostIdRaw)
  const { store, credentials } = await readRemoteState()
  const exists = store.hosts.some((item) => item.id === hostId)
  if (!exists) return false
  const nextHosts = store.hosts.filter((item) => item.id !== hostId)
  delete credentials.credentials[hostId]
  await Promise.all([writeHostStore({ version: 2, hosts: nextHosts }), writeCredentialStore(credentials)])
  return true
}
