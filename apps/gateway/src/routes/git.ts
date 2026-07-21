import type { FastifyInstance } from 'fastify'
import { execGit } from '../lib/git-executor.js'
import { execTmux } from '../lib/tmux-executor.js'
import { assertTargetAllowed } from '../lib/tmux-policy.js'

interface GitFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged'
  oldPath?: string
  staged: boolean
}
const gitLogFieldSeparator = '\x1f'
const gitLogRecordSeparator = '\x1e'
const gitBranchFieldSeparator = '\t'

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

export function parsePorcelainV2(stdout: string) {
  const records = stdout.split('\0')
  let branch = ''
  let ahead = 0
  let behind = 0
  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  const untracked: string[] = []
  const conflicted: GitFileChange[] = []

  for (let i = 0; i < records.length; i++) {
    const line = records[i]
    if (!line) continue
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
      const filePath = parts.slice(9).join(' ')
      const oldPath = records[++i] || filePath
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
      const filePath = parts.slice(10).join(' ')
      conflicted.push({ path: filePath, status: 'unmerged', staged: false })
    } else if (line.startsWith('? ')) {
      untracked.push(line.slice(2))
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked, conflicted }
}
function parseNumStat(stdout: string) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [additionsRaw, deletionsRaw, filename] = line.split('\t')
    const additions = additionsRaw === '-' ? 0 : parseInt(additionsRaw || '0', 10) || 0
    const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw || '0', 10) || 0
    return {
      filename: filename || '',
      status: additionsRaw === '-' || deletionsRaw === '-' ? 'binary' : additions > 0 && deletions > 0 ? 'modified' : additions > 0 ? 'added' : deletions > 0 ? 'deleted' : 'modified',
      additions,
      deletions,
    }
  }).filter((item) => item.filename)
}
function parseGitLog(stdout: string) {
  return stdout.split(gitLogRecordSeparator).filter(Boolean).map((record) => {
    const [hash = '', shortHash = '', subject = '', body = '', author = '', authorEmail = '', authorDate = '', committedDate = '', rawParents = ''] = record.split(gitLogFieldSeparator)
    const cleanHash = hash.trim()
    const cleanShortHash = shortHash.trim()
    const cleanSubject = subject.replace(/\n/g, ' ').trim()
    const cleanBody = body.replace(/^\n+|\n+$/g, '')
    const cleanAuthor = author.trim()
    const cleanAuthorEmail = authorEmail.trim()
    const cleanAuthorDate = authorDate.trim()
    const cleanCommittedDate = committedDate.trim()
    const parents = rawParents.trim() ? rawParents.trim().split(/\s+/).filter(Boolean) : []
    return cleanHash && cleanShortHash && cleanAuthor && cleanCommittedDate ? {
      hash: cleanHash,
      shortHash: cleanShortHash,
      subject: cleanSubject,
      body: cleanBody,
      author: cleanAuthor,
      authorEmail: cleanAuthorEmail,
      authorDate: cleanAuthorDate || cleanCommittedDate,
      date: cleanCommittedDate,
      parents,
    } : null
  }).filter(Boolean)
}
function parseGitBranches(stdout: string) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [head = '', name = '', commitHash = '', remote = '', trackingBranch = '', ...subjectParts] = line.split(gitBranchFieldSeparator)
    const lastCommitSubject = subjectParts.join(gitBranchFieldSeparator)
    if (!name.trim() || !commitHash.trim()) return null
    return {
      name: name.trim(),
      current: head.trim() === '*',
      remote: remote.trim() || undefined,
      commitHash: commitHash.trim(),
      trackingBranch: trackingBranch.trim() || undefined,
      lastCommitSubject: lastCommitSubject.trim(),
    }
  }).filter(Boolean)
}
export function parseGitRefs(stdout: string) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [fullName = '', objectHash = '', peeledHash = '', symref = ''] = line.split(gitBranchFieldSeparator)
    if (!fullName || symref) return null
    const kind = fullName.startsWith('refs/remotes/') ? 'remote' : fullName.startsWith('refs/tags/') ? 'tag' : null
    if (!kind) return null
    return {
      name: fullName.replace(kind === 'remote' ? 'refs/remotes/' : 'refs/tags/', ''),
      kind,
      commitHash: peeledHash || objectHash,
    }
  }).filter(Boolean)
}

