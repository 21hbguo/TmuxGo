import { spawn } from 'child_process'
import path from 'path'
export type RestartTaskStatus='idle'|'running'|'success'|'error'
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
}
interface RestartTaskRunnerOptions {
  rootDir?: string
  maxSummaryLines?: number
}
const defaultState=():RestartTaskState=>({
  status:'idle',
  startedAt:null,
  finishedAt:null,
  summaryLines:[],
  exitCode:null,
  errorMessage:null,
})
export function createRestartTaskRunner(options:RestartTaskRunnerOptions={}):RestartTaskRunner {
  const rootDir=options.rootDir||path.resolve(process.cwd(),'..','..')
  const maxSummaryLines=options.maxSummaryLines||20
  let state=defaultState()
  let runningPromise:Promise<RestartTaskState>|null=null
  const appendSummary=(chunk:string) => {
    const lines=chunk.split(/\r?\n/).map((line)=>line.trimEnd()).filter(Boolean)
    if (!lines.length) return
    state={...state,summaryLines:[...state.summaryLines,...lines].slice(-maxSummaryLines)}
  }
  return {
    getState() {
      return state
    },
    async start() {
      if (state.status==='running'&&runningPromise) return runningPromise
      state={
        status:'running',
        startedAt:new Date().toISOString(),
        finishedAt:null,
        summaryLines:[],
        exitCode:null,
        errorMessage:null,
      }
      runningPromise=new Promise<RestartTaskState>((resolve) => {
        const child=spawn('./start.sh',['--restart','--rebuild','--preserve-tmux'],{
          cwd:rootDir,
          env:process.env,
          stdio:['ignore','pipe','pipe'],
        })
        child.stdout.on('data',(chunk)=>appendSummary(String(chunk)))
        child.stderr.on('data',(chunk)=>appendSummary(String(chunk)))
        child.on('error',(error) => {
          state={
            ...state,
            status:'error',
            finishedAt:new Date().toISOString(),
            exitCode:null,
            errorMessage:error.message,
            summaryLines:[...state.summaryLines,error.message].slice(-maxSummaryLines),
          }
          runningPromise=null
          resolve(state)
        })
        child.on('close',(code) => {
          state={
            ...state,
            status:code===0?'success':'error',
            finishedAt:new Date().toISOString(),
            exitCode:code,
            errorMessage:code===0?null:`Command exited with code ${code}`,
          }
          runningPromise=null
          resolve(state)
        })
      })
      return runningPromise
    },
  }
}
