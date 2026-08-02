interface PaneBounds {
  id:string
  left:number
  top:number
  cols:number
  rows:number
}

export function createTerminalPaneInteractions(getTerminal:()=>any,container:HTMLElement,readSessionSnapshot:()=>any) {
  let cache:{snapshot:any;windowId:string;bounds:PaneBounds[]}|null=null
  const getPaneBounds=(pane:any):PaneBounds|null=>{
    const id=String(pane?.id??pane?.tmuxPaneId??'')
    const left=Number(pane?.left??pane?.position?.left)
    const top=Number(pane?.top??pane?.position?.top)
    const cols=Number(pane?.size?.cols??pane?.cols)
    const rows=Number(pane?.size?.rows??pane?.rows)
    return [left,top,cols,rows].every(Number.isFinite)&&cols>0&&rows>0?{id,left,top,cols,rows}:null
  }
  const getCachedPaneBounds=()=>{
    const snapshot=readSessionSnapshot()
    if (!snapshot) return [] as PaneBounds[]
    const windows=Array.isArray(snapshot?.windows)?snapshot.windows:[]
    const activeWindow=windows.find((item:any)=>item.id===snapshot?.activeWindowId)||windows.find((item:any)=>item.active)
    const activePaneId=String(snapshot?.activePaneId||'')
    const windowId=String(activeWindow?.id||'')
    if (cache&&cache.snapshot===snapshot&&cache.windowId===windowId) return cache.bounds
    const panes=Array.isArray(snapshot?.panes)?snapshot.panes:[]
    const filtered=windowId?panes.filter((pane:any)=>String(pane.windowId||'')===windowId):panes
    const visible=activeWindow?.zoomed&&activePaneId?filtered.filter((pane:any)=>String(pane?.id||pane?.tmuxPaneId||'')===activePaneId):filtered
    const bounds=visible.map(getPaneBounds).filter(Boolean) as PaneBounds[]
    cache={snapshot,windowId,bounds}
    return bounds
  }
  const getMouseCell=(event:MouseEvent)=>{
    const terminal=getTerminal()
    const screen=terminal?.element?.querySelector('.xterm-screen') as HTMLElement|null
    if (!screen||!terminal?.cols||!terminal?.rows) return null
    const rect=screen.getBoundingClientRect()
    if (!rect.width||!rect.height) return null
    const cellWidth=rect.width/terminal.cols
    const cellHeight=rect.height/terminal.rows
    if (!Number.isFinite(cellWidth)||!Number.isFinite(cellHeight)||cellWidth<=0||cellHeight<=0) return null
    const x=Math.floor((event.clientX-rect.left)/cellWidth)
    const y=Math.floor((event.clientY-rect.top)/cellHeight)
    return x<0||y<0||x>=terminal.cols||y>=terminal.rows?null:{x,y}
  }
  const getPaneIdByMouseCell=(cell:{x:number;y:number}|null)=>{
    if (!cell) return null
    return getCachedPaneBounds().find((pane)=>cell.x>=pane.left&&cell.x<pane.left+pane.cols&&cell.y>=pane.top&&cell.y<pane.top+pane.rows)?.id||null
  }
  const getSelectionText=()=>{
    const terminal=getTerminal()
    const position=terminal?.getSelectionPosition?.()
    const start=position?.start
    const end=position?.end
    if (start&&end) {
      const first=start.y<end.y||start.y===end.y&&start.x<=end.x?start:end
      const last=first===start?end:start
      const pane=getCachedPaneBounds().find((item)=>first.x>=item.left&&first.x<item.left+item.cols&&first.y>=item.top&&first.y<item.top+item.rows)
      if (pane) {
        const baseY=Number(terminal?.buffer?.active?.baseY)||0
        const lines:string[]=[]
        for (let y=Math.max(pane.top,first.y);y<=Math.min(pane.top+pane.rows-1,last.y);y+=1) {
          const line=terminal?.buffer?.active?.getLine?.(baseY+y)
          if (!line) continue
          const fromX=y===first.y?Math.max(pane.left,first.x):pane.left
          const toX=y===last.y?Math.min(pane.left+pane.cols,last.x):pane.left+pane.cols
          if (toX>=fromX) lines.push(line.translateToString(true,fromX,toX))
        }
        if (lines.length) return lines.join('\n')
      }
    }
    return terminal?.getSelection?.()||window.getSelection?.()?.toString()||''
  }
  const overlaps=(startA:number,endA:number,startB:number,endB:number)=>Math.max(startA,startB)<=Math.min(endA,endB)
  const getPaneResizeTarget=(event:MouseEvent)=>{
    if (event.button!==0||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey) return null
    const cell=getMouseCell(event)
    if (!cell) return null
    const panes=getCachedPaneBounds()
    const vertical=panes.find((pane)=>{
      const edge=pane.left+pane.cols
      return !!pane.id&&Math.abs(cell.x-edge)<=1&&cell.y>=pane.top&&cell.y<pane.top+pane.rows&&panes.some((other)=>other.left===edge+1&&overlaps(pane.top,pane.top+pane.rows-1,other.top,other.top+other.rows-1))
    })
    if (vertical) return {axis:'x',paneId:vertical.id,startCell:vertical.left+vertical.cols,startSize:vertical.cols,crossStart:vertical.top,crossSize:vertical.rows,paneStart:vertical.left}
    const horizontal=panes.find((pane)=>{
      const edge=pane.top+pane.rows
      return !!pane.id&&Math.abs(cell.y-edge)<=1&&cell.x>=pane.left&&cell.x<pane.left+pane.cols&&panes.some((other)=>other.top===edge+1&&overlaps(pane.left,pane.left+pane.cols-1,other.left,other.left+other.cols-1))
    })
    return horizontal?{axis:'y',paneId:horizontal.id,startCell:horizontal.top+horizontal.rows,startSize:horizontal.rows,crossStart:horizontal.left,crossSize:horizontal.cols,paneStart:horizontal.top}:null
  }
  return {getSelectionText,getMouseCell,getPaneIdByMouseCell,getPaneResizeTarget,getPaneIdAtPoint:(x:number,y:number)=>getPaneIdByMouseCell(getMouseCell({clientX:x,clientY:y} as MouseEvent))}
}
