import type { FastifyInstance } from 'fastify'
import { execGit } from '../lib/git-executor.js'

interface GitFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged'
  oldPath?: string
  staged: boolean
}

function mapStatusCode(code: string): GitFileChange['status'] {
  switch (code) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'U': return 'unmerged'
    default: return 'modified'
  }
}

function parsePorcelainV2(stdout: string) {
  const lines = stdout.split('\n')
  let branch = ''
  let ahead = 0
  let behind = 0
  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  const untracked: string[] = []
  const conflicted: GitFileChange[] = []

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice(14)
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(-?\d+)\s+(-?\d+)/)
      if (match) {
        ahead = parseInt(match[1], 10)
        behind = Math.abs(parseInt(match[2], 10))
      }
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const filePath = parts.slice(8).join(' ')
      const indexStatus = xy[0]
      const worktreeStatus = xy[1]
      if (indexStatus !== '.') {
        staged.push({ path: filePath, status: mapStatusCode(indexStatus), staged: true })
      }
      if (worktreeStatus !== '.') {
        unstaged.push({ path: filePath, status: mapStatusCode(worktreeStatus), staged: false })
      }
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const subParts = parts.slice(8).join(' ').split('\t')
      const oldPath = subParts[0]
      const filePath = subParts[1] || oldPath
      const indexStatus = xy[0]
      const worktreeStatus = xy[1]
      if (indexStatus !== '.') {
        staged.push({ path: filePath, status: mapStatusCode(indexStatus), oldPath, staged: true })
      }
      if (worktreeStatus !== '.') {
        unstaged.push({ path: filePath, status: mapStatusCode(worktreeStatus), oldPath, staged: false })
      }
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      const filePath = parts.slice(8).join(' ').split('\t')[0]
      conflicted.push({ path: filePath, status: 'unmerged', staged: false })
    } else if (line.startsWith('? ')) {
      untracked.push(line.slice(2))
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked, conflicted }
}

