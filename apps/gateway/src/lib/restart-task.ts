import { spawn } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
export type RestartTaskStatus='idle'|'running'|'success'|'error'|'cancelled'
export interface RestartTaskState {
  status: RestartTaskStatus
  startedAt: string | null
  finishedAt: string | null
  summaryLines: string[]
  exitCode: number | null
  errorMessage: string | null
  pid?: number | null
}
export interface RestartTaskRunner {
  getState(): RestartTaskState
  start(): Promise<RestartTaskState>
  cancel(): Promise<RestartTaskState>
}
interface RestartTaskRunnerOptions {
  rootDir?: string
  maxSummaryLines?: number
  statePath?: string
  command?: string
  args?: string[]
  logPath?: string
}
const defaultState=():RestartTaskState=>({
  status:'idle',
  startedAt:null,
  finishedAt:null,
  summaryLines:[],
  exitCode:null,
  errorMessage:null,
  pid:null,
})
function getStatePath(options: RestartTaskRunnerOptions) {
  if (options.statePath) return options.statePath
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'restart-task.json')
}
function pidAlive(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}
function tailLines(logPath: string | undefined, maxLines: number): string[] | null {
  if (!logPath) return null
  try {
    if (!existsSync(logPath)) return null
    const size = statSync(logPath).size
    const raw = readFileSync(logPath, 'utf8')
    if (size === 0) return null
    return raw.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-maxLines)
  } catch {
    return null
  }
}
function parseState(statePath: string): RestartTaskState {
  const parsed=JSON.parse(readFileSync(statePath,'utf8')) as Partial<RestartTaskState>
  if (parsed.status!=='idle'&&parsed.status!=='running'&&parsed.status!=='success'&&parsed.status!=='error'&&parsed.status!=='cancelled') return defaultState()
  return {
    status:parsed.status,
    startedAt:typeof parsed.startedAt==='string'?parsed.startedAt:null,
    finishedAt:typeof parsed.finishedAt==='string'?parsed.finishedAt:null,
    summaryLines:Array.isArray(parsed.summaryLines)?parsed.summaryLines.filter((line):line is string=>typeof line==='string').slice(-20):[],
    exitCode:typeof parsed.exitCode==='number'?parsed.exitCode:null,
    errorMessage:typeof parsed.errorMessage==='string'?parsed.errorMessage:null,
    pid:typeof parsed.pid==='number'?parsed.pid:null,
  }
}
function readState(statePath: string, logPath?: string, maxSummaryLines = 20): RestartTaskState {
  try {
    const state=parseState(statePath)
    if (state.status==='running') {
      const liveLog = tailLines(logPath, maxSummaryLines)
      if (liveLog && liveLog.length) state.summaryLines = liveLog
    }
    if (state.status!=='running') return state
    if (pidAlive(state.pid)) return state
    return {...state,status:'error',finishedAt:new Date().toISOString(),errorMessage:'Task interrupted by Gateway restart'}
  } catch {
    return defaultState()
  }
}
function writeState(statePath: string, state: RestartTaskState) {
  try {
    mkdirSync(path.dirname(statePath),{recursive:true,mode:0o700})
    const tempPath=`${statePath}.tmp-${process.pid}`
    writeFileSync(tempPath,`${JSON.stringify(state)}\n`,{encoding:'utf8',mode:0o600})
    chmodSync(tempPath,0o600)
    renameSync(tempPath,statePath)
    chmodSync(statePath,0o600)
  } catch {}
}
export function createRestartTaskRunner(options:RestartTaskRunnerOptions={}):RestartTaskRunner {
  const rootDir=options.rootDir||path.resolve(process.cwd(),'..','..')
  const maxSummaryLines=options.maxSummaryLines||20
  const statePath=getStatePath(options)
  const logPath=options.logPath
  const command=options.command||'./start.sh'
  const commandArgs=options.args||['--restart','--rebuild','--preserve-tmux']
  let state=readState(statePath,logPath,maxSummaryLines)
  if (state.status==='error'&&state.errorMessage==='Task interrupted by Gateway restart') writeState(statePath,state)
  let adopted=state.status==='running'
  let child:ReturnType<typeof spawn>|null=null
  let runId=0
  let logTimer:NodeJS.Timeout|null=null
  const stopLogTimer=() => {
    if (logTimer) clearInterval(logTimer)
    logTimer=null
  }
  const appendSummary=(chunk:string) => {
    const lines=chunk.split(/\r?\n/).map((line)=>line.trimEnd()).filter(Boolean)
    if (!lines.length) return
    state={...state,summaryLines:[...state.summaryLines,...lines].slice(-maxSummaryLines)}
    writeState(statePath,state)
  }
  const startLogTimer=() => {
    if (!logPath) return
    stopLogTimer()
    logTimer=setInterval(() => {
      if (state.status!=='running') { stopLogTimer(); return }
      const liveLog=tailLines(logPath,maxSummaryLines)
      if (!liveLog||!liveLog.length) return
      if (liveLog.join('\n')===state.summaryLines.join('\n')) return
      state={...state,summaryLines:liveLog}
      writeState(statePath,state)
    },800)
    if (typeof logTimer.unref==='function') logTimer.unref()
  }
  return {
    getState() {
      if (adopted) {
        state=readState(statePath,logPath,maxSummaryLines)
        if (state.status!=='running') adopted=false
      }
      return state
    },
    async start() {
      if (state.status==='running') return state
      const activeRun=++runId
      adopted=false
      state={
        status:'running',
        startedAt:new Date().toISOString(),
        finishedAt:null,
        summaryLines:[],
        exitCode:null,
        errorMessage:null,
        pid:null,
      }
      writeState(statePath,state)
      try {
        const nextChild=spawn(command,commandArgs,{
          cwd:rootDir,
          env:process.env,
          stdio:['ignore','pipe','pipe'],
        })
        child=nextChild
        state={...state,pid:nextChild.pid??null}
        writeState(statePath,state)
        startLogTimer()
        nextChild.stdout?.on('data',(chunk)=>appendSummary(String(chunk)))
        nextChild.stderr?.on('data',(chunk)=>appendSummary(String(chunk)))
        nextChild.on('error',(error) => {
          if (activeRun!==runId) return
          stopLogTimer()
          state={
            ...state,
            status:'error',
            finishedAt:new Date().toISOString(),
            exitCode:null,
            errorMessage:error.message,
            summaryLines:[...state.summaryLines,error.message].slice(-maxSummaryLines),
          }
          child=null
          writeState(statePath,state)
        })
        nextChild.on('close',(code) => {
          if (activeRun!==runId) return
          stopLogTimer()
          let onDisk:RestartTaskState|null=null
          try { onDisk=parseState(statePath) } catch {}
          if (onDisk&&onDisk.status!=='running'&&onDisk.finishedAt) {
            state=onDisk
          } else {
            state={
              ...state,
              status:code===0?'success':'error',
              finishedAt:new Date().toISOString(),
              exitCode:code,
              errorMessage:code===0?null:`Command exited with code ${code}`,
            }
          }
          child=null
          writeState(statePath,state)
        })
      } catch (error) {
        const message=error instanceof Error?error.message:'Unable to start task'
        state={...state,status:'error',finishedAt:new Date().toISOString(),errorMessage:message,summaryLines:[...state.summaryLines,message].slice(-maxSummaryLines)}
        writeState(statePath,state)
      }
      return state
    },
    async cancel() {
      if (state.status!=='running') return state
      runId+=1
      stopLogTimer()
      if (child) child.kill('SIGTERM')
      else if (pidAlive(state.pid)) { try { process.kill(state.pid as number,'SIGTERM') } catch {} }
      child=null
      state={...state,status:'cancelled',finishedAt:new Date().toISOString(),errorMessage:'Task cancelled'}
      writeState(statePath,state)
      return state
    },
  }
}
export function createUpdateTaskRunner(options:RestartTaskRunnerOptions={}):RestartTaskRunner {
  const statePath=options.statePath||path.join(process.env.TMUXGO_CONFIG_DIR?.trim()||path.join(os.homedir(),'.tmuxgo'),'update-task.json')
  const logPath=options.logPath||statePath.replace(/\.json$/,'.log')
  return createRestartTaskRunner({...options,statePath,logPath,command:'bash',args:['scripts/self-update.sh',statePath]})
}
