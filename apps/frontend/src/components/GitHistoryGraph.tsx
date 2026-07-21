'use client'
import { useEffect, useMemo, useRef } from 'react'
import type { GitGraphBranchHead, GitGraphCommit } from '@/lib/gitGraph'
import { buildGitGraphLayout } from '@/lib/gitGraph'

type GitHistoryGraphProps={
  commits:GitGraphCommit[]
  branchHeads:GitGraphBranchHead[]
  currentBranch?:string
  hasMore:boolean
  isFetchingMore:boolean
  onLoadMore:()=>void
  onCommitClick:(commit:GitGraphCommit)=>void
  formatDate:(date:string|number|Date)=>string
  formatDateFull:(date:string|number|Date)=>string
  searchQuery?:string
}

const rowHeight=54
const laneGap=18
const graphMinLanes=4
const graphPaddingX=14
const graphPaddingY=rowHeight/2
const nodeRadius=4
const graphColors=['#2563eb','#f59e0b','#10b981','#ef4444','#7c3aed','#db2777','#0891b2','#ea580c']

function edgePath(fromX:number,fromY:number,toX:number,toY:number){
  if(fromX===toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`
  const midY=fromY+(toY-fromY)/2
  return `M ${fromX} ${fromY} C ${fromX} ${midY} ${toX} ${midY} ${toX} ${toY}`
}

export function GitHistoryGraph({ commits, branchHeads, currentBranch, hasMore, isFetchingMore, onLoadMore, onCommitClick, formatDate, formatDateFull, searchQuery='' }:GitHistoryGraphProps){
  const sentinelRef=useRef<HTMLDivElement|null>(null)
  const graphRef=useRef<HTMLDivElement|null>(null)
  const layout=useMemo(()=>buildGitGraphLayout(commits,branchHeads,currentBranch),[branchHeads,commits,currentBranch])
  const normalizedSearch=searchQuery.trim().toLocaleLowerCase()
  const graphWidth=graphPaddingX*2+Math.max(layout.laneCount,graphMinLanes)*laneGap
  const graphHeight=Math.max(layout.rows.length,1)*rowHeight
  const edgeNodes=layout.edges.map((edge,index)=>{
    const workingTree=layout.rows[edge.fromRow]?.commit.workingTree
    const color=workingTree?'#8e8e93':graphColors[edge.colorIndex%graphColors.length]
    const fromX=graphPaddingX+edge.fromLane*laneGap
    const toX=graphPaddingX+edge.toLane*laneGap
    const fromY=graphPaddingY+edge.fromRow*rowHeight
    const toY=graphPaddingY+edge.toRow*rowHeight
    return <path key={`${edge.fromRow}-${edge.toRow}-${edge.fromLane}-${edge.toLane}-${index}`} d={edgePath(fromX,fromY,toX,toY)} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={workingTree?'3 4':undefined} opacity="0.95" />
  })
  const nodeDots=layout.rows.map((row)=>{
    const color=row.commit.workingTree?'#8e8e93':graphColors[row.colorIndex%graphColors.length]
    const cx=graphPaddingX+row.lane*laneGap
    const cy=graphPaddingY+row.row*rowHeight
    return (
      <g key={row.commit.sha}>
        {!row.commit.workingTree&&<circle cx={cx} cy={cy} r={nodeRadius+2} fill={color} opacity="0.2" />}
        <circle cx={cx} cy={cy} r={row.commit.workingTree?nodeRadius+1:nodeRadius} fill={row.commit.workingTree?'rgb(var(--bg-1))':color} stroke={color} strokeWidth={row.commit.workingTree?'2':'1.5'} />
      </g>
    )
  })
  const rowNodes=layout.rows.map((row)=>{
    const color=row.commit.workingTree?'#8e8e93':graphColors[row.colorIndex%graphColors.length]
    const committedLabel=row.commit.workingTree?'':`Commit ${formatDateFull(row.commit.committedAt)}`
    const authoredLabel=row.commit.authoredAt!==row.commit.committedAt?`Author ${formatDateFull(row.commit.authoredAt)}`:''
    const tooltipText=[row.commit.subject||row.commit.shortSha,`${row.commit.shortSha} · ${row.commit.author.name}`,committedLabel,authoredLabel].filter(Boolean).join('\n')
    const matchesSearch=!!normalizedSearch&&[row.commit.sha,row.commit.shortSha,row.commit.subject,row.commit.author.name,row.commit.author.email||'',...row.branches.map((branch)=>branch.name)].some((value)=>value.toLocaleLowerCase().includes(normalizedSearch))
    return (
      <button key={row.commit.sha} type="button" title={tooltipText} data-git-search-match={matchesSearch?'1':undefined} onClick={()=>onCommitClick(row.commit)} className={`flex h-[54px] w-full items-stretch gap-3 border-l-2 px-0 py-0 text-left transition-colors ${matchesSearch?'border-accent bg-accent/[0.08]':'border-transparent hover:bg-bg-2'}`}>
        <div className="shrink-0" style={{ width: graphWidth, height: rowHeight }} />
        <div className="min-w-0 flex-1 border-b border-[var(--line)]/50 pr-3">
          <div className="flex h-full flex-col justify-center">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold" style={{ color }}>{row.commit.shortSha}</span>
            {!!row.branches.length&&(
              <div className="flex min-w-0 flex-wrap gap-1">
                {row.branches.map((branch)=>(
                  <span key={`${branch.kind||'branch'}-${branch.name}`} className={`rounded px-1.5 py-0.5 text-[10px] ${branch.name===currentBranch&&branch.kind!=='remote'&&branch.kind!=='tag'?'bg-accent/20 text-accent':branch.kind==='tag'?'bg-yellow-400/15 text-yellow-400':branch.kind==='remote'?'bg-blue-400/15 text-blue-400':'bg-green-400/15 text-green-400'}`}>{branch.name}</span>
                ))}
              </div>
            )}
            {!row.commit.workingTree&&<span className="ml-auto shrink-0 text-[10px] text-text-3">{formatDate(row.commit.committedAt)}</span>}
          </div>
          <div className="truncate text-[12px] text-text-1" title={row.commit.subject || row.commit.shortSha}>{row.commit.subject || row.commit.shortSha}</div>
          <div className="truncate text-[10px] text-text-3">{row.commit.author.name}</div>
        </div>
        </div>
      </button>
    )
  })
  useEffect(()=>{
    const element=sentinelRef.current
    if(!element||!hasMore) return
    const root=element.closest('[data-git-history-scroll="1"]')
    const observer=new IntersectionObserver((entries)=>{
      if(entries.some((entry)=>entry.isIntersecting)&&!isFetchingMore) onLoadMore()
    },{root:root instanceof HTMLElement?root:null,rootMargin:'240px 0px'})
    observer.observe(element)
    return ()=>observer.disconnect()
  },[hasMore,isFetchingMore,onLoadMore])
  useEffect(()=>{
    if(!normalizedSearch) return
    graphRef.current?.querySelector<HTMLElement>('[data-git-search-match="1"]')?.scrollIntoView?.({block:'center'})
  },[normalizedSearch])
  if(commits.length===0) return null
  return (
    <div ref={graphRef} className="min-h-0">
      <div className="relative">
        <svg width={graphWidth} height={graphHeight} className="pointer-events-none absolute left-0 top-0 overflow-visible">
          {edgeNodes}
          {nodeDots}
        </svg>
        <div className="relative">
          {rowNodes}
          <div ref={sentinelRef} className="h-6" />
          {(hasMore||isFetchingMore)&&<div className="px-3 py-2 text-[11px] text-text-3">{isFetchingMore?'Loading history...':'Scroll for more commits'}</div>}
        </div>
      </div>
    </div>
  )
}
