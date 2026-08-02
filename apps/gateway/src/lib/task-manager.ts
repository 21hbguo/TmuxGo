import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

export type BackgroundTaskStatus='running'|'success'|'error'|'cancelled'
export interface BackgroundTask {
  id:string
  type:string
  title:string
  status:BackgroundTaskStatus
  startedAt:string
  finishedAt:string|null
  summaryLines:string[]
  exitCode:number|null
  errorMessage:string|null
  errorCode:string|null
  progress:number|null
  speedBytesPerSecond:number|null
  resultMessage:string|null
  result:unknown|null
  attempt:number
  cancellable:boolean
  retryable:boolean
}
interface StoredTask extends Omit<BackgroundTask,'cancellable'|'retryable'> {
  input:unknown
}
export interface TaskExecutionContext {
  signal:AbortSignal
  appendLog:(value:string)=>void
  setProgress:(progress:number|null,speedBytesPerSecond?:number|null)=>void
}
export interface TaskExecutionResult {
  message?:string
  exitCode?:number
  result?:unknown
}
type TaskHandler=(input:unknown,context:TaskExecutionContext)=>Promise<TaskExecutionResult|void>
interface TaskManagerOptions {
  statePath?:string
  maxTasks?:number
  maxSummaryLines?:number
}
function getStatePath(options:TaskManagerOptions) {
  if (options.statePath) return options.statePath
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim()||path.join(os.homedir(),'.tmuxgo'),'tasks.json')
}
function readTasks(statePath:string) {
  try {
    const parsed=JSON.parse(readFileSync(statePath,'utf8'))
    if (!Array.isArray(parsed?.tasks)) return [] as StoredTask[]
    return parsed.tasks.filter((task:unknown):task is StoredTask=>!!task&&typeof task==='object'&&typeof (task as StoredTask).id==='string'&&typeof (task as StoredTask).type==='string'&&typeof (task as StoredTask).title==='string'&&['running','success','error','cancelled'].includes((task as StoredTask).status)).map((task:StoredTask)=>({
      id:task.id,
      type:task.type,
      title:task.title,
      status:task.status,
      startedAt:typeof task.startedAt==='string'?task.startedAt:new Date().toISOString(),
      finishedAt:typeof task.finishedAt==='string'?task.finishedAt:null,
      summaryLines:Array.isArray(task.summaryLines)?task.summaryLines.filter((line):line is string=>typeof line==='string').slice(-100):[],
      exitCode:typeof task.exitCode==='number'?task.exitCode:null,
      errorMessage:typeof task.errorMessage==='string'?task.errorMessage:null,
      errorCode:typeof task.errorCode==='string'?task.errorCode:null,
      progress:typeof task.progress==='number'?task.progress:null,
      speedBytesPerSecond:typeof task.speedBytesPerSecond==='number'?task.speedBytesPerSecond:null,
      resultMessage:typeof task.resultMessage==='string'?task.resultMessage:null,
      result:'result' in task?task.result:null,
      attempt:typeof task.attempt==='number'&&task.attempt>0?task.attempt:1,
      input:task.input,
    }))
  } catch {
    return [] as StoredTask[]
  }
}
function writeTasks(statePath:string,tasks:StoredTask[]) {
  try {
    mkdirSync(path.dirname(statePath),{recursive:true,mode:0o700})
    const tempPath=`${statePath}.tmp-${process.pid}`
    writeFileSync(tempPath,`${JSON.stringify({tasks})}\n`,{encoding:'utf8',mode:0o600})
    chmodSync(tempPath,0o600)
    renameSync(tempPath,statePath)
    chmodSync(statePath,0o600)
  } catch {}
}
export class TaskManager {
  private readonly statePath:string
  private readonly maxTasks:number
  private readonly maxSummaryLines:number
  private readonly tasks=new Map<string,StoredTask>()
  private readonly handlers=new Map<string,TaskHandler>()
  private readonly controllers=new Map<string,AbortController>()
  constructor(options:TaskManagerOptions={}) {
    this.statePath=getStatePath(options)
    this.maxTasks=options.maxTasks||100
    this.maxSummaryLines=options.maxSummaryLines||100
    let changed=false
    for (const task of readTasks(this.statePath)) {
      if (task.status==='running') {
        task.status='error'
        task.finishedAt=new Date().toISOString()
        task.exitCode=null
        task.errorCode='TASK_INTERRUPTED'
        task.errorMessage='Task interrupted by Gateway restart'
        task.summaryLines=[...task.summaryLines,task.errorMessage].slice(-this.maxSummaryLines)
        changed=true
      }
      this.tasks.set(task.id,task)
    }
    if (changed) this.persist()
  }
  register(type:string,handler:TaskHandler) {
    this.handlers.set(type,handler)
  }
  list() {
    return Array.from(this.tasks.values()).sort((left,right)=>right.startedAt.localeCompare(left.startedAt)).map((task)=>this.toResponse(task))
  }
  get(id:string) {
    const task=this.tasks.get(id)
    return task?this.toResponse(task):null
  }
  async start({type,title,input}:{type:string;title:string;input:unknown}) {
    if (!this.handlers.has(type)) throw new Error(`Task type "${type}" is unavailable`)
    const existing=Array.from(this.tasks.values()).find((task)=>task.status==='running'&&task.type===type&&JSON.stringify(task.input)===JSON.stringify(input))
    if (existing) return this.toResponse(existing)
    const task:StoredTask={
      id:randomUUID(),
      type,
      title,
      status:'running',
      startedAt:new Date().toISOString(),
      finishedAt:null,
      summaryLines:[],
      exitCode:null,
      errorMessage:null,
      errorCode:null,
      progress:null,
      speedBytesPerSecond:null,
      resultMessage:null,
      result:null,
      attempt:1,
      input,
    }
    this.tasks.set(task.id,task)
    this.persist()
    void this.run(task.id)
    return this.toResponse(task)
  }
  async cancel(id:string) {
    const task=this.tasks.get(id)
    if (!task) return null
    if (task.status!=='running') return this.toResponse(task)
    task.status='cancelled'
    task.finishedAt=new Date().toISOString()
    task.errorCode='TASK_CANCELLED'
    task.errorMessage='Task cancelled'
    task.summaryLines=[...task.summaryLines,task.errorMessage].slice(-this.maxSummaryLines)
    this.controllers.get(id)?.abort()
    this.persist()
    return this.toResponse(task)
  }
  async retry(id:string) {
    const task=this.tasks.get(id)
    if (!task) return null
    if (task.status==='running'||!this.handlers.has(task.type)) return this.toResponse(task)
    task.status='running'
    task.startedAt=new Date().toISOString()
    task.finishedAt=null
    task.summaryLines=[]
    task.exitCode=null
    task.errorMessage=null
    task.errorCode=null
    task.progress=null
    task.speedBytesPerSecond=null
    task.resultMessage=null
    task.result=null
    task.attempt+=1
    this.persist()
    void this.run(task.id)
    return this.toResponse(task)
  }
  private async run(id:string) {
    const task=this.tasks.get(id)
    if (!task||task.status!=='running') return
    const handler=this.handlers.get(task.type)
    if (!handler) return
    const controller=new AbortController()
    this.controllers.set(id,controller)
    const appendLog=(value:string) => {
      if (task.status!=='running') return
      const lines=value.split(/\r?\n/).map((line)=>line.trimEnd()).filter(Boolean)
      if (!lines.length) return
      task.summaryLines=[...task.summaryLines,...lines].slice(-this.maxSummaryLines)
      this.persist()
    }
    const setProgress=(progress:number|null,speedBytesPerSecond:number|null=null) => {
      if (task.status!=='running') return
      task.progress=progress===null?null:Math.max(0,Math.min(100,Math.round(progress)))
      task.speedBytesPerSecond=speedBytesPerSecond===null?null:Math.max(0,speedBytesPerSecond)
      this.persist()
    }
    try {
      const result=await handler(task.input,{signal:controller.signal,appendLog,setProgress})
      if (task.status!=='running') return
      if (result?.message) appendLog(result.message)
      task.status='success'
      task.finishedAt=new Date().toISOString()
      task.exitCode=result?.exitCode??0
      task.progress=100
      task.resultMessage=result?.message||null
      task.result=result?.result??null
    } catch (error) {
      if (task.status!=='running') return
      const message=error instanceof Error?error.message:'Task failed'
      const code=typeof (error as { code?: unknown })?.code==='string'&&(error as { code: string }).code.match(/^[A-Z][A-Z0-9_]{2,63}$/)?(error as { code: string }).code:message==='Host key verification failed'?'HOST_KEY_ERROR':message==='SSH authentication failed'||message==='SSH private key is unavailable'?'AUTHENTICATION_ERROR':message==='SSH connection timed out'||message==='SSH network is unreachable'?'NETWORK_ERROR':message.includes('Permission denied')?'PERMISSION_DENIED':message.includes('not found')?'NOT_FOUND':'TASK_FAILED'
      appendLog(controller.signal.aborted?'Task cancelled':message)
      task.status=controller.signal.aborted?'cancelled':'error'
      task.finishedAt=new Date().toISOString()
      task.exitCode=null
      task.errorCode=controller.signal.aborted?'TASK_CANCELLED':code
      task.errorMessage=controller.signal.aborted?'Task cancelled':message
    } finally {
      this.controllers.delete(id)
      this.persist()
    }
  }
  private toResponse(task:StoredTask):BackgroundTask {
    return {
      id:task.id,
      type:task.type,
      title:task.title,
      status:task.status,
      startedAt:task.startedAt,
      finishedAt:task.finishedAt,
      summaryLines:task.summaryLines,
      exitCode:task.exitCode,
      errorMessage:task.errorMessage,
      errorCode:task.errorCode,
      progress:task.progress,
      speedBytesPerSecond:task.speedBytesPerSecond,
      resultMessage:task.resultMessage,
      result:task.result,
      attempt:task.attempt,
      cancellable:task.status==='running',
      retryable:(task.status==='error'||task.status==='cancelled')&&this.handlers.has(task.type),
    }
  }
  private persist() {
    const tasks=Array.from(this.tasks.values()).sort((left,right)=>right.startedAt.localeCompare(left.startedAt)).slice(0,this.maxTasks)
    const ids=new Set(tasks.map((task)=>task.id))
    for (const id of this.tasks.keys()) if (!ids.has(id)) this.tasks.delete(id)
    writeTasks(this.statePath,tasks)
  }
}
export const taskManager=new TaskManager()