export async function gitRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/git/detect', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath } = request.query as { path?: string }
    if (!repoPath) return { isGitRepo: false }
    try {
      const { stdout } = await execGit(hostId, ['rev-parse', '--show-toplevel'], repoPath)
      const rootPath = stdout.trim()
      const { stdout: branchOut } = await execGit(hostId, ['rev-parse', '--abbrev-ref', 'HEAD'], rootPath)
      return { isGitRepo: true, rootPath, branch: branchOut.trim() }
    } catch {
      return { isGitRepo: false }
    }
  })

  fastify.get('/hosts/:hostId/git/status', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath } = request.query as { path?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const { stdout } = await execGit(hostId, ['status', '--porcelain=v2', '--branch'], repoPath)
    return parsePorcelainV2(stdout)
  })

  fastify.get('/hosts/:hostId/git/diff', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, filePath, staged, commit } = request.query as { path?: string; filePath?: string; staged?: string; commit?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const args = ['diff', '--no-color']
    if (commit) args.push(commit)
    else if (staged === 'true') args.push('--staged')
    if (filePath) args.push('--', filePath)
    const { stdout } = await execGit(hostId, args, repoPath)
    return { raw: stdout }
  })

  fastify.post('/hosts/:hostId/git/stage', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, filePaths } = request.body as { path: string; filePaths: string[] }
    if (!repoPath || !filePaths?.length) throw new Error('Missing path or filePaths')
    await execGit(hostId, ['add', '--', ...filePaths], repoPath)
    return { ok: true }
  })

  fastify.post('/hosts/:hostId/git/unstage', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, filePaths } = request.body as { path: string; filePaths: string[] }
    if (!repoPath || !filePaths?.length) throw new Error('Missing path or filePaths')
    await execGit(hostId, ['restore', '--staged', '--', ...filePaths], repoPath)
    return { ok: true }
  })

  fastify.post('/hosts/:hostId/git/commit', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, message, amend } = request.body as { path: string; message: string; amend?: boolean }
    if (!repoPath || !message) throw new Error('Missing path or message')
    const args = ['commit', '-m', message]
    if (amend) args.splice(1, 0, '--amend')
    const { stdout } = await execGit(hostId, args, repoPath)
    const hashMatch = stdout.match(/\[(?:[^\s]+)\s+([a-f0-9]+)\]/)
    return { ok: true, hash: hashMatch?.[1] || '', message }
  })

  fastify.post('/hosts/:hostId/git/discard', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, filePaths } = request.body as { path: string; filePaths: string[] }
    if (!repoPath || !filePaths?.length) throw new Error('Missing path or filePaths')
    await execGit(hostId, ['checkout', '--', ...filePaths], repoPath)
    return { ok: true }
  })

  // Phase 2 endpoints
  fastify.get('/hosts/:hostId/git/log', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, limit, skip } = request.query as { path?: string; limit?: string; skip?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const n = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 200)
    const s = Math.max(parseInt(skip || '0', 10) || 0, 0)
    const args = ['log', `--format=%H|%h|%s|%b|%an|%ae|%ai|%P`, `-n${n}`]
    if (s > 0) args.push(`--skip=${s}`)
    const { stdout } = await execGit(hostId, args, repoPath)
    const commits = stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, subject, body, author, authorEmail, date, parents] = line.split('|')
      return { hash, shortHash, subject, body, author, authorEmail, date, parents: parents ? parents.split(' ') : [] }
    })
    const hasMore = commits.length === n
    return { commits, hasMore }
  })

  fastify.get('/hosts/:hostId/git/branches', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath } = request.query as { path?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const { stdout } = await execGit(hostId, ['branch', '-vv', '--sort=-committerdate'], repoPath)
    const branches = stdout.split('\n').filter(Boolean).map((line) => {
      const current = line.startsWith('* ')
      const clean = line.replace(/^\*?\s+/, '')
      const match = clean.match(/^(\S+)\s+([a-f0-9]+)\s+(?:\[(.+?)(?::\s*(.+))?\])?\s*(.*)$/)
      if (!match) return null
      const [, name, commitHash, remote, trackingBranch, rest] = match
      return { name, current, remote, commitHash, trackingBranch, lastCommitSubject: rest.trim() }
    }).filter(Boolean)
    const current = branches.find((b) => b?.current)?.name || ''
    return { branches, current }
  })

  fastify.post('/hosts/:hostId/git/checkout', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, branch, newBranch } = request.body as { path: string; branch?: string; newBranch?: string }
    if (!repoPath) throw new Error('Missing path')
    if (newBranch) {
      await execGit(hostId, ['checkout', '-b', newBranch, branch || ''], repoPath)
      return { ok: true, branch: newBranch }
    }
    if (!branch) throw new Error('Missing branch')
    await execGit(hostId, ['checkout', branch], repoPath)
    return { ok: true, branch }
  })

  fastify.post('/hosts/:hostId/git/create-branch', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, name, startPoint } = request.body as { path: string; name: string; startPoint?: string }
    if (!repoPath || !name) throw new Error('Missing path or name')
    const args = ['branch', name]
    if (startPoint) args.push(startPoint)
    await execGit(hostId, args, repoPath)
    return { ok: true, branch: name }
  })

  fastify.post('/hosts/:hostId/git/delete-branch', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, name, force } = request.body as { path: string; name: string; force?: boolean }
    if (!repoPath || !name) throw new Error('Missing path or name')
    await execGit(hostId, ['branch', force ? '-D' : '-d', name], repoPath)
    return { ok: true }
  })

  fastify.post('/hosts/:hostId/git/merge', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, branch, noFF } = request.body as { path: string; branch: string; noFF?: boolean }
    if (!repoPath || !branch) throw new Error('Missing path or branch')
    const args = ['merge']
    if (noFF) args.push('--no-ff')
    args.push(branch)
    try {
      const { stdout } = await execGit(hostId, args, repoPath)
      const fastForward = stdout.includes('Fast-forward')
      return { ok: true, fastForward, conflicts: false, message: stdout.trim() }
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg.includes('CONFLICT') || msg.includes('conflict')) {
        return { ok: false, fastForward: false, conflicts: true, message: msg }
      }
      throw err
    }
  })

  // Phase 3 endpoints
  fastify.post('/hosts/:hostId/git/fetch', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, remote, prune } = request.body as { path: string; remote?: string; prune?: boolean }
    if (!repoPath) throw new Error('Missing path')
    const args = ['fetch']
    if (prune) args.push('--prune')
    if (remote) args.push(remote)
    const { stdout } = await execGit(hostId, args, repoPath)
    return { ok: true, message: stdout.trim() }
  })

  fastify.post('/hosts/:hostId/git/pull', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, remote, branch, rebase } = request.body as { path: string; remote?: string; branch?: string; rebase?: boolean }
    if (!repoPath) throw new Error('Missing path')
    const args = ['pull']
    if (rebase) args.push('--rebase')
    if (remote) args.push(remote)
    if (branch) args.push(branch)
    try {
      const { stdout } = await execGit(hostId, args, repoPath, 30000)
      return { ok: true, conflicts: false, message: stdout.trim() }
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg.includes('CONFLICT') || msg.includes('conflict')) {
        return { ok: false, conflicts: true, message: msg }
      }
      throw err
    }
  })

  fastify.post('/hosts/:hostId/git/push', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, remote, branch, force, setUpstream } = request.body as { path: string; remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }
    if (!repoPath) throw new Error('Missing path')
    const args = ['push']
    if (force) args.push('--force')
    if (setUpstream) args.push('-u')
    if (remote) args.push(remote)
    if (branch) args.push(branch)
    try {
      const { stdout, stderr } = await execGit(hostId, args, repoPath, 30000)
      return { ok: true, rejected: false, message: (stdout || stderr).trim() }
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg.includes('rejected') || msg.includes('failed to push')) {
        return { ok: false, rejected: true, message: msg }
      }
      throw err
    }
  })

  fastify.get('/hosts/:hostId/git/remotes', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath } = request.query as { path?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const { stdout } = await execGit(hostId, ['remote', '-v'], repoPath)
    const remotes = stdout.split('\n').filter(Boolean).map((line) => {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/)
      if (!match) return null
      return { name: match[1], url: match[2], type: match[3] }
    }).filter(Boolean)
    const grouped: Record<string, { name: string; fetchUrl: string; pushUrl: string }> = {}
    for (const r of remotes) {
      if (!r) continue
      if (!grouped[r.name]) grouped[r.name] = { name: r.name, fetchUrl: '', pushUrl: '' }
      if (r.type === 'fetch') grouped[r.name].fetchUrl = r.url
      else grouped[r.name].pushUrl = r.url
    }
    return { remotes: Object.values(grouped) }
  })
}
