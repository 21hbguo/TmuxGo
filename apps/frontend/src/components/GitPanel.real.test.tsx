import { render, screen } from '@testing-library/react'
import { execFileSync } from 'child_process'
import React from 'react'
import { GitHistoryGraph } from './GitHistoryGraph'
import { buildGitGraphLayout, type GitGraphBranchHead, type GitGraphCommit } from '@/lib/gitGraph'

function loadRepoGraphData(){
  const repo=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()
  const field='\x1f'
  const branchField='\t'
  const record='\x1e'
  const logOut=execFileSync('git',['-C',repo,'log','--all','--date-order','--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%ai%x1f%ci%x1f%P%x1e','-n120'],{encoding:'utf8'})
  const commitsRaw=logOut.split(record).filter(Boolean).map((line)=>{
    const [hash='',shortHash='',subject='',body='',author='',authorEmail='',authorDate='',committedDate='',rawParents='']=line.split(field)
    return {
      hash:hash.trim(),
      shortHash:shortHash.trim(),
      subject:subject.replace(/\n/g,' ').trim(),
      body:body.replace(/^\n+|\n+$/g,''),
      author:author.trim(),
      authorEmail:authorEmail.trim(),
      authorDate:authorDate.trim(),
      committedDate:committedDate.trim(),
      parents:rawParents.trim()?rawParents.trim().split(/\s+/).filter(Boolean):[],
    }
  }).filter((commit)=>commit.hash&&commit.shortHash&&commit.author&&commit.committedDate&&Number.isFinite(new Date(commit.committedDate).getTime()))
  const seen=new Set<string>()
  const commitsValid=commitsRaw.filter((commit)=>!seen.has(commit.hash)&&seen.add(commit.hash))
  const commitSet=new Set(commitsValid.map((commit)=>commit.hash))
  const commits:GitGraphCommit[]=commitsValid.map((commit)=>({
    sha:commit.hash,
    shortSha:commit.shortHash,
    subject:commit.subject||commit.shortHash,
    author:{
      name:commit.author,
      email:commit.authorEmail,
    },
    authoredAt:commit.authorDate||commit.committedDate,
    committedAt:commit.committedDate,
    parents:commit.parents.filter((sha,index,arr)=>sha&&commitSet.has(sha)&&arr.indexOf(sha)===index).map((sha)=>({sha})),
  }))
  const branchOut=execFileSync('git',['-C',repo,'for-each-ref','--sort=-committerdate','--format=%(if)%(HEAD)%(then)*%(else) %(end)\t%(refname:short)\t%(objectname)\t%(upstream:short)\t%(upstream:trackshort)\t%(contents:subject)','refs/heads'],{encoding:'utf8'})
  const branchHeads:GitGraphBranchHead[]=branchOut.split('\n').filter(Boolean).map((line)=>{
    const [head='',name='',commitHash='']=line.split(branchField)
    return {
      name:name.trim(),
      current:head.trim()==='*',
      commitHash:commitHash.trim(),
    }
  }).filter((branch)=>branch.name&&branch.commitHash&&commitSet.has(branch.commitHash)).map((branch)=>({name:branch.name,commit:{sha:branch.commitHash}}))
  const currentBranch=branchOut.split('\n').filter(Boolean).map((line)=>{
    const [head='',name='']=line.split(branchField)
    return head.trim()==='*'?name.trim():''
  }).find(Boolean)
  return {commits,branchHeads,currentBranch}
}

describe('GitPanel real graph render',()=>{
  beforeEach(()=>{
    class MockIntersectionObserver {
      observe=vi.fn()
      disconnect=vi.fn()
    }
    vi.stubGlobal('IntersectionObserver',MockIntersectionObserver as any)
  })
  afterEach(()=>{
    vi.unstubAllGlobals()
  })
  it('renders a multi-lane graph with real repository data',()=>{
    const { commits, branchHeads, currentBranch }=loadRepoGraphData()
    const layout=buildGitGraphLayout(commits,branchHeads,currentBranch)
    const renderGraph=(graphCommits:GitGraphCommit[])=>React.createElement('div',{ 'data-git-history-scroll':'1' },React.createElement(GitHistoryGraph,{
      commits:graphCommits,
      branchHeads,
      currentBranch,
      hasMore:false,
      isFetchingMore:false,
      onLoadMore:()=>{},
      onCommitClick:()=>{},
      formatDate:(value)=>String(value),
      formatDateFull:(value)=>String(value),
    }))
    const { container, rerender }=render(renderGraph(commits.slice(0,200)))
    const firstPageWidth=container.querySelector('svg')?.getAttribute('width')
    rerender(renderGraph(commits))
    expect(commits.length).toBeGreaterThan(100)
    expect(branchHeads.length).toBeGreaterThan(3)
    expect(layout.laneCount).toBeGreaterThan(1)
    expect(layout.edges.some((edge)=>edge.fromLane!==edge.toLane)).toBe(true)
    expect(container.querySelector('svg')).toHaveAttribute('width',firstPageWidth)
    expect(container.querySelectorAll('svg path').length).toBeGreaterThan(50)
    expect(screen.getByText('master')).toBeInTheDocument()
  })
})
