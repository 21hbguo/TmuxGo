import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync=promisify(execFile)
const [stateArg,paneArg,labelArg]=process.argv.slice(2)
const state=stateArg||''
const paneId=paneArg||''
const label=labelArg||''
const validStates=new Set(['working','waiting','done','failed','clear'])
async function tmux(args:string[]) {
  const { stdout }=await execFileAsync('tmux',args)
  return stdout
}
async function resolveTarget() {
  if (paneId) return paneId
  const stdout=await tmux(['display-message','-p','#{pane_id}'])
  return stdout.trim()
}
async function main() {
  if (!validStates.has(state)) {
    console.error('usage: npx tsx scripts/tmux-pane-state.ts <working|waiting|done|failed|clear> [paneId] [label]')
    process.exit(1)
  }
  const target=await resolveTarget()
  if (state==='clear') {
    await tmux(['set-option','-pt',target,'@task_state',''])
    await tmux(['set-option','-pt',target,'@task_label',''])
    await tmux(['set-option','-pt',target,'@task_updated_at','0'])
    console.log(`cleared ${target}`)
    return
  }
  const now=`${Math.floor(Date.now()/1000)}`
  await tmux(['set-option','-pt',target,'@task_state',state])
  await tmux(['set-option','-pt',target,'@task_updated_at',now])
  if (label) await tmux(['set-option','-pt',target,'@task_label',label])
  console.log(`${target} ${state}${label?` ${label}`:''}`)
}
main().catch((err) => {
  console.error(err instanceof Error?err.message:String(err))
  process.exit(1)
})
