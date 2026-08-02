import assert from 'node:assert/strict'
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import Fastify from 'fastify'
import test from 'node:test'
import { TaskManager } from '../lib/task-manager.js'
import { gitRoutes } from './git.js'

const execFileAsync=promisify(execFile)
async function runGit(repository:string,args:string[]) {
  await execFileAsync('git',['-C',repository,...args])
}
async function waitForTask(manager:TaskManager,id:string) {
  for (let attempt=0;attempt<50;attempt++) {
    const task=manager.get(id)
    if (task&&task.status!=='running') return task
    await new Promise((resolve)=>setTimeout(resolve,10))
  }
  throw new Error('Task did not finish')
}
test('runs commit and merge as persistent background tasks',async(t)=>{
  const configDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-git-route-'))
  const repository=path.join(configDir,'repository')
  const previousConfigDir=process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR=configDir
  t.after(async()=>{
    if (previousConfigDir===undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR=previousConfigDir
    await rm(configDir,{recursive:true,force:true})
  })
  await runGit(configDir,['init','-b','main','repository'])
  await runGit(repository,['config','user.email','test@tmuxgo.dev'])
  await runGit(repository,['config','user.name','TmuxGo Test'])
  await writeFile(path.join(repository,'base.txt'),'base\n')
  await runGit(repository,['add','base.txt'])
  await runGit(repository,['commit','-m','Initial commit'])
  const manager=new TaskManager({statePath:path.join(configDir,'tasks.json')})
  const fastify=Fastify()
  await fastify.register(gitRoutes,{taskManager:manager})
  await writeFile(path.join(repository,'commit.txt'),'commit\n')
  await runGit(repository,['add','commit.txt'])
  const commitResponse=await fastify.inject({method:'POST',url:'/hosts/local/git/commit',payload:{path:repository,message:'Background commit',background:true}})
  assert.equal(commitResponse.statusCode,202)
  const commitTaskId=(commitResponse.json() as {task:{id:string}}).task.id
  const commitTask=await waitForTask(manager,commitTaskId)
  assert.equal(commitTask.status,'success')
  assert.equal(commitTask.type,'git-commit')
  assert.equal(typeof (commitTask.result as {hash?:unknown})?.hash,'string')
  await runGit(repository,['checkout','-b','feature'])
  await writeFile(path.join(repository,'feature.txt'),'feature\n')
  await runGit(repository,['add','feature.txt'])
  await runGit(repository,['commit','-m','Feature'])
  await runGit(repository,['checkout','main'])
  const mergeResponse=await fastify.inject({method:'POST',url:'/hosts/local/git/merge',payload:{path:repository,branch:'feature',background:true}})
  assert.equal(mergeResponse.statusCode,202)
  const mergeTask=await waitForTask(manager,(mergeResponse.json() as {task:{id:string}}).task.id)
  assert.equal(mergeTask.status,'success')
  assert.equal(mergeTask.type,'git-merge')
  await fastify.close()
})
test('does not expose failed pull and push tasks for automatic retry',async(t)=>{
  const configDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-git-retry-'))
  const repository=path.join(configDir,'repository')
  t.after(async()=>{
    await rm(configDir,{recursive:true,force:true})
  })
  await runGit(configDir,['init','-b','main','repository'])
  const manager=new TaskManager({statePath:path.join(configDir,'tasks.json')})
  const fastify=Fastify()
  await fastify.register(gitRoutes,{taskManager:manager})
  const pullResponse=await fastify.inject({method:'POST',url:'/hosts/local/git/pull',payload:{path:repository,background:true}})
  assert.equal(pullResponse.statusCode,202)
  const pullTask=await waitForTask(manager,(pullResponse.json() as {task:{id:string}}).task.id)
  assert.equal(pullTask.status,'error')
  assert.equal(pullTask.retryable,false)
  const pushResponse=await fastify.inject({method:'POST',url:'/hosts/local/git/push',payload:{path:repository,background:true}})
  assert.equal(pushResponse.statusCode,202)
  const pushTask=await waitForTask(manager,(pushResponse.json() as {task:{id:string}}).task.id)
  assert.equal(pushTask.status,'error')
  assert.equal(pushTask.retryable,false)
  await fastify.close()
})
