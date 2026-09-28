// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveEditorDefinition } from './code-navigation'

const contentMock = vi.fn()
const searchContentMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    files: {
      content: (...args: any[]) => contentMock(...args),
      searchContent: (...args: any[]) => searchContentMock(...args),
    },
  },
}))

const ROOT = '/repo'
const makeEditor = (path: string, content: string, overrides: Record<string, unknown> = {}) => ({
  id: `local:root:${path}`,
  hostId: 'local',
  rootId: 'root',
  rootLabel: 'Repo',
  rootPath: ROOT,
  path,
  name: path.split('/').pop() || path,
  absolutePath: `${ROOT}/${path}`,
  type: 'file',
  language: 'python',
  content,
  savedContent: content,
  modifiedAt: '',
  size: content.length,
  dirty: false,
  loading: false,
  saving: false,
  binary: false,
  truncated: false,
  ...overrides,
})
const serveFiles = (files: Record<string, string>) => {
  contentMock.mockImplementation(async (_h: string, _r: string, path: string) => {
    if (!(path in files)) throw new Error('ENOENT')
    return {
      path,
      type: 'file',
      size: files[path].length,
      modifiedAt: '',
      binary: false,
      truncated: false,
      encoding: 'utf8',
      content: files[path],
    }
  })
}

describe('import hint beats open decoy tabs (loss.py vs loss_guo.py)', () => {
  afterEach(() => {
    contentMock.mockReset()
    searchContentMock.mockReset()
  })
  // 两份近乎相同的兄弟文件：同名 def 都在，只有 import 模块名能定胜负
  const DECOY = '# decoy\ndef loss_sup(a):\n    return a\n'
  const REAL = '# real\n\n\ndef loss_sup(a):\n    return a\n'
  it('from loss_guo import loss_sup resolves loss_guo.py even with loss.py open', async () => {
    const files = {
      'train_mt.py': 'from loss_guo import loss_sup\nx = loss_sup(1)\n',
      'loss.py': DECOY,
      'loss_guo.py': REAL,
    }
    serveFiles(files)
    const entry = makeEditor('train_mt.py', files['train_mt.py'])
    const decoy = makeEditor('loss.py', DECOY)
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 5 }, [entry as any, decoy as any])
    expect(result).toMatchObject({ status: 'success', target: { path: 'loss_guo.py', line: 4 } })
  })
  it('from loss import loss_sup resolves loss.py even with loss_guo.py open', async () => {
    const files = {
      'train_mms.py': 'from loss import loss_sup\nx = loss_sup(1)\n',
      'loss.py': DECOY,
      'loss_guo.py': REAL,
    }
    serveFiles(files)
    const entry = makeEditor('train_mms.py', files['train_mms.py'])
    const decoy = makeEditor('loss_guo.py', REAL)
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 5 }, [entry as any, decoy as any])
    expect(result).toMatchObject({ status: 'success', target: { path: 'loss.py', line: 2 } })
  })
  it('both siblings open: import module name, not tab order, decides', async () => {
    const files = {
      'train_mt.py': 'from loss_guo import loss_sup\nx = loss_sup(1)\n',
      'loss.py': DECOY,
      'loss_guo.py': REAL,
    }
    serveFiles(files)
    const entry = makeEditor('train_mt.py', files['train_mt.py'])
    // 错误文件在前：打开顺序不许抢跳
    const decoy = makeEditor('loss.py', DECOY, { id: 'open-decoy' })
    const real = makeEditor('loss_guo.py', REAL, { id: 'open-real' })
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 5 }, [
      entry as any,
      decoy as any,
      real as any,
    ])
    expect(result).toMatchObject({ status: 'success', target: { id: 'open-real', path: 'loss_guo.py', line: 4 } })
  })
})

