import { z } from 'zod'

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const localIdPattern = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/
const eventPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,7}$/
const pathPattern = /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/
const platformSchema = z.enum(['linux', 'macos', 'windows'])
const commandSchema = z.array(z.string().min(1).max(4096)).min(1).max(64)
const platformsSchema = z.array(platformSchema).min(1).max(3).optional()
const buildSchema = z.object({ command: commandSchema, platforms: platformsSchema }).strict()
const actionSchema = z.object({
  id: z.string().regex(localIdPattern),
  title: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
  contexts: z.array(z.enum(['global', 'host', 'session', 'pane', 'file', 'git'])).max(6).optional(),
  command: commandSchema,
  platforms: platformsSchema,
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
}).strict()
const eventSchema = z.object({ on: z.string().regex(eventPattern), command: commandSchema, platforms: platformsSchema, timeoutMs: z.number().int().min(1000).max(300000).optional() }).strict()
const viewSchema = z.object({
  id: z.string().regex(localIdPattern),
  title: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
  icon: z.string().max(64).optional(),
  entry: z.string().min(1).max(512).regex(pathPattern).regex(/\.html$/i),
  placement: z.literal('activity').default('activity'),
  width: z.number().int().min(240).max(720).optional(),
}).strict()
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(idPattern),
  name: z.string().min(1).max(128),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  minTmuxGoVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().max(512).optional(),
  icon: z.string().max(64).optional(),
  platforms: z.array(platformSchema).min(1).max(3),
  permissions: z.array(z.string().regex(idPattern)).max(32).optional(),
  build: z.array(buildSchema).max(16).optional(),
  contributes: z.object({ actions: z.array(actionSchema).max(100).optional(), events: z.array(eventSchema).max(100).optional(), views: z.array(viewSchema).max(20).optional() }).strict().optional(),
}).strict()

export type PluginPlatform = z.infer<typeof platformSchema>
export type PluginManifest = z.infer<typeof manifestSchema>
export type PluginAction = NonNullable<NonNullable<PluginManifest['contributes']>['actions']>[number]
export type PluginEventHook = NonNullable<NonNullable<PluginManifest['contributes']>['events']>[number]
export type PluginView = NonNullable<NonNullable<PluginManifest['contributes']>['views']>[number]

function versionParts(value: string) {
  return value.split('-', 1)[0].split('.').map((part) => Number(part))
}
function compareVersions(left: string, right: string) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}
function rejectDuplicateIds(items: Array<{ id: string }> | undefined, label: string) {
  const seen = new Set<string>()
  for (const item of items || []) {
    if (seen.has(item.id)) throw new Error(`Duplicate plugin ${label} id: ${item.id}`)
    seen.add(item.id)
  }
}
export function parsePluginManifest(value: unknown, currentVersion = process.env.TMUXGO_VERSION || '0.1.0') {
  const parsed = manifestSchema.safeParse(value)
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; '))
  if (compareVersions(parsed.data.minTmuxGoVersion, currentVersion) > 0) throw new Error(`Plugin requires TmuxGo ${parsed.data.minTmuxGoVersion} or newer`)
  rejectDuplicateIds(parsed.data.contributes?.actions, 'action')
  rejectDuplicateIds(parsed.data.contributes?.views, 'view')
  return parsed.data
}
export function currentPluginPlatform(): PluginPlatform {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}
export function supportsPluginPlatform(itemPlatforms: PluginPlatform[] | undefined, pluginPlatforms: PluginPlatform[]) {
  return (itemPlatforms || pluginPlatforms).includes(currentPluginPlatform())
}
