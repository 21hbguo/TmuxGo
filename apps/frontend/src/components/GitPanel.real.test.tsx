import { render, screen } from '@testing-library/react'
import React from 'react'
import { GitHistoryGraph } from './GitHistoryGraph'
import { buildGitGraphLayout, type GitGraphBranchHead, type GitGraphCommit } from '@/lib/gitGraph'

function createGraphData(){
  const commits:GitGraphCommit[]=[]
  const date=(index:number)=>new Date(Date.UTC(2024,0,1,index)).toISOString()
  commits.push({sha:'base',shortSha:'base',subject:'base',author:{name:'dev',email:'dev@test'},authoredAt:date(0),committedAt:date(0),parents:[]})
  let previous='base'
  for(let index=0;index<30;index++){
    const main=`main-${index}`
    const feature=`feature-${index}`
    const merge=`merge-${index}`
    const follow=`follow-${index}`
    const offset=index*4+1
    commits.push({sha:main,shortSha:main,subject:`main ${index}`,author:{name:'dev',email:'dev@test'},authoredAt:date(offset),committedAt:date(offset),parents:[{sha:previous}]})
    commits.push({sha:feature,shortSha:feature,subject:`feature ${index}`,author:{name:'dev',email:'dev@test'},authoredAt:date(offset+1),committedAt:date(offset+1),parents:[{sha:previous}]})
    commits.push({sha:merge,shortSha:merge,subject:`merge ${index}`,author:{name:'dev',email:'dev@test'},authoredAt:date(offset+2),committedAt:date(offset+2),parents:[{sha:main},{sha:feature}]})
    commits.push({sha:follow,shortSha:follow,subject:`follow ${index}`,author:{name:'dev',email:'dev@test'},authoredAt:date(offset+3),committedAt:date(offset+3),parents:[{sha:merge}]})
    previous=follow
  }
  commits.reverse()
  const branchHeads:GitGraphBranchHead[]=[
    {name:'master',current:true,commit:{sha:'follow-29'}},
    {name:'feature-a',commit:{sha:'feature-29'}},
    {name:'feature-b',commit:{sha:'feature-20'}},
    {name:'release',commit:{sha:'merge-25'}},
  ]
  return {commits,branchHeads,currentBranch:'master'}
}

describe('GitPanel graph stress render',()=>{
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
  it('renders a stable multi-lane graph with a long deterministic history',()=>{
    const {commits,branchHeads,currentBranch}=createGraphData()
    const layout=buildGitGraphLayout(commits,branchHeads,currentBranch)
    const renderGraph=(graphCommits:GitGraphCommit[])=>React.createElement('div',{'data-git-history-scroll':'1'},React.createElement(GitHistoryGraph,{
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
    const {container,rerender}=render(renderGraph(commits.slice(0,64)))
    const firstPageWidth=container.querySelector('svg')?.getAttribute('width')
    rerender(renderGraph(commits))
    expect(commits.length).toBe(121)
    expect(branchHeads.length).toBe(4)
    expect(layout.laneCount).toBeGreaterThan(1)
    expect(layout.edges.some((edge)=>edge.fromLane!==edge.toLane)).toBe(true)
    expect(container.querySelector('svg')).toHaveAttribute('width',firstPageWidth)
    expect(container.querySelectorAll('svg path').length).toBeGreaterThan(50)
    expect(screen.getByText('master')).toBeInTheDocument()
  })
})
