import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import fs from 'fs'
import { streamPerfMetrics } from '../lib/perf-metrics.js'
import { createRestartTaskRunner, type RestartTaskRunner } from '../lib/restart-task.js'
import { execHostShell } from '../lib/tmux-executor.js'

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
d={'tmux':bool(shutil.which('tmux')),'git':bool(shutil.which('git')),'python':bool(shutil.which('python3') or shutil.which('python')),'rg':bool(shutil.which('rg')),'sshpass':bool(shutil.which('sshpass'))}
print(json.dumps({'gpu':read_gpu(),'cpu':read_cpu(),'mem':read_mem(),'disks':read_disks(),'dependencies':d}))`

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
  return { hostId, gpu, cpu: Math.max(0, Math.min(100, safeNumber(value?.cpu))), mem: { used: safeNumber(value?.mem?.used), total: safeNumber(value?.mem?.total) }, disks, dependencies: { tmux: dependencies.tmux === true, git: dependencies.git === true, python: dependencies.python === true, rg: dependencies.rg === true, sshpass: dependencies.sshpass === true }, stream: getSafeStreamMetrics() }
}
async function getLocalSystemInfo() {
  const [gpu, cpu, mem, disks, dependencies] = await Promise.all([getGpuInfo(), getCpuUsage(), getMemory(), getDisk(), getDependencies()])
  return { hostId: 'local', gpu, cpu, mem, disks, dependencies, stream: getSafeStreamMetrics() }
}
async function getRemoteSystemInfo(hostId: string) {
  const fallback = `has(){ command -v "$1" >/dev/null 2>&1 && printf true || printf false; }; printf '{"gpu":null,"cpu":0,"mem":{"used":0,"total":0},"disks":[],"dependencies":{"tmux":%s,"git":%s,"python":false,"rg":%s,"sshpass":%s}}' "$(has tmux)" "$(has git)" "$(has rg)" "$(has sshpass)"`
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
export async function systemRoutes(fastify: FastifyInstance, options: SystemRoutesOptions = {}) {
  const restartRunner=(options.createRestartRunner||createRestartTaskRunner)()
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
        dependencies: { tmux: false, git: false, python: false, rg: false, sshpass: false },
        stream: getSafeStreamMetrics(),
      }
    }
  })
  fastify.get('/hosts/:hostId/system', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return getSystemInfo(hostId)
  })
  fastify.get('/system/restart-rebuild', async () => restartRunner.getState())
  fastify.post('/system/restart-rebuild', async () => restartRunner.start())
}
