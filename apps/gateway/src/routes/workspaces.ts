import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { workspaceCreateBodySchema, workspaceParamsSchema, workspaceUpdateBodySchema } from '../lib/request-validation.js'

export interface WorkspaceEntry {
  id: string
  name: string
  hostId: string
  path: string
  rootId: string
  rootPath: string
  rootLabel: string
  relativePath: string
  templateId: string | null
  createdAt: string
  updatedAt: string
}
function getWorkspacesPath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'workspaces.json')
}
function safeString(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function normalizeWorkspaces(input: unknown) {
  if (!Array.isArray(input)) return []
  const workspaces: WorkspaceEntry[] = []
  for (const item of input.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = safeString(raw.id, 64)
    const name = safeString(raw.name, 64)
    const hostId = safeString(raw.hostId, 120)
    const workspacePath = safeString(raw.path, 4096)
    if (!id || !name || !hostId || !workspacePath.startsWith('/')) continue
    const now = new Date().toISOString()
    workspaces.push({ id, name, hostId, path: workspacePath, rootId: safeString(raw.rootId, 120), rootPath: safeString(raw.rootPath, 4096), rootLabel: safeString(raw.rootLabel, 120), relativePath: safeString(raw.relativePath, 4096), templateId: typeof raw.templateId === 'string' && raw.templateId ? safeString(raw.templateId, 128) : null, createdAt: safeString(raw.createdAt, 64) || now, updatedAt: safeString(raw.updatedAt, 64) || now })
  }
  return workspaces
}
async function readWorkspaces() {
  try {
    const parsed = JSON.parse(await readFile(getWorkspacesPath(), 'utf8'))
    return normalizeWorkspaces(parsed?.workspaces)
  } catch {
    return []
  }
}
async function writeWorkspaces(workspaces: WorkspaceEntry[]) {
  const file = getWorkspacesPath()
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${Date.now()}`
  await writeFile(temp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), workspaces }), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}
export async function workspaceRoutes(fastify: FastifyInstance) {
  fastify.get('/workspaces', async (request) => {
    const hostId = typeof request.query === 'object' && request.query && 'hostId' in request.query ? String((request.query as Record<string, unknown>).hostId) : ''
    const workspaces = await readWorkspaces()
    return { workspaces: hostId ? workspaces.filter((item) => item.hostId === hostId) : workspaces }
  })
  fastify.post('/workspaces', async (request) => {
    const body = workspaceCreateBodySchema.parse(request.body)
    const now = new Date().toISOString()
    const entry: WorkspaceEntry = { id: randomUUID(), name: body.name, hostId: body.hostId, path: body.path, rootId: body.rootId || body.path, rootPath: body.rootPath || body.path, rootLabel: body.rootLabel || body.name, relativePath: body.relativePath || '', templateId: body.templateId || null, createdAt: now, updatedAt: now }
    const workspaces = await readWorkspaces()
    await writeWorkspaces([...workspaces, entry])
    return { workspace: entry }
  })
  fastify.patch('/workspaces/:id', async (request) => {
    const { id } = workspaceParamsSchema.parse(request.params)
    const body = workspaceUpdateBodySchema.parse(request.body)
    const workspaces = await readWorkspaces()
    const target = workspaces.find((item) => item.id === id)
    if (!target) throw new Error('Workspace not found')
    const now = new Date().toISOString()
    const updated: WorkspaceEntry = { ...target, name: body.name ?? target.name, hostId: body.hostId ?? target.hostId, path: body.path ?? target.path, rootId: body.rootId ?? target.rootId, rootPath: body.rootPath ?? target.rootPath, rootLabel: body.rootLabel ?? target.rootLabel, relativePath: body.relativePath ?? target.relativePath, templateId: body.templateId !== undefined ? body.templateId : target.templateId, updatedAt: now }
    await writeWorkspaces(workspaces.map((item) => item.id === id ? updated : item))
    return { workspace: updated }
  })
  fastify.delete('/workspaces/:id', async (request) => {
    const { id } = workspaceParamsSchema.parse(request.params)
    const workspaces = await readWorkspaces()
    const next = workspaces.filter((item) => item.id !== id)
    if (next.length === workspaces.length) return { success: false }
    await writeWorkspaces(next)
    return { success: true }
  })
}
