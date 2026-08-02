import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { TaskManager } from './task-manager.js'

async function waitForTask(manager:TaskManager,id:string) {
  for (let attempt=0;attempt<50;attempt++) {
    const task=manager.get(id)
    if (task&&task.status!=='running') return task
    await new Promise((resolve)=>setTimeout(resolve,10))
  }
  throw new Error('Task did not finish')
}
test('persists task logs and allows failed tasks to retry',async(t)=>{
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-tasks-'))
  const statePath=path.join(rootDir,'tasks.json')
  t.after(async()=>{
    await rm(rootDir,{recursive:true,force:true})
  })
  let runs=0
  const manager=new TaskManager({statePath})
  manager.register('example',async(_input,context)=>{
    context.appendLog('started')
    context.setProgress(50,1024)
    runs+=1
    if (runs===1) throw new Error('first run failed')
    return {message:'completed'}
  })
  const started=await manager.start({type:'example',title:'Example',input:{value:true}})
  const failed=await waitForTask(manager,started.id)
  assert.equal(failed.status,'error')
  assert.equal(failed.errorCode,'TASK_FAILED')
  assert.equal(failed.summaryLines.at(-1),'first run failed')
  const retried=await manager.retry(started.id)
  assert.equal(retried?.status,'running')
  const completed=await waitForTask(manager,started.id)
  assert.equal(completed.status,'success')
  assert.equal(completed.attempt,2)
  assert.equal(completed.progress,100)
  assert.equal(completed.resultMessage,'completed')
  const stored=JSON.parse(await readFile(statePath,'utf8'))
  assert.equal(stored.tasks[0].status,'success')
})
test('cancels a running task',async(t)=>{
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-tasks-'))
  t.after(async()=>{
    await rm(rootDir,{recursive:true,force:true})
  })
  const manager=new TaskManager({statePath:path.join(rootDir,'tasks.json')})
  let started:()=>void=()=>{}
  const running=new Promise<void>((resolve)=>{
    started=resolve
  })
  manager.register('wait',async(_input,context)=>{
    started()
    await new Promise<void>((_resolve,reject)=>context.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))
  })
  const task=await manager.start({type:'wait',title:'Wait',input:{}})
  await running
  const cancelled=await manager.cancel(task.id)
  assert.equal(cancelled?.status,'cancelled')
  assert.equal(cancelled?.cancellable,false)
  assert.equal(cancelled?.retryable,true)
})
test('marks persisted running tasks as interrupted',async(t)=>{
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-tasks-'))
  const statePath=path.join(rootDir,'tasks.json')
  await writeFile(statePath,JSON.stringify({tasks:[{id:'interrupted',type:'example',title:'Example',status:'running',startedAt:'2026-08-02T00:00:00.000Z',finishedAt:null,summaryLines:['started'],exitCode:null,errorMessage:null,errorCode:null,progress:null,speedBytesPerSecond:null,resultMessage:null,attempt:1,input:{}}]}))
  t.after(async()=>{
    await rm(rootDir,{recursive:true,force:true})
  })
  const task=new TaskManager({statePath}).get('interrupted')
  assert.equal(task?.status,'error')
  assert.equal(task?.errorCode,'TASK_INTERRUPTED')
  assert.equal(task?.errorMessage,'Task interrupted by Gateway restart')
})
