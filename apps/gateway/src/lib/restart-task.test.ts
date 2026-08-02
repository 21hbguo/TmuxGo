import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRestartTaskRunner } from './restart-task.js'

test('restart task starts without waiting for completion and persists cancellation', async (t) => {
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-restart-task-'))
  const statePath=path.join(rootDir,'restart-task.json')
  await writeFile(path.join(rootDir,'start.sh'),'#!/bin/sh\nprintf started\nsleep 5\n')
  await chmod(path.join(rootDir,'start.sh'),0o700)
  t.after(async () => {
    await rm(rootDir,{recursive:true,force:true})
  })
  const runner=createRestartTaskRunner({rootDir,statePath})
  const started=await runner.start()
  assert.equal(started.status,'running')
  const cancelled=await runner.cancel()
  assert.equal(cancelled.status,'cancelled')
  const stored=JSON.parse(await readFile(statePath,'utf8'))
  assert.equal(stored.status,'cancelled')
})

test('restart task marks persisted running task as interrupted', async (t) => {
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'tmuxgo-restart-task-'))
  const statePath=path.join(rootDir,'restart-task.json')
  await writeFile(statePath,JSON.stringify({status:'running',startedAt:'2026-08-02T00:00:00.000Z',finishedAt:null,summaryLines:['starting'],exitCode:null,errorMessage:null}))
  t.after(async () => {
    await rm(rootDir,{recursive:true,force:true})
  })
  const state=createRestartTaskRunner({rootDir,statePath}).getState()
  assert.equal(state.status,'error')
  assert.equal(state.errorMessage,'Task interrupted by Gateway restart')
  const stored=JSON.parse(await readFile(statePath,'utf8'))
  assert.equal(stored.status,'error')
})
