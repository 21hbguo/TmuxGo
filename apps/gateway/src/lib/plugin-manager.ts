import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parsePluginManifest, supportsPluginPlatform, type PluginAction, type PluginEventHook, type PluginManifest } from './plugin-manifest.js'

export interface PluginSource {
  kind: 'local' | 'github'
  owner?: string
  repo?: string
  subdir?: string
  requestedRef?: string
  resolvedCommit?: string
  installedAt: string
}
interface PluginRegistryEntry {
  pluginId: string
  root: string
  enabled: boolean
  manifest: PluginManifest
  source: PluginSource
}
interface PluginRegistryStore {
  version: 1
  plugins: PluginRegistryEntry[]
}
export interface PluginInfo {
  pluginId: string
  root: string
  enabled: boolean
  manifest: PluginManifest
  source: PluginSource
  state: 'active' | 'disabled' | 'error'
  error?: string
}
export interface PluginInvocationContext {
  hostId?: string
  sessionId?: string
  sessionName?: string
  windowId?: string
  paneId?: string
  filePath?: string
  repoPath?: string
  source?: string
  [key: string]: unknown
}
export interface PluginCommandLog {
  id: string
  pluginId: string
  actionId?: string
  event?: string
  command: string[]
  status: 'running' | 'success' | 'error' | 'timeout'
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  stdout: string
  stderr: string
  error?: string
}
export interface GitHubPluginPreview {
  source: string
  resolvedCommit: string
  manifest: PluginManifest
  replacing: boolean
}

const manifestFileName = 'tmuxgo-plugin.json'
const maxCommandOutputBytes = 64 * 1024
const maxBuildOutputBytes = 128 * 1024
const maxLogs = 200
const maxConcurrentCommands = 16
const githubSegmentPattern = /^[A-Za-z0-9_.-]+$/
const pluginContextMaxBytes = 64 * 1024

function getConfigRoot() {
  return process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo')
}
function isPathInside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative)
}
function normalizeContext(value: unknown): PluginInvocationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > pluginContextMaxBytes) throw new Error('Plugin context is too large')
  return JSON.parse(text)
}
function appendCapped(current: string, chunk: Buffer, cap: number) {
  if (Buffer.byteLength(current) >= cap) return current
  return current + chunk.subarray(0, Math.max(0, cap - Buffer.byteLength(current))).toString('utf8')
}
function parseGitHubSource(value: string) {
  const parts = value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('/').filter(Boolean)
  if (parts.length < 2 || !githubSegmentPattern.test(parts[0]) || !githubSegmentPattern.test(parts[1])) throw new Error('GitHub source must be owner/repo[/subdir]')
  const subdirParts = parts.slice(2)
  if (subdirParts.some((part) => !githubSegmentPattern.test(part) || part === '.' || part === '..')) throw new Error('Invalid GitHub plugin subdirectory')
  return { owner: parts[0], repo: parts[1], subdir: subdirParts.join('/') || undefined }
}

export class PluginManager {
  private configRoot = getConfigRoot()
  private pluginDir = path.join(this.configRoot, 'plugins')
  private dataDir = path.join(this.configRoot, 'plugin-data')
  private registryPath = path.join(this.configRoot, 'plugins.json')
  private registry = new Map<string, PluginRegistryEntry>()
  private logs: PluginCommandLog[] = []
  private running = new Map<string, ReturnType<typeof spawn>>()
  private ready: Promise<void> | null = null
  private commandsInFlight = 0

