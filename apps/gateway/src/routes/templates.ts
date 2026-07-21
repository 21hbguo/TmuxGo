import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import type { SessionTemplateLayout } from '../lib/template-utils.js'

interface SessionTemplate {
  id: string
  name: string
  description: string
  layout: SessionTemplateLayout
  createdAt: string
  updatedAt: string
}
function getTemplatesPath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'session-templates.json')
}
function safeString(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function normalizeTemplates(input: unknown) {
  if (!Array.isArray(input)) return []
  const templates: SessionTemplate[] = []
  for (const item of input.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = safeString(raw.id, 64)
    const name = safeString(raw.name, 128)
    const layoutRaw = raw.layout as Record<string, unknown> | undefined
    if (!id || !name || !Array.isArray(layoutRaw?.windows)) continue
    const windows = layoutRaw.windows.slice(0, 8).map((window, index) => {
      const source = window && typeof window === 'object' ? window as Record<string, unknown> : {}
      const panesRaw = Array.isArray(source.panes) ? source.panes : []
      const panes = panesRaw.slice(0, 8).map((pane) => {
        const value = pane && typeof pane === 'object' ? pane as Record<string, unknown> : {}
        const envRaw = value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env as Record<string, unknown> : {}
        const env: Record<string, string> = {}
        for (const [key, envValue] of Object.entries(envRaw).slice(0, 20)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof envValue === 'string') env[key] = envValue.slice(0, 1024)
        return { command: safeString(value.command, 4096) || undefined, cwd: safeString(value.cwd, 1024) || undefined, env: Object.keys(env).length ? env : undefined }
      })
      return { name: safeString(source.name, 64) || `win-${index + 1}`, panes: panes.length ? panes : [{}], splitDirection: source.splitDirection === 'vertical' ? 'vertical' as const : 'horizontal' as const, layoutPreset: ['tiled', 'even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical'].includes(String(source.layoutPreset)) ? source.layoutPreset as 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical' : 'tiled' as const }
    })
    if (!windows.length) continue
    const now = new Date().toISOString()
    templates.push({ id, name, description: safeString(raw.description, 512), layout: { windows }, createdAt: safeString(raw.createdAt, 64) || now, updatedAt: safeString(raw.updatedAt, 64) || now })
  }
  return templates
}
async function readTemplates() {
  try {
    const parsed = JSON.parse(await readFile(getTemplatesPath(), 'utf8'))
    return normalizeTemplates(parsed?.templates)
  } catch {
    return []
  }
}
async function writeTemplates(templates: SessionTemplate[]) {
  const file = getTemplatesPath()
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${Date.now()}`
  await writeFile(temp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), templates }), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}
export async function templateRoutes(fastify: FastifyInstance) {
  fastify.get('/session-templates', async () => ({ templates: await readTemplates() }))
  fastify.put('/session-templates', async (request) => {
    const body = request.body as { templates?: unknown }
    const templates = normalizeTemplates(body?.templates)
    await writeTemplates(templates)
    return { templates }
  })
}
