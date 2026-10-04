import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import os from 'os'
import path from 'path'
import { JsonStore } from '../lib/json-store.js'
import {
  workspaceCreateBodySchema,
  workspaceParamsSchema,
  workspaceUpdateBodySchema,
} from '../lib/request-validation.js'

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
    workspaces.push({
      id,
      name,
      hostId,
      path: workspacePath,
      rootId: safeString(raw.rootId, 120),
      rootPath: safeString(raw.rootPath, 4096),
      rootLabel: safeString(raw.rootLabel, 120),
      relativePath: safeString(raw.relativePath, 4096),
      templateId: typeof raw.templateId === 'string' && raw.templateId ? safeString(raw.templateId, 128) : null,
      createdAt: safeString(raw.createdAt, 64) || now,
      updatedAt: safeString(raw.updatedAt, 64) || now,
    })
  }
  return workspaces
}
const workspaceStore = new JsonStore<WorkspaceEntry>(getWorkspacesPath, {
  key: 'workspaces',
  normalize: normalizeWorkspaces,
})
export async function workspaceRoutes(fastify: FastifyInstance) {
  fastify.get('/workspaces', async (request) => {
    const hostId =
      typeof request.query === 'object' && request.query && 'hostId' in request.query
        ? String((request.query as Record<string, unknown>).hostId)
        : ''
    const workspaces = await workspaceStore.read()
    return { workspaces: hostId ? workspaces.filter((item) => item.hostId === hostId) : workspaces }
  })
  fastify.post('/workspaces', async (request) => {
    const body = workspaceCreateBodySchema.parse(request.body)
    const now = new Date().toISOString()
    const entry: WorkspaceEntry = {
      id: randomUUID(),
      name: body.name,
      hostId: body.hostId,
      path: body.path,
      rootId: body.rootId || body.path,
      rootPath: body.rootPath || body.path,
      rootLabel: body.rootLabel || body.name,
      relativePath: body.relativePath || '',
      templateId: body.templateId || null,
      createdAt: now,
      updatedAt: now,
    }
    await workspaceStore.update((list) => ({ items: [...list, entry], result: entry }))
    return { workspace: entry }
  })
  fastify.patch('/workspaces/:id', async (request) => {
    const { id } = workspaceParamsSchema.parse(request.params)
    const body = workspaceUpdateBodySchema.parse(request.body)
    const now = new Date().toISOString()
    const updated = await workspaceStore.update((list) => {
      const target = list.find((item) => item.id === id)
      if (!target) throw new Error('Workspace not found')
      const next: WorkspaceEntry = {
        ...target,
        name: body.name ?? target.name,
        hostId: body.hostId ?? target.hostId,
        path: body.path ?? target.path,
        rootId: body.rootId ?? target.rootId,
        rootPath: body.rootPath ?? target.rootPath,
        rootLabel: body.rootLabel ?? target.rootLabel,
        relativePath: body.relativePath ?? target.relativePath,
        templateId: body.templateId !== undefined ? body.templateId : target.templateId,
        updatedAt: now,
      }
      return { items: list.map((item) => (item.id === id ? next : item)), result: next }
    })
    return { workspace: updated }
  })
  fastify.delete('/workspaces/:id', async (request) => {
    const { id } = workspaceParamsSchema.parse(request.params)
    const removed = await workspaceStore.update((list) => {
      const next = list.filter((item) => item.id !== id)
      return { items: next, result: next.length !== list.length }
    })
    return { success: removed }
  })
}