export async function gitRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/git/detect', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, paneId } = request.query as { path?: string; paneId?: string }
    let candidatePath = repoPath?.trim() || ''
    try {
      if (!candidatePath && paneId) {
        if (!paneId.startsWith(`${hostId}:`)) throw new Error('Pane does not belong to host')
        const tmuxPaneId = paneId.slice(hostId.length + 1)
        if (!tmuxPaneId.startsWith('%')) throw new Error('Invalid pane id')
        if (hostId === 'local') await assertTargetAllowed(tmuxPaneId)
        const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', tmuxPaneId, '#{pane_current_path}'])
        candidatePath = stdout.trim()
      }
      if (!candidatePath) return { isGitRepo: false }
      const { stdout } = await execGit(hostId, ['rev-parse', '--show-toplevel'], candidatePath)
      const rootPath = stdout.trim()
      const { stdout: branchOut } = await execGit(hostId, ['rev-parse', '--abbrev-ref', 'HEAD'], rootPath)
      return { isGitRepo: true, rootPath, branch: branchOut.trim(), path: candidatePath }
    } catch {
      return { isGitRepo: false, path: candidatePath || undefined }
    }
  })

  fastify.get('/hosts/:hostId/git/status', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath } = request.query as { path?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const { stdout } = await execGit(hostId, ['status', '--porcelain=v2', '--branch', '-z'], repoPath)
    return parsePorcelainV2(stdout)
  })

  fastify.get('/hosts/:hostId/git/diff', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, filePath, staged, commit } = request.query as { path?: string; filePath?: string; staged?: string; commit?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const args = commit ? ['show', '--format=', '--no-color', commit.replace(/\^!$/, '')] : ['diff', '--no-color']
    if (!commit && staged === 'true') args.push('--staged')
    if (filePath) args.push('--', filePath)
    const { stdout } = await execGit(hostId, args, repoPath)
    return { raw: stdout }
  })
  fastify.get('/hosts/:hostId/git/diff-stats', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath, base, head } = request.query as { path?: string; base?: string; head?: string }
    if (!repoPath || !base || !head) throw new Error('Missing path, base or head parameter')
    const { stdout } = await execGit(hostId, ['diff', '--numstat', `${base}..${head}`], repoPath)
    return { files: parseNumStat(stdout) }
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
    const args = ['log', '--all', '--date-order', `--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%ai%x1f%ci%x1f%P%x1e`, `-n${n}`]
    if (s > 0) args.push(`--skip=${s}`)
    const { stdout } = await execGit(hostId, args, repoPath)
    const commits = parseGitLog(stdout)
    const hasMore = commits.length === n
    return { commits, hasMore }
  })

  fastify.get('/hosts/:hostId/git/branches', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const { path: repoPath } = request.query as { path?: string }
    if (!repoPath) throw new Error('Missing path parameter')
    const [{ stdout }, { stdout: refsOut }] = await Promise.all([
      execGit(hostId, ['for-each-ref', '--sort=-committerdate', `--format=%(if)%(HEAD)%(then)*%(else) %(end)${gitBranchFieldSeparator}%(refname:short)${gitBranchFieldSeparator}%(objectname)${gitBranchFieldSeparator}%(upstream:short)${gitBranchFieldSeparator}%(upstream:trackshort)${gitBranchFieldSeparator}%(contents:subject)`, 'refs/heads'], repoPath),
      execGit(hostId, ['for-each-ref', '--sort=-committerdate', `--format=%(refname)${gitBranchFieldSeparator}%(objectname)${gitBranchFieldSeparator}%(*objectname)${gitBranchFieldSeparator}%(symref)`, 'refs/remotes', 'refs/tags'], repoPath),
    ])
    const branches = parseGitBranches(stdout)
    const refs = parseGitRefs(refsOut)
    const current = branches.find((b) => b?.current)?.name || ''
    return { branches, refs, current }
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
