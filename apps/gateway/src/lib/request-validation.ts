import { z } from 'zod'

const identifier = z.string().min(1).max(120)
const filePath = z.string().max(4096)
const repositoryPath = z.string().min(1).max(4096)
const repositoryFilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'Invalid file path')

export const hostParamsSchema = z.object({ hostId: identifier })
export const hostIdParamsSchema = z.object({ id: identifier })
export const fileContentBodySchema = z.object({
  root: identifier,
  path: filePath,
  content: z.string().max(1024 * 1024),
  modifiedAt: z.string().datetime().optional(),
})
export const fileEntryBodySchema = z.object({ root: identifier, path: filePath, name: z.string().min(1).max(255) })
export const fileTransferBodySchema = z.object({
  root: identifier,
  path: filePath,
  targetRoot: identifier,
  targetPath: filePath,
})
export const fileTrashBodySchema = z.object({ root: identifier, path: filePath })
export const fileRestoreBodySchema = z.object({ trashId: identifier })
export const fileRemoveQuerySchema = z.object({ root: identifier, path: filePath })
export const paneIdBodySchema = z.object({ paneId: z.string().min(3).max(256) })
// paneId/paneIds 二选一或同给；refine 保证至少一个有效 id
export const paneMarkSeenBodySchema = z
  .object({
    paneId: z.string().min(3).max(256).optional(),
    paneIds: z.array(z.string().min(3).max(256)).max(256).optional(),
  })
  .refine((body) => !!body.paneId || !!body.paneIds?.length, { message: 'paneId is required' })
export const paneSelectBodySchema = paneIdBodySchema.extend({ keepZoom: z.boolean().optional() })
export const paneCopySelectionBodySchema = paneIdBodySchema.extend({
  since: z.string().max(128).optional(),
  peek: z.boolean().optional(),
})
export const paneSplitBodySchema = paneIdBodySchema.extend({ direction: z.enum(['horizontal', 'vertical']) })
export const paneResizeBodySchema = paneIdBodySchema.extend({
  cols: z.number().finite().optional(),
  rows: z.number().finite().optional(),
})
export const sessionCreateBodySchema = z.object({
  name: z.string().min(1).max(64),
  layout: z.any().optional(),
  cwd: z.string().max(4096).optional(),
})
export const sessionRenameBodySchema = z.object({
  sessionId: z.string().min(1).max(256),
  name: z.string().min(1).max(64),
})
// 显式 resume 必须携带与候选一致的目标 pane/agentSessionId——防止把
// session 恢复到非预期 pane，也防止仅凭列表 id 猜目标发起恢复
export const agentRecoveryResumeBodySchema = z.object({
  paneId: z.string().min(1).max(256),
  agentSessionId: z.string().min(1).max(256),
  // active=恢复到候选 session 的当前激活 pane；缺省恢复到原 pane
  targetMode: z.enum(['pane', 'active']).optional(),
})
export const sessionLayoutApplyBodySchema = z.object({
  layout: z.unknown(),
  mode: z.enum(['create', 'append']).optional(),
  name: z.string().min(1).max(64).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  replace: z.boolean().optional(),
})
export const workspaceParamsSchema = z.object({ id: identifier })
export const workspaceCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  hostId: identifier,
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/'), 'Absolute path required'),
  rootId: z.string().max(120).optional(),
  rootPath: z.string().max(4096).optional(),
  rootLabel: z.string().max(120).optional(),
  relativePath: z.string().max(4096).optional(),
  templateId: z.string().max(128).nullable().optional(),
})
export const workspaceUpdateBodySchema = workspaceCreateBodySchema.partial()
export const gitFilesBodySchema = z.object({
  path: repositoryPath,
  filePaths: z.array(repositoryFilePath).min(1).max(1000),
})
export const gitCommitBodySchema = z.object({
  path: repositoryPath,
  message: z.string().min(1).max(65536),
  amend: z.boolean().optional(),
  background: z.boolean().optional(),
})
export const gitResolveBodySchema = z.object({
  path: repositoryPath,
  filePath: repositoryFilePath,
  resolution: z.enum(['ours', 'theirs', 'mark']),
})
export const gitOperationBodySchema = z.object({
  path: repositoryPath,
  operation: z.enum(['merge', 'rebase']),
  action: z.enum(['continue', 'abort']),
  background: z.boolean().optional(),
})
export const gitWorktreeCreateBodySchema = z.object({
  path: repositoryPath,
  worktreePath: z.string().min(1).max(4096),
  newBranch: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  commit: z.string().max(128).optional(),
  sessionId: z.string().max(256).optional(),
  workspaceId: z.string().max(64).optional(),
})
export const gitWorktreeRemoveBodySchema = z.object({
  path: repositoryPath,
  worktreePath: z.string().min(1).max(4096),
  force: z.boolean().optional(),
})
export const gitWorktreeLinkBodySchema = z.object({
  path: repositoryPath,
  worktreePath: z.string().min(1).max(4096),
  sessionId: z.string().max(256).optional(),
  workspaceId: z.string().max(64).optional(),
})
export const remoteHostBodySchema = z.object({
  id: identifier,
  name: z.string().max(120).optional(),
  address: z.string().min(1).max(255),
  user: z.string().min(1).max(120),
  port: z.number().int().min(1).max(65535).optional(),
  password: z.string().max(1024).optional(),
  passwordEnv: z.string().max(120).optional(),
  privateKeyPath: z.string().max(4096).optional(),
  groups: z.array(z.string().max(64)).max(12).optional(),
  tags: z.array(z.string().max(64)).max(12).optional(),
  favorite: z.boolean().optional(),
  useAgent: z.boolean().optional(),
  jumpHost: z.string().max(255).optional(),
  knownHostsPolicy: z.enum(['strict', 'accept-new', 'off']).optional(),
})
export const pluginLinkBodySchema = z.object({ path: z.string().min(1).max(4096) })
export const pluginInstallBodySchema = z.object({
  source: z.string().min(1).max(512),
  resolvedCommit: z.string().min(1).max(128),
  ref: z.string().max(256).optional(),
})
export const streamMessageSchema = z.object({ type: z.string().min(1).max(64) }).passthrough()
export const streamAttachMessageSchema = z.object({
  type: z.literal('attach'),
  hostId: identifier.optional(),
  sessionName: z.string().min(1).max(256),
  exclusive: z.boolean().optional(),
  passive: z.boolean().optional(),
  cols: z.number().finite().optional(),
  rows: z.number().finite().optional(),
})
export const streamInputMessageSchema = z.object({ type: z.literal('input'), data: z.string().max(1024 * 1024) })
export const streamResizeMessageSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().finite(),
  rows: z.number().finite(),
  // 可选请求标识：旧端不发不受影响（字段缺失时协议同旧版）；schema 不显式
  // 声明会被 zod 默认剥离，网关 resized ACK 原样回声供前端配对/丢弃旧 ACK
  requestId: z.union([z.string().min(1).max(128), z.number().int()]).optional(),
})
export const streamRegisterMessageSchema = z.object({
  type: z.literal('register'),
  version: z.string().min(1).max(128).optional(),
  host: z.object({ id: identifier, name: z.string().min(1).max(120), address: z.string().min(1).max(255) }),
  caps: z
    .object({
      compressTerminalOutput: z.boolean().optional(),
      fileDownload: z.boolean().optional(),
    })
    .optional(),
})
