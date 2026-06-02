export type GitGraphCommitAuthor={
  name:string
  date:string
  email?:string
}
export type GitGraphCommit={
  sha:string
  shortSha:string
  subject:string
  author:GitGraphCommitAuthor
  parents:{sha:string}[]
}
export type GitGraphBranchHead={
  name:string
  commit:{sha:string}
}
export type GitGraphLaneRow={
  commit:GitGraphCommit
  row:number
  lane:number
  colorIndex:number
  branches:string[]
}
export type GitGraphLaneEdge={
  fromRow:number
  toRow:number
  fromLane:number
  toLane:number
  colorIndex:number
}
export type GitGraphLayout={
  rows:GitGraphLaneRow[]
  edges:GitGraphLaneEdge[]
  laneCount:number
}
function firstEmptyLane(active:(string|null)[],start:number){
  for(let i=start;i<active.length;i+=1){
    if(!active[i]) return i
  }
  return active.length
}
function trimTrailing(active:(string|null)[]){
  while(active.length&&active[active.length-1]===null) active.pop()
}
export function buildGitGraphLayout(commits:GitGraphCommit[],branchHeads:GitGraphBranchHead[],currentBranch?:string):GitGraphLayout{
  const commitIndex=new Map(commits.map((commit,index)=>[commit.sha,index]))
  const branchMap=new Map<string,string[]>()
  for(const branchHead of branchHeads){
    if(!commitIndex.has(branchHead.commit.sha)) continue
    const existing=branchMap.get(branchHead.commit.sha)
    if(existing){
      existing.push(branchHead.name)
      continue
    }
    branchMap.set(branchHead.commit.sha,[branchHead.name])
  }
  const orderedHeads=branchHeads.filter((branchHead)=>commitIndex.has(branchHead.commit.sha)).sort((a,b)=>{
    const aCurrent=a.name===currentBranch?-1:0
    const bCurrent=b.name===currentBranch?-1:0
    if(aCurrent!==bCurrent) return aCurrent-bCurrent
    return (commitIndex.get(a.commit.sha)??0)-(commitIndex.get(b.commit.sha)??0)||a.name.localeCompare(b.name)
  })
  const active:(string|null)[]=[]
  const laneColors:number[]=[]
  let nextColor=0
  for(const branchHead of orderedHeads){
    if(active.includes(branchHead.commit.sha)) continue
    const lane=firstEmptyLane(active,0)
    active[lane]=branchHead.commit.sha
    laneColors[lane]=nextColor
    nextColor+=1
  }
  const rows:GitGraphLaneRow[]=[]
  const rowByHash=new Map<string,GitGraphLaneRow>()
  for(let row=0;row<commits.length;row+=1){
    const commit=commits[row]
    let lane=active.indexOf(commit.sha)
    if(lane===-1){
      lane=firstEmptyLane(active,0)
      active[lane]=commit.sha
      if(laneColors[lane]===undefined){
        laneColors[lane]=nextColor
        nextColor+=1
      }
    }
    const colorIndex=laneColors[lane]??0
    const rowData={commit,row,lane,colorIndex,branches:(branchMap.get(commit.sha)||[]).slice().sort((a,b)=>{
      if(a===currentBranch) return -1
      if(b===currentBranch) return 1
      return a.localeCompare(b)
    })}
    rows.push(rowData)
    rowByHash.set(commit.sha,rowData)
    const firstParent=commit.parents[0]?.sha
    if(firstParent&&commitIndex.has(firstParent)){
      const existingLane=active.indexOf(firstParent)
      if(existingLane!==-1&&existingLane!==lane) active[existingLane]=null
      active[lane]=firstParent
    }else{
      active[lane]=null
    }
    for(let i=1;i<commit.parents.length;i+=1){
      const parent=commit.parents[i]?.sha
      if(!parent||!commitIndex.has(parent)) continue
      if(active.includes(parent)) continue
      const parentLane=firstEmptyLane(active,lane+1)
      active[parentLane]=parent
      if(laneColors[parentLane]===undefined){
        laneColors[parentLane]=nextColor
        nextColor+=1
      }
    }
    trimTrailing(active)
  }
  const edges:GitGraphLaneEdge[]=[]
  for(const row of rows){
    for(let i=0;i<row.commit.parents.length;i+=1){
      const parent=row.commit.parents[i]
      const parentRow=rowByHash.get(parent.sha)
      if(!parentRow||parentRow.row<=row.row) continue
      edges.push({
        fromRow:row.row,
        toRow:parentRow.row,
        fromLane:row.lane,
        toLane:parentRow.lane,
        colorIndex:i===0?row.colorIndex:parentRow.colorIndex,
      })
    }
  }
  const laneCount=rows.reduce((max,row)=>Math.max(max,row.lane+1),0)||1
  return {rows,edges,laneCount}
}
