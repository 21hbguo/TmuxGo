import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync=promisify(execFile)
type TaskState='unknown'|'working'|'waiting'|'done'|'failed'
type ActivityState='active'|'idle'|'dead'
type PaneStatus={
session:string
windowIndex:number
windowName:string
paneId:string
paneIndex:number
paneTitle:string
command:string
active:boolean
dead:boolean
bell:boolean
lastActivity:number
taskState:TaskState
taskLabel:string
taskUpdatedAt:number
activityState:ActivityState
displayState:TaskState|'attention'|'idle'|'dead'
ageSeconds:number
}
const args=process.argv.slice(2)
const watch=args.includes('--watch')
const json=args.includes('--json')
const sessionArgIndex=args.indexOf('--session')
const intervalArgIndex=args.indexOf('--interval')
const sessionFilter=sessionArgIndex>=0?args[sessionArgIndex+1]||'':''
const intervalMs=intervalArgIndex>=0?Math.max(500,parseInt(args[intervalArgIndex+1]||'2000',10)||2000):2000
const activeThreshold=30
const stickyDoneThreshold=600
async function tmux(args:string[]) {
  const { stdout }=await execFileAsync('tmux',args)
  return stdout
}
function parseBool(value:string) {
  return value==='1'
}
function normalizeTaskState(value:string):TaskState {
  if (value==='working'||value==='waiting'||value==='done'||value==='failed') return value
  return 'unknown'
}
function activityState(dead:boolean,lastActivity:number,now:number):ActivityState {
  if (dead) return 'dead'
  if (now-lastActivity<activeThreshold) return 'active'
  return 'idle'
}
function displayState(taskState:TaskState,activity:ActivityState,bell:boolean,taskUpdatedAt:number,now:number):PaneStatus['displayState'] {
  if (activity==='dead') return 'dead'
  if (bell||taskState==='failed') return 'attention'
  if (taskState==='done'&&now-taskUpdatedAt<stickyDoneThreshold) return 'done'
  if (taskState==='working') return 'working'
  if (taskState==='waiting') return 'waiting'
  if (activity==='active') return 'working'
  return 'idle'
}
function icon(state:PaneStatus['displayState']) {
  if (state==='attention') return '!'
  if (state==='working') return '>'
  if (state==='waiting') return '~'
  if (state==='done') return '+'
  if (state==='dead') return 'x'
  return '.'
}
function formatAge(ageSeconds:number) {
  if (ageSeconds<60) return `${ageSeconds}s`
  if (ageSeconds<3600) return `${Math.floor(ageSeconds/60)}m`
  return `${Math.floor(ageSeconds/3600)}h`
}
function pad(value:string,length:number) {
  if (value.length>=length) return value.slice(0,length)
  return value.padEnd(length,' ')
}
async function scan():Promise<PaneStatus[]> {
  const format='#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_current_command}\t#{pane_active}\t#{pane_dead}\t#{pane_bell}\t#{pane_activity}\t#{@task_state}\t#{@task_label}\t#{@task_updated_at}'
  const stdout=await tmux(['list-panes','-a','-F',format])
  const now=Math.floor(Date.now()/1000)
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [session,windowIndex,windowName,paneId,paneIndex,paneTitle,command,active,dead,bell,activity,taskStateRaw,taskLabelRaw,taskUpdatedAtRaw]=line.split('\t')
    const lastActivity=parseInt(activity||'0',10)||0
    const taskUpdatedAt=parseInt(taskUpdatedAtRaw||'0',10)||0
    const taskState=normalizeTaskState(taskStateRaw||'')
    const currentActivityState=activityState(parseBool(dead||'0'),lastActivity,now)
    return {
      session,
      windowIndex:parseInt(windowIndex||'0',10)||0,
      windowName,
      paneId,
      paneIndex:parseInt(paneIndex||'0',10)||0,
      paneTitle:paneTitle||'',
      command:command||'',
      active:parseBool(active||'0'),
      dead:parseBool(dead||'0'),
      bell:parseBool(bell||'0'),
      lastActivity,
      taskState,
      taskLabel:taskLabelRaw||'',
      taskUpdatedAt,
      activityState:currentActivityState,
      displayState:displayState(taskState,currentActivityState,parseBool(bell||'0'),taskUpdatedAt,now),
      ageSeconds:lastActivity>0?Math.max(0,now-lastActivity):0,
    }
  }).filter((pane) => !sessionFilter||pane.session===sessionFilter).sort((a,b) => {
    if (a.session!==b.session) return a.session.localeCompare(b.session)
    if (a.windowIndex!==b.windowIndex) return a.windowIndex-b.windowIndex
    return a.paneIndex-b.paneIndex
  })
}
function printTable(panes:PaneStatus[]) {
  process.stdout.write('\x1bc')
  console.log(`tmux pane status prototype ${new Date().toLocaleString()}`)
  console.log('')
  console.log(`${pad('state',5)} ${pad('pane',6)} ${pad('session',18)} ${pad('window',18)} ${pad('cmd',12)} ${pad('task',8)} ${pad('age',6)} label`)
  for (const pane of panes) {
    const windowLabel=`${pane.windowIndex}:${pane.windowName}`
    const task=pane.taskState==='unknown'?'':pane.taskState
    const label=pane.taskLabel||pane.paneTitle||''
    console.log(`${pad(icon(pane.displayState),5)} ${pad(`${pane.paneId}:${pane.paneIndex}`,6)} ${pad(pane.session,18)} ${pad(windowLabel,18)} ${pad(pane.command,12)} ${pad(task,8)} ${pad(formatAge(pane.ageSeconds),6)} ${label}`)
  }
  console.log('')
  console.log('icons: > working  ~ waiting  + done  ! attention/failed  . idle  x dead')
}
async function runOnce() {
  const panes=await scan()
  if (json) {
    console.log(JSON.stringify(panes,null,2))
    return
  }
  printTable(panes)
}
async function runWatch() {
  while (true) {
    await runOnce()
    await new Promise((resolve) => setTimeout(resolve,intervalMs))
  }
}
if (watch) {
  runWatch().catch((err) => {
    console.error(err instanceof Error?err.message:String(err))
    process.exit(1)
  })
} else {
  runOnce().catch((err) => {
    console.error(err instanceof Error?err.message:String(err))
    process.exit(1)
  })
}