  private ensureReady() {
    if (!this.ready) this.ready = this.initialize()
    return this.ready
  }
  private async initialize() {
    await mkdir(this.pluginDir, { recursive: true })
    await mkdir(this.dataDir, { recursive: true })
    let store: PluginRegistryStore = { version: 1, plugins: [] }
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8'))
      if (parsed?.version === 1 && Array.isArray(parsed.plugins)) store = parsed
    } catch {}
    for (const entry of store.plugins) {
      if (!entry || typeof entry.pluginId !== 'string' || typeof entry.root !== 'string' || !entry.manifest || !entry.source) continue
      this.registry.set(entry.pluginId, { ...entry, enabled: entry.enabled !== false })
    }
    let names: string[] = []
    try {
      names = await readdir(this.pluginDir)
    } catch {}
    for (const name of names) {
      if (name.startsWith('.')) continue
      const root = path.join(this.pluginDir, name)
      try {
        const manifest = await this.readManifest(root)
        if (this.registry.has(manifest.id)) continue
        this.registry.set(manifest.id, { pluginId: manifest.id, root, enabled: true, manifest, source: { kind: 'local', installedAt: new Date().toISOString() } })
      } catch {}
    }
    await this.saveRegistry()
  }
  private async saveRegistry() {
    await mkdir(path.dirname(this.registryPath), { recursive: true })
    const temp = `${this.registryPath}.tmp-${process.pid}-${Date.now()}`
    const store: PluginRegistryStore = { version: 1, plugins: Array.from(this.registry.values()).sort((left, right) => left.pluginId.localeCompare(right.pluginId)) }
    await writeFile(temp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.registryPath)
  }
  private async readManifest(root: string) {
    const raw = JSON.parse(await readFile(path.join(root, manifestFileName), 'utf8'))
    return parsePluginManifest(raw)
  }
  private async loadInfo(entry: PluginRegistryEntry): Promise<PluginInfo> {
    try {
      const manifest = await this.readManifest(entry.root)
      if (manifest.id !== entry.pluginId) throw new Error('Plugin id does not match registry entry')
      entry.manifest = manifest
      return { pluginId: entry.pluginId, root: entry.root, enabled: entry.enabled, manifest, source: entry.source, state: entry.enabled ? 'active' : 'disabled' }
    } catch (error) {
      return { pluginId: entry.pluginId, root: entry.root, enabled: entry.enabled, manifest: entry.manifest, source: entry.source, state: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }
  private async requirePlugin(pluginId: string) {
    await this.ensureReady()
    const entry = this.registry.get(pluginId)
    if (!entry) throw new Error('Plugin not found')
    const info = await this.loadInfo(entry)
    if (info.state === 'error') throw new Error(info.error || 'Plugin failed to load')
    return { entry, info }
  }
  async listPlugins() {
    await this.ensureReady()
    return Promise.all(Array.from(this.registry.values()).map((entry) => this.loadInfo(entry))).then((items) => items.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)))
  }
  async link(rootValue: string) {
    await this.ensureReady()
    const root = await realpath(rootValue)
    const manifest = await this.readManifest(root)
    if (this.registry.has(manifest.id)) throw new Error(`Plugin ${manifest.id} is already registered`)
    const entry: PluginRegistryEntry = { pluginId: manifest.id, root, enabled: true, manifest, source: { kind: 'local', installedAt: new Date().toISOString() } }
    this.registry.set(manifest.id, entry)
    await this.ensurePluginDataDirs(manifest.id)
    await this.saveRegistry()
    return this.loadInfo(entry)
  }
  async setEnabled(pluginId: string, enabled: boolean) {
    const { entry } = await this.requirePlugin(pluginId)
    entry.enabled = enabled
    if (!enabled) await this.stopPlugin(pluginId)
    await this.saveRegistry()
    return this.loadInfo(entry)
  }
  async uninstall(pluginId: string, keepData = false) {
    const { entry } = await this.requirePlugin(pluginId)
    await this.stopPlugin(pluginId)
    if (entry.source.kind === 'github') {
      const expected = path.resolve(this.pluginDir, pluginId)
      if (path.resolve(entry.root) === expected || isPathInside(expected, path.resolve(entry.root))) await rm(expected, { recursive: true, force: true })
    }
    if (!keepData) await rm(path.join(this.dataDir, pluginId), { recursive: true, force: true })
    this.registry.delete(pluginId)
    await this.saveRegistry()
    return { ok: true }
  }
  async listLogs(pluginId?: string) {
    await this.ensureReady()
    return this.logs.filter((log) => !pluginId || log.pluginId === pluginId).slice().reverse()
  }
  private pushLog(log: PluginCommandLog) {
    this.logs.push(log)
    if (this.logs.length > maxLogs) this.logs.splice(0, this.logs.length - maxLogs)
  }
  private async ensurePluginDataDirs(pluginId: string) {
    const root = path.join(this.dataDir, pluginId)
    await Promise.all([mkdir(path.join(root, 'config'), { recursive: true }), mkdir(path.join(root, 'state'), { recursive: true })])
    return root
  }
  private async runCommand(info: PluginInfo, command: string[], options: { actionId?: string; event?: string; timeoutMs?: number; context?: unknown }) {
    if (this.commandsInFlight >= maxConcurrentCommands) throw new Error(`Maximum concurrent plugin commands reached (${maxConcurrentCommands})`)
    const context = normalizeContext(options.context)
    const dataRoot = await this.ensurePluginDataDirs(info.pluginId)
    const id = randomUUID()
    const log: PluginCommandLog = { id, pluginId: info.pluginId, actionId: options.actionId, event: options.event, command, status: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '' }
    this.pushLog(log)
    this.commandsInFlight++
    return new Promise<PluginCommandLog>((resolve) => {
      const child = spawn(command[0], command.slice(1), {
        cwd: info.root,
        env: {
          ...process.env,
          TMUXGO_ENV: '1',
          TMUXGO_PLUGIN_ID: info.pluginId,
          TMUXGO_PLUGIN_ROOT: info.root,
          TMUXGO_PLUGIN_DATA_DIR: dataRoot,
          TMUXGO_PLUGIN_CONFIG_DIR: path.join(dataRoot, 'config'),
          TMUXGO_PLUGIN_STATE_DIR: path.join(dataRoot, 'state'),
          TMUXGO_PLUGIN_ACTION_ID: options.actionId || '',
          TMUXGO_PLUGIN_EVENT: options.event || '',
          TMUXGO_CONTEXT_JSON: JSON.stringify(context),
          TMUXGO_API_URL: `http://127.0.0.1:${process.env.PORT || '3001'}/api`,
          TMUXGO_HOST_ID: typeof context.hostId === 'string' ? context.hostId : '',
          TMUXGO_SESSION_ID: typeof context.sessionId === 'string' ? context.sessionId : '',
          TMUXGO_PANE_ID: typeof context.paneId === 'string' ? context.paneId : '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.running.set(id, child)
      let settled = false
      let timedOut = false
      const timeoutMs = options.timeoutMs || 60000
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 1000).unref()
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => { log.stdout = appendCapped(log.stdout, chunk, maxCommandOutputBytes) })
      child.stderr?.on('data', (chunk: Buffer) => { log.stderr = appendCapped(log.stderr, chunk, maxCommandOutputBytes) })
      const finish = (status: PluginCommandLog['status'], exitCode: number | null, error?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.running.delete(id)
        this.commandsInFlight--
        log.status = status
        log.exitCode = exitCode
        log.finishedAt = new Date().toISOString()
        if (error) log.error = error
        resolve({ ...log })
      }
      child.on('error', (error) => finish('error', null, error.message))
      child.on('close', (code) => finish(timedOut ? 'timeout' : code === 0 ? 'success' : 'error', code, timedOut ? `Command timed out after ${timeoutMs}ms` : code === 0 ? undefined : `Command exited with code ${code ?? -1}`))
    })
  }
  async invokeAction(pluginId: string, actionId: string, context?: unknown) {
    const { info } = await this.requirePlugin(pluginId)
    if (!info.enabled) throw new Error('Plugin is disabled')
    const action = info.manifest.contributes?.actions?.find((item) => item.id === actionId)
    if (!action) throw new Error('Plugin action not found')
    if (!supportsPluginPlatform(action.platforms, info.manifest.platforms)) throw new Error('Plugin action is not supported on this platform')
    return this.runCommand(info, action.command, { actionId, timeoutMs: action.timeoutMs, context })
  }
  async emit(event: string, context?: unknown) {
    const plugins = await this.listPlugins()
    for (const info of plugins) {
      if (!info.enabled || info.state !== 'active') continue
      for (const hook of info.manifest.contributes?.events || []) {
        if (hook.on !== event || !supportsPluginPlatform(hook.platforms, info.manifest.platforms)) continue
        void this.runCommand(info, hook.command, { event, timeoutMs: hook.timeoutMs, context }).catch(() => {})
      }
    }
  }
  async getStorage(pluginId: string, key: string) {
    await this.requirePlugin(pluginId)
    this.assertStorageKey(key)
    try {
      return JSON.parse(await readFile(path.join(this.dataDir, pluginId, 'state', `${key}.json`), 'utf8'))
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }
  async setStorage(pluginId: string, key: string, value: unknown) {
    await this.requirePlugin(pluginId)
    this.assertStorageKey(key)
    const root = await this.ensurePluginDataDirs(pluginId)
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Plugin storage value is too large')
    const target = path.join(root, 'state', `${key}.json`)
    const temp = `${target}.tmp-${Date.now()}`
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, target)
    return { ok: true }
  }
  async deleteStorage(pluginId: string, key: string) {
    await this.requirePlugin(pluginId)
    this.assertStorageKey(key)
    await rm(path.join(this.dataDir, pluginId, 'state', `${key}.json`), { force: true })
    return { ok: true }
  }
  async listStorage(pluginId: string) {
    await this.requirePlugin(pluginId)
    const root = path.join(await this.ensurePluginDataDirs(pluginId), 'state')
    return (await readdir(root)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort()
  }
  private assertStorageKey(key: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new Error('Invalid plugin storage key')
  }
  async resolveAsset(pluginId: string, assetPath: string) {
    const { info } = await this.requirePlugin(pluginId)
    if (!info.enabled) throw new Error('Plugin is disabled')
    if (!assetPath || assetPath.includes('\0')) throw new Error('Invalid plugin asset path')
    const root = await realpath(info.root)
    const target = await realpath(path.resolve(root, assetPath))
    if (!isPathInside(root, target)) throw new Error('Plugin asset path escapes plugin root')
    const fileStat = await stat(target)
    if (!fileStat.isFile()) throw new Error('Plugin asset is not a file')
    if (fileStat.size > 20 * 1024 * 1024) throw new Error('Plugin asset is too large')
    return { path: target, size: fileStat.size }
  }
  async previewGit(sourceValue: string, requestedRef?: string): Promise<GitHubPluginPreview> {
    await this.ensureReady()
    const source = parseGitHubSource(sourceValue)
    const temp = await mkdtemp(path.join(this.pluginDir, '.tmp-preview-'))
    try {
      const checkout = path.join(temp, 'checkout')
      const resolvedCommit = await this.checkoutGit(source, requestedRef, checkout)
      const root = await this.resolveCheckoutRoot(checkout, source.subdir)
      const manifest = await this.readManifest(root)
      return { source: `${source.owner}/${source.repo}${source.subdir ? `/${source.subdir}` : ''}`, resolvedCommit, manifest, replacing: this.registry.has(manifest.id) }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
  async installGit(sourceValue: string, resolvedCommit: string, requestedRef?: string) {
    await this.ensureReady()
    if (!/^[0-9a-f]{40}$/i.test(resolvedCommit)) throw new Error('Invalid resolved commit')
    const source = parseGitHubSource(sourceValue)
    const temp = await mkdtemp(path.join(this.pluginDir, '.tmp-install-'))
    let finalRoot = ''
    let backupRoot = ''
    try {
      const checkout = path.join(temp, 'checkout')
      const checkedOutCommit = await this.checkoutGit(source, resolvedCommit, checkout)
      if (checkedOutCommit.toLowerCase() !== resolvedCommit.toLowerCase()) throw new Error('GitHub plugin commit changed during installation')
      const pluginRoot = await this.resolveCheckoutRoot(checkout, source.subdir)
      const before = await this.readManifest(pluginRoot)
      const existing = this.registry.get(before.id)
      if (existing?.source.kind === 'local') throw new Error(`Plugin ${before.id} is linked from a local directory`)
      for (const build of before.build || []) {
        if (!supportsPluginPlatform(build.platforms, before.platforms)) continue
        const result = await this.runExternalCommand(build.command, pluginRoot, 300000, maxBuildOutputBytes)
        if (result.code !== 0) throw new Error(`Plugin build failed: ${result.stderr || result.stdout || `exit ${result.code}`}`)
      }
      const after = await this.readManifest(pluginRoot)
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Plugin build changed tmuxgo-plugin.json')
      finalRoot = path.join(this.pluginDir, before.id)
      backupRoot = `${finalRoot}.backup-${Date.now()}`
      try {
        await rename(finalRoot, backupRoot)
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
        backupRoot = ''
      }
      await rename(checkout, finalRoot)
      const root = source.subdir ? path.join(finalRoot, source.subdir) : finalRoot
      const entry: PluginRegistryEntry = {
        pluginId: before.id,
        root,
        enabled: existing?.enabled !== false,
        manifest: after,
        source: { kind: 'github', owner: source.owner, repo: source.repo, subdir: source.subdir, requestedRef, resolvedCommit, installedAt: new Date().toISOString() },
      }
      this.registry.set(before.id, entry)
      await this.ensurePluginDataDirs(before.id)
      await this.saveRegistry()
      if (backupRoot) await rm(backupRoot, { recursive: true, force: true })
      return this.loadInfo(entry)
    } catch (error) {
      if (finalRoot && backupRoot) {
        await rm(finalRoot, { recursive: true, force: true }).catch(() => {})
        await rename(backupRoot, finalRoot).catch(() => {})
      }
      throw error
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
  private async resolveCheckoutRoot(checkout: string, subdir?: string) {
    const root = await realpath(subdir ? path.join(checkout, subdir) : checkout)
    const checkoutRoot = await realpath(checkout)
    if (!isPathInside(checkoutRoot, root)) throw new Error('Plugin subdirectory escapes checkout')
    return root
  }
  private async checkoutGit(source: { owner: string; repo: string; subdir?: string }, ref: string | undefined, checkout: string) {
    await mkdir(checkout, { recursive: true })
    await this.requireExternalSuccess(['git', 'init', '--quiet'], checkout, 30000)
    await this.requireExternalSuccess(['git', 'remote', 'add', 'origin', `https://github.com/${source.owner}/${source.repo}.git`], checkout, 30000)
    await this.requireExternalSuccess(['git', 'fetch', '--quiet', '--depth', '1', 'origin', ref || 'HEAD'], checkout, 120000)
    await this.requireExternalSuccess(['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkout, 30000)
    const result = await this.runExternalCommand(['git', 'rev-parse', 'HEAD'], checkout, 30000, 4096)
    if (result.code !== 0) throw new Error(result.stderr || 'Failed to resolve Git commit')
    return result.stdout.trim()
  }
  private async requireExternalSuccess(command: string[], cwd: string, timeoutMs: number) {
    const result = await this.runExternalCommand(command, cwd, timeoutMs, maxBuildOutputBytes)
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `${command[0]} exited with code ${result.code}`)
  }
  private runExternalCommand(command: string[], cwd: string, timeoutMs: number, outputCap: number) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 1000).unref()
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => { stdout = appendCapped(stdout, chunk, outputCap) })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = appendCapped(stderr, chunk, outputCap) })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  }
  private async stopPlugin(pluginId: string) {
    for (const [id, child] of this.running) {
      const log = this.logs.find((item) => item.id === id)
      if (log?.pluginId !== pluginId) continue
      child.kill('SIGTERM')
    }
  }
  async shutdown() {
    for (const child of this.running.values()) child.kill('SIGTERM')
  }
}

export const pluginManager = new PluginManager()
export function emitPluginEvent(event: string, context?: unknown) {
  void pluginManager.emit(event, context).catch(() => {})
}
