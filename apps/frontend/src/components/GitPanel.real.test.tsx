import { render, screen } from '@testing-library/react'
import { execFileSync } from 'child_process'
import React from 'react'
import { CommitGraph } from 'commit-graph'

function loadRepoGraphData() {
  const repo = '/home/guo/project/other/TmuxGo_v2'
  const field = '\x1f'
  const branchField = '\t'
  const record = '\x1e'
  const logOut = execFileSync('git', ['-C', repo, 'log', '--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%ai%x1f%P%x1e', '-n100'], { encoding: 'utf8' })
  const commitsRaw = logOut.split(record).filter(Boolean).map((line) => {
    const [hash = '', shortHash = '', subject = '', body = '', author = '', authorEmail = '', date = '', rawParents = ''] = line.split(field)
    return {
      hash: hash.trim(),
      shortHash: shortHash.trim(),
      subject: subject.replace(/\n/g, ' ').trim(),
      body: body.replace(/^\n+|\n+$/g, ''),
      author: author.trim(),
      authorEmail: authorEmail.trim(),
      date: date.trim(),
      parents: rawParents.trim() ? rawParents.trim().split(/\s+/).filter(Boolean) : [],
    }
  }).filter((commit) => commit.hash && commit.shortHash && commit.author && commit.date && Number.isFinite(new Date(commit.date).getTime()))
  const seen = new Set<string>()
  const commitsValid = commitsRaw.filter((commit) => !seen.has(commit.hash) && seen.add(commit.hash))
  const commitSet = new Set(commitsValid.map((commit) => commit.hash))
  const commits = commitsValid.map((commit) => ({
    sha: commit.hash,
    commit: {
      author: {
        name: commit.author,
        date: commit.date,
        email: commit.authorEmail,
      },
      message: commit.subject || commit.hash.slice(0, 7),
    },
    parents: commit.parents.filter((sha, index, arr) => sha && commitSet.has(sha) && arr.indexOf(sha) === index).map((sha) => ({ sha })),
  }))
  const branchOut = execFileSync('git', ['-C', repo, 'for-each-ref', '--sort=-committerdate', '--format=%(if)%(HEAD)%(then)*%(else) %(end)\t%(refname:short)\t%(objectname)\t%(upstream:short)\t%(upstream:trackshort)\t%(contents:subject)', 'refs/heads'], { encoding: 'utf8' })
  const branches = branchOut.split('\n').filter(Boolean).map((line) => {
    const [head = '', name = '', commitHash = ''] = line.split(branchField)
    return {
      name: name.trim(),
      current: head.trim() === '*',
      commitHash: commitHash.trim(),
    }
  }).filter((branch) => branch.name && branch.commitHash && commitSet.has(branch.commitHash))
  const branchHeads = branches.map((branch) => ({ name: branch.name, commit: { sha: branch.commitHash } }))
  const currentBranch = branches.find((branch) => branch.current)?.name
  return { commits, branchHeads, currentBranch }
}

describe('GitPanel real graph render', () => {
  it('renders commit-graph with real repository data', () => {
    const { commits, branchHeads, currentBranch } = loadRepoGraphData()
    const { container } = render(React.createElement(CommitGraph.WithInfiniteScroll, {
      commits,
      branchHeads,
      loadMore: () => {},
      hasMore: false,
      currentBranch,
    }))
    expect(commits.length).toBeGreaterThan(50)
    expect(branchHeads.length).toBeGreaterThan(0)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('master')).toBeInTheDocument()
  })
})
