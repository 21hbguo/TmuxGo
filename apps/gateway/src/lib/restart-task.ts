import { spawn } from 'child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
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
}
const defaultState=():RestartTaskState=>({
  status:'idle',
  startedAt:null,
  finishedAt:null,
  summaryLines:[],
  exitCode:null,
  errorMessage:null,
})
function getStatePath(options: RestartTaskRunnerOptions) {
  if (options.statePath) return options.statePath
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'restart-task.json')
}
function readState(statePath: string): RestartTaskState {
  try {
    const parsed=JSON.parse(readFileSync(statePath,'utf8')) as Partial<RestartTaskState>
    if (parsed.status!=='idle'&&parsed.status!=='running'&&parsed.status!=='success'&&parsed.status!=='error'&&parsed.status!=='cancelled') return defaultState()
    const state:RestartTaskState={
      status:parsed.status,
      startedAt:typeof parsed.startedAt==='string'?parsed.startedAt:null,
      finishedAt:typeof parsed.finishedAt==='string'?parsed.finishedAt:null,
      summaryLines:Array.isArray(parsed.summaryLines)?parsed.summaryLines.filter((line):line is string=>typeof line==='string').slice(-20):[],
      exitCode:typeof parsed.exitCode==='number'?parsed.exitCode:null,
      errorMessage:typeof parsed.errorMessage==='string'?parsed.errorMessage:null,
    }
    if (state.status!=='running') return state
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
  let state=readState(statePath)
  if (state.status==='error'&&state.errorMessage==='Task interrupted by Gateway restart') writeState(statePath,state)
  let child:ReturnType<typeof spawn>|null=null
  let runId=0
  const appendSummary=(chunk:string) => {
    const lines=chunk.split(/\r?\n/).map((line)=>line.trimEnd()).filter(Boolean)
    if (!lines.length) return
    state={...state,summaryLines:[...state.summaryLines,...lines].slice(-maxSummaryLines)}
    writeState(statePath,state)
  }
  return {
    getState() {
      return state
    },
    async start() {
      if (state.status==='running') return state
      const activeRun=++runId
      state={
        status:'running',
        startedAt:new Date().toISOString(),
        finishedAt:null,
        summaryLines:[],
        exitCode:null,
        errorMessage:null,
      }
      writeState(statePath,state)
      try {
        const nextChild=spawn('./start.sh',['--restart','--rebuild','--preserve-tmux'],{
          cwd:rootDir,
          env:process.env,
          stdio:['ignore','pipe','pipe'],
        })
        child=nextChild
        nextChild.stdout?.on('data',(chunk)=>appendSummary(String(chunk)))
        nextChild.stderr?.on('data',(chunk)=>appendSummary(String(chunk)))
        nextChild.on('error',(error) => {
          if (activeRun!==runId) return
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
          state={
            ...state,
            status:code===0?'success':'error',
            finishedAt:new Date().toISOString(),
            exitCode:code,
            errorMessage:code===0?null:`Command exited with code ${code}`,
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
      child?.kill('SIGTERM')
      child=null
      state={...state,status:'cancelled',finishedAt:new Date().toISOString(),errorMessage:'Task cancelled'}
      writeState(statePath,state)
      return state
    },
  }
}
