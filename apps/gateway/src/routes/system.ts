import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import fs from 'fs'
import { streamPerfMetrics } from '../lib/perf-metrics.js'
import { createRestartTaskRunner, type RestartTaskRunner } from '../lib/restart-task.js'
import { execHostShell } from '../lib/tmux-executor.js'
import { observeNetWindow, type NetWindowStats } from '../lib/net-window.js'

const execFileAsync = promisify(execFile)
const dependencyCommands = { tmux: { command: 'tmux', args: ['-V'] }, git: { command: 'git', args: ['--version'] }, python: { command: 'python3', args: ['--version'] }, rg: { command: 'rg', args: ['--version'] }, sshpass: { command: 'sshpass', args: ['-V'] } } as const
const remoteSystemScript = `import json,os,shutil,subprocess
def read_cpu():
 p=open('/proc/stat').readline().split()[1:];v=[int(x) for x in p];idle=v[3]+(v[4] if len(v)>4 else 0);total=sum(v);return round((total-idle)*100/total) if total else 0
def read_mem():
 v={};
 for line in open('/proc/meminfo'):
  k,n=line.split(':',1);v[k]=int(n.split()[0])
 t=v.get('MemTotal',0);a=v.get('MemAvailable',v.get('MemFree',0));return {'used':round((t-a)/1024),'total':round(t/1024)}
def read_disks():
 out=[]
 for line in subprocess.check_output(['df','-B1M','-P'],text=True).splitlines()[1:]:
  p=line.split(None,5)
  if len(p)==6 and int(p[1])>500 and not p[5].startswith('/snap') and not p[5].startswith('/boot/efi'):out.append({'mount':p[5],'used':int(p[2]),'total':int(p[1])})
 return out
def read_gpu():
 if not shutil.which('nvidia-smi'):return None
 try:
  p=subprocess.check_output(['nvidia-smi','--query-gpu=memory.used,memory.total','--format=csv,noheader,nounits'],text=True).strip().splitlines()[0].split(',');return {'used':int(p[0]),'total':int(p[1])}
 except:return None
def read_net():
 r=0;s=0
 for line in open('/proc/net/dev'):
  p=line.split(':',1)
  if len(p)!=2:continue
  name=p[0].strip()
  if name=='lo':continue
  v=p[1].split()
  if len(v)>=16:r+=int(v[0]);s+=int(v[8])
 return {'sentBytes':s,'recvBytes':r}
d={'tmux':bool(shutil.which('tmux')),'git':bool(shutil.which('git')),'python':bool(shutil.which('python3') or shutil.which('python')),'rg':bool(shutil.which('rg')),'sshpass':bool(shutil.which('sshpass'))}
print(json.dumps({'gpu':read_gpu(),'cpu':read_cpu(),'mem':read_mem(),'disks':read_disks(),'net':read_net(),'dependencies':d}))`

async function getGpuInfo(): Promise<{ used: number; total: number } | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ])
    const [used, total] = stdout.trim().split(',').map((s) => parseInt(s.trim(), 10))
    if (!isNaN(used) && !isNaN(total)) return { used, total }
  } catch {}
  return null
}

async function getCpuUsage(): Promise<number> {
  try {
    const stat = await fs.promises.readFile('/proc/stat', 'utf-8')
    const line = stat.split('\n')[0]
    const parts = line.split(/\s+/).slice(1).map(Number)
    const idle = parts[3] + (parts[4] || 0)
    const total = parts.reduce((a, b) => a + b, 0)
    return Math.round(((total - idle) / total) * 100)
  } catch {}
  const cpus = os.cpus()
  const total = cpus.reduce((a, c) => a + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0)
  const idle = cpus.reduce((a, c) => a + c.times.idle, 0)
  return Math.round(((total - idle) / total) * 100)
}

async function getMemory(): Promise<{ used: number; total: number }> {
  try {
    const info = await fs.promises.readFile('/proc/meminfo', 'utf-8')
    const get = (key: string) => {
      const m = info.match(new RegExp(`${key}:\\s+(\\d+)`))
      return m ? parseInt(m[1], 10) : 0
    }
    const total = get('MemTotal')
    const available = get('MemAvailable')
    return { used: Math.round((total - available) / 1024), total: Math.round(total / 1024) }
  } catch {}
  const total = Math.round(os.totalmem() / 1024 / 1024)
  const free = Math.round(os.freemem() / 1024 / 1024)
  return { used: total - free, total }
}

async function getDisk(): Promise<{ mount: string; used: number; total: number }[]> {
  try {
    const { stdout } = await execFileAsync('df', ['-B1M'])
    const lines = stdout.trim().split('\n').slice(1)
    return lines
      .map((line) => {
        const cols = line.trim().split(/\s+/)
        const mount = cols[5]
        const total = parseInt(cols[1], 10)
        const used = parseInt(cols[2], 10)
        return { mount, used, total }
      })
      .filter((d) => d.total > 500 && !d.mount.startsWith('/snap') && !d.mount.startsWith('/boot/efi'))
  } catch {}
  return []
}
async function getNetwork(): Promise<{ sentBytes: number; recvBytes: number }> {
  try {
    const content = await fs.promises.readFile('/proc/net/dev', 'utf-8')
    const lines = content.trim().split('\n').slice(2)
    let recvBytes = 0
    let sentBytes = 0
    for (const line of lines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex === -1) continue
      const name = line.slice(0, colonIndex).trim()
      if (name === 'lo') continue
      const parts = line.slice(colonIndex + 1).trim().split(/\s+/).map(Number)
      if (parts.length >= 16) {
        recvBytes += parts[0] || 0
        sentBytes += parts[8] || 0
      }
    }
    return { sentBytes, recvBytes }
  } catch {}
  return { sentBytes: 0, recvBytes: 0 }
}

function safeNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function getSafeStreamMetrics() {
  return {
    outputBytes: safeNumber(streamPerfMetrics.outputBytes),
    outputChunks: safeNumber(streamPerfMetrics.outputChunks),
    outputFlushes: safeNumber(streamPerfMetrics.outputFlushes),
    outputResyncRequests: safeNumber(streamPerfMetrics.outputResyncRequests),
    outputResyncCompleted: safeNumber(streamPerfMetrics.outputResyncCompleted),
    droppedOutputChars: safeNumber(streamPerfMetrics.droppedOutputChars),
    sanitizeCalls: safeNumber(streamPerfMetrics.sanitizeCalls),
    sanitizeChars: safeNumber(streamPerfMetrics.sanitizeChars),
    attachRequests: safeNumber(streamPerfMetrics.attachRequests),
    snapshotRequests: safeNumber(streamPerfMetrics.snapshotRequests),
    resizeRequests: safeNumber(streamPerfMetrics.resizeRequests),
    paneScrollRequests: safeNumber(streamPerfMetrics.paneScrollRequests),
    copyModeCancelRequests: safeNumber(streamPerfMetrics.copyModeCancelRequests),
    inputMessages: safeNumber(streamPerfMetrics.inputMessages),
    backpressureSignals: safeNumber(streamPerfMetrics.backpressureSignals),
    profileUpdates: safeNumber(streamPerfMetrics.profileUpdates),
    deferredFlushes: safeNumber(streamPerfMetrics.deferredFlushes),
    socketBufferedBytes: safeNumber(streamPerfMetrics.socketBufferedBytes),
    activeClients: safeNumber(streamPerfMetrics.activeClients),
    activeProfile: streamPerfMetrics.activeProfile === 'background' || streamPerfMetrics.activeProfile === 'mobile' ? streamPerfMetrics.activeProfile : 'foreground',
    activeFlushInterval: safeNumber(streamPerfMetrics.activeFlushInterval),
    activeMaxChars: safeNumber(streamPerfMetrics.activeMaxChars),
    compressFrames: safeNumber(streamPerfMetrics.compressFrames),
    compressBytesIn: safeNumber(streamPerfMetrics.compressBytesIn),
    compressBytesOut: safeNumber(streamPerfMetrics.compressBytesOut),
    cellSnapshots: safeNumber(streamPerfMetrics.cellSnapshots),
    cellDiffs: safeNumber(streamPerfMetrics.cellDiffs),
    cellFallbackAnsi: safeNumber(streamPerfMetrics.cellFallbackAnsi),
    cellDirtyCells: safeNumber(streamPerfMetrics.cellDirtyCells),
    redrawRequests: safeNumber(streamPerfMetrics.redrawRequests),
    droppedDuplicateChunks: safeNumber(streamPerfMetrics.droppedDuplicateChunks),
  }
}
async function getDependencies() {
  const entries = await Promise.all(Object.entries(dependencyCommands).map(async ([name, dependency]) => {
    if (name === 'python') {
      try {
        await execFileAsync('python3', ['--version'])
        return [name, true] as const
      } catch {
        try {
          await execFileAsync('python', ['--version'])
          return [name, true] as const
        } catch {
          return [name, false] as const
        }
      }
    }
    try {
      await execFileAsync(dependency.command, [...dependency.args])
      return [name, true] as const
    } catch {
      return [name, false] as const
    }
  }))
  return Object.fromEntries(entries) as Record<keyof typeof dependencyCommands, boolean>
}
function quoteShellValue(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
function normalizeHostSystemInfo(hostId: string, value: any) {
  const dependencies = value?.dependencies && typeof value.dependencies === 'object' ? value.dependencies : {}
  const gpu = value?.gpu && Number.isFinite(Number(value.gpu.used)) && Number.isFinite(Number(value.gpu.total)) ? { used: safeNumber(value.gpu.used), total: safeNumber(value.gpu.total) } : null
  const disks = Array.isArray(value?.disks) ? value.disks.filter((disk: any) => disk && typeof disk.mount === 'string').map((disk: any) => ({ mount: disk.mount, used: safeNumber(disk.used), total: safeNumber(disk.total) })) : []
  const counters = value?.net && typeof value.net === 'object' ? { sentBytes: Math.max(0, safeNumber(value.net.sentBytes)), recvBytes: Math.max(0, safeNumber(value.net.recvBytes)) } : { sentBytes: 0, recvBytes: 0 }
  const net = withNetWindow(hostId, counters)
  return { hostId, gpu, cpu: Math.max(0, Math.min(100, safeNumber(value?.cpu))), mem: { used: safeNumber(value?.mem?.used), total: safeNumber(value?.mem?.total) }, disks, net, dependencies: { tmux: dependencies.tmux === true, git: dependencies.git === true, python: dependencies.python === true, rg: dependencies.rg === true, sshpass: dependencies.sshpass === true }, stream: getSafeStreamMetrics() }
}
function withNetWindow(hostId: string, net: { sentBytes: number; recvBytes: number }): NetWindowStats {
  return observeNetWindow(hostId, net)
}
async function getLocalSystemInfo() {
  const [gpu, cpu, mem, disks, net, dependencies] = await Promise.all([getGpuInfo(), getCpuUsage(), getMemory(), getDisk(), getNetwork(), getDependencies()])
  return { hostId: 'local', gpu, cpu, mem, disks, net: withNetWindow('local', net), dependencies, stream: getSafeStreamMetrics() }
}
async function getRemoteSystemInfo(hostId: string) {
  const fallback = `has(){ command -v "$1" >/dev/null 2>&1 && printf true || printf false; }; printf '{"gpu":null,"cpu":0,"mem":{"used":0,"total":0},"disks":[],"net":{"sentBytes":0,"recvBytes":0},"dependencies":{"tmux":%s,"git":%s,"python":false,"rg":%s,"sshpass":%s}}' "$(has tmux)" "$(has git)" "$(has rg)" "$(has sshpass)"`
  const command = `if command -v python3 >/dev/null 2>&1; then exec python3 -c ${quoteShellValue(remoteSystemScript)}; elif command -v python >/dev/null 2>&1; then exec python -c ${quoteShellValue(remoteSystemScript)}; else ${fallback}; fi`
  const { stdout } = await execHostShell(hostId, command, { timeoutMs: 15000 })
  return normalizeHostSystemInfo(hostId, JSON.parse(stdout))
}
async function getSystemInfo(hostId: string) {
  if (hostId === 'local') return getLocalSystemInfo()
  return getRemoteSystemInfo(hostId)
}

interface SystemRoutesOptions {
  createRestartRunner?: () => RestartTaskRunner
}
function getRestartTask(runner: RestartTaskRunner) {
  const state=runner.getState()
  return {
    id:'restart-rebuild',
    type:'restart-rebuild',
    title:'Restart + Rebuild',
    ...state,
    cancellable:state.status==='running',
    retryable:state.status==='error'||state.status==='cancelled',
  }
}
let localNetSampleTimer: NodeJS.Timeout | null = null
function ensureLocalNetSampler() {
  if (localNetSampleTimer) return
  localNetSampleTimer = setInterval(() => {
    void getNetwork().then((net) => {
      withNetWindow('local', net)
    }).catch(() => {})
  }, 60_000)
  if (typeof localNetSampleTimer.unref === 'function') localNetSampleTimer.unref()
}
export async function systemRoutes(fastify: FastifyInstance, options: SystemRoutesOptions = {}) {
  const restartRunner=(options.createRestartRunner||createRestartTaskRunner)()
  ensureLocalNetSampler()
  fastify.get('/system', async () => {
    try {
      return await getLocalSystemInfo()
    } catch {
      return {
        hostId: 'local',
        gpu: null,
        cpu: 0,
        mem: { used: 0, total: 0 },
        disks: [],
        net: { sentBytes: 0, recvBytes: 0, daySentBytes: 0, dayRecvBytes: 0, last24hSentBytes: 0, last24hRecvBytes: 0, trackedMs: 0, windowMs: 0 },
        dependencies: { tmux: false, git: false, python: false, rg: false, sshpass: false },
        stream: getSafeStreamMetrics(),
      }
    }
  })
  fastify.get('/hosts/:hostId/system', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return getSystemInfo(hostId)
  })
  fastify.get('/system/tasks', async () => ({ tasks:[getRestartTask(restartRunner)] }))
  fastify.get('/system/tasks/:taskId', async (request, reply) => {
    const { taskId }=request.params as { taskId:string }
    if (taskId!=='restart-rebuild') return reply.status(404).send({ message:'Task not found',code:'TASK_NOT_FOUND' })
    return getRestartTask(restartRunner)
  })
  fastify.post('/system/tasks/:taskId/cancel', async (request, reply) => {
    const { taskId }=request.params as { taskId:string }
    if (taskId!=='restart-rebuild') return reply.status(404).send({ message:'Task not found',code:'TASK_NOT_FOUND' })
    await restartRunner.cancel()
    return getRestartTask(restartRunner)
  })
  fastify.post('/system/tasks/:taskId/retry', async (request, reply) => {
    const { taskId }=request.params as { taskId:string }
    if (taskId!=='restart-rebuild') return reply.status(404).send({ message:'Task not found',code:'TASK_NOT_FOUND' })
    await restartRunner.start()
    return getRestartTask(restartRunner)
  })
  fastify.get('/system/restart-rebuild', async () => restartRunner.getState())
  fastify.post('/system/restart-rebuild', async () => restartRunner.start())
}