// 真实仓库全量验证：ssl4mis 训练脚本的每个本地 import 跳转都必须落到正确模块文件。
// 仓库缺失时整组跳过（CI 无此路径），线上双跑保证环境里有它。
const REPO = '/home/guo/project/ssl4mis/2023TMI_Min_Max_Similarity-main'
const repoFiles = new Map<string, string>()
if (existsSync(REPO)) {
  for (const f of readdirSync(REPO).filter((f) => f.endsWith('.py')))
    repoFiles.set(f, readFileSync(join(REPO, f), 'utf8'))
  for (const f of readdirSync(join(REPO, 'model')).filter((f) => f.endsWith('.py')))
    repoFiles.set(`model/${f}`, readFileSync(join(REPO, 'model', f), 'utf8'))
}
// 光标定位：取 marker 所在行里第 occurrence 个 \bword\b
const posOf = (content: string, marker: string, word: string, occurrence = 0) => {
  const lines = content.split('\n')
  const re = new RegExp(`\\b${word}\\b`, 'g')
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(marker)) continue
    const found = [...lines[i].matchAll(re)]
    if (found[occurrence]) return { line: i + 1, column: found[occurrence].index + 1 }
  }
  throw new Error(`posOf miss: ${marker} :: ${word}`)
}
// 期望落点：目标文件里 def/class word 的行号
const defLineOf = (path: string, word: string) => {
  const lines = repoFiles.get(path)!.split('\n')
  const idx = lines.findIndex((l) => new RegExp(`^(def|class)\\s+${word}\\b`).test(l))
  if (idx < 0) throw new Error(`no def/class ${word} in ${path}`)
  return idx + 1
}
// loss_guo 场景：train_mt.py 已被改回不 import loss_guo，但 loss_guo.py 实体仍在——
// 用真实文件内容 + 追回的 import 行还原用户当时的跳转现场（loss.py 作同名干扰项）
const LOSS_GUO_SUFFIX = '\nfrom loss_guo import loss_sup\nx = loss_sup(1)\n'
const jumpCases: {
  entry: string
  marker: string
  word: string
  expect: string
  decoys?: string[]
  occurrence?: number
  append?: string
}[] = [
  {
    entry: 'train_mt.py',
    marker: 'from loss_guo import loss_sup',
    word: 'loss_sup',
    expect: 'loss_guo.py',
    decoys: ['loss.py'],
    append: LOSS_GUO_SUFFIX,
  },
  {
    entry: 'train_mt.py',
    marker: 'x = loss_sup(1)',
    word: 'loss_sup',
    expect: 'loss_guo.py',
    decoys: ['loss.py'],
    append: LOSS_GUO_SUFFIX,
  },
  { entry: 'train_mt.py', marker: 'from data import image_loader_mt', word: 'image_loader_mt', expect: 'data.py' },
  { entry: 'train_mt.py', marker: 'from metrics import dice_coef', word: 'dice_coef', expect: 'metrics.py' },
  { entry: 'train_mt.py', marker: 'from utils import get_logger', word: 'get_logger', expect: 'utils.py' },
  { entry: 'train_mt.py', marker: 'create_dir', word: 'create_dir', expect: 'utils.py' },
  {
    entry: 'train_mt.py',
    marker: 'from model.pretrained_unet import preUnet_guo',
    word: 'preUnet_guo',
    expect: 'model/pretrained_unet.py',
  },
  {
    entry: 'train_mms.py',
    marker: 'from loss import loss_sup, loss_diff',
    word: 'loss_sup',
    expect: 'loss.py',
    decoys: ['loss_guo.py'],
  },
  {
    entry: 'train_mms.py',
    marker: 'from loss import loss_sup, loss_diff',
    word: 'loss_diff',
    expect: 'loss.py',
    decoys: ['loss_guo.py'],
  },
  { entry: 'train_mms.py', marker: 'from data import image_loader', word: 'image_loader', expect: 'data.py' },
  { entry: 'train_mms.py', marker: 'from metrics import dice_coef', word: 'dice_coef', expect: 'metrics.py' },
  { entry: 'train_mms.py', marker: 'from utils import get_logger', word: 'create_dir', expect: 'utils.py' },
  { entry: 'train_mms.py', marker: 'from contrastive_loss import', word: 'ConLoss', expect: 'contrastive_loss.py' },
  {
    entry: 'train_mms.py',
    marker: 'from contrastive_loss import',
    word: 'contrastive_loss_sup',
    expect: 'contrastive_loss.py',
  },
  { entry: 'train_mms.py', marker: 'from model.projector import', word: 'projectors', expect: 'model/projector.py' },
  { entry: 'train_mms.py', marker: 'from model.projector import', word: 'classifier', expect: 'model/projector.py' },
  {
    entry: 'train_mms.py',
    marker: 'from model.pretrained_unet import',
    word: 'preUnet',
    expect: 'model/pretrained_unet.py',
  },
  {
    entry: 'train_mms.py',
    marker: 'self.classifier_1 = classifier()',
    word: 'classifier',
    expect: 'model/projector.py',
  },
  { entry: 'test.py', marker: 'from data import image_loader', word: 'image_loader', expect: 'data.py' },
  { entry: 'test.py', marker: 'from utils import get_logger', word: 'get_logger', expect: 'utils.py' },
  {
    entry: 'test.py',
    marker: 'from model.pretrained_unet import',
    word: 'preUnet',
    expect: 'model/pretrained_unet.py',
  },
  { entry: 'data.py', marker: 'from gridmask import GridMask', word: 'GridMask', expect: 'gridmask.py' },
  { entry: 'loss_guo.py', marker: 'from metrics import dice_coef', word: 'dice_coef', expect: 'metrics.py' },
  { entry: 'loss.py', marker: 'from metrics import dice_coef', word: 'dice_coef', expect: 'metrics.py' },
]

describe.skipIf(repoFiles.size === 0)('real repo: every local import jumps to the right file', () => {
  const files = Object.fromEntries(repoFiles)
  beforeEach(() => {
    // 迷你 rg：按 basePath/ext 过滤，逐行包含 word 即记一条 match —— 走真候选排序路径
    searchContentMock.mockImplementation(
      async (_h: string, _r: string, word: string, basePath: string, _mc: boolean, _s: any, ext?: string) =>
        Object.entries(files)
          .filter(([p]) => (!basePath || p.startsWith(`${basePath}/`)) && (!ext || p.endsWith(ext)))
          .map(([p, c]) => ({
            path: p,
            name: p.split('/').pop(),
            type: 'file',
            size: c.length,
            modifiedAt: '',
            matches: c
              .split('\n')
              .map((text, i) => ({ number: i + 1, content: text }))
              .filter((m) => m.content.includes(word)),
          }))
          .filter((f) => f.matches.length),
    )
    serveFiles(files)
  })
  afterEach(() => {
    contentMock.mockReset()
    searchContentMock.mockReset()
  })
  for (const [i, c] of jumpCases.entries()) {
    it(`${i + 1}. ${c.entry} :: ${c.word} -> ${c.expect}`, async () => {
      const entryContent = files[c.entry] + (c.append || '')
      const entry = makeEditor(c.entry, entryContent)
      const decoyEditors = (c.decoys || []).map((d) => makeEditor(d, files[d]))
      const result = await resolveEditorDefinition(
        entry as any,
        posOf(entryContent, c.marker, c.word, c.occurrence ?? 0),
        [entry as any, ...decoyEditors.map((d) => d as any)],
      )
      expect(result).toMatchObject({
        status: 'success',
        target: { path: c.expect, line: defLineOf(c.expect, c.word) },
      })
    })
  }
})
