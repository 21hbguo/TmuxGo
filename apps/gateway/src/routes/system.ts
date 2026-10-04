import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import fs from 'fs'
import { streamPerfMetrics } from '../lib/perf-metrics.js'
import { createRestartTaskRunner, createUpdateTaskRunner, type RestartTaskRunner } from '../lib/restart-task.js'
import { createUpdateChecker, type UpdateChecker } from '../lib/update-checker.js'
import { taskManager, type TaskManager } from '../lib/task-manager.js'
import { execHostShell } from '../lib/tmux-executor.js'
import { observeNetWindow, type NetWindowStats } from '../lib/net-window.js'

const execFileAsync = promisify(execFile)
const dependencyCommands = {
  tmux: { command: 'tmux', args: ['-V'] },
  git: { command: 'git', args: ['--version'] },
  python: { command: 'python3', args: ['--version'] },
  rg: { command: 'rg', args: ['--version'] },
  sshpass: { command: 'sshpass', args: ['-V'] },
} as const
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
    const [used, total] = stdout
      .trim()
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
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
      const parts = line
        .slice(colonIndex + 1)
        .trim()
        .split(/\s+/)
        .map(Number)
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
    backpressureSuppressed: safeNumber(streamPerfMetrics.backpressureSuppressed),
    profileUpdates: safeNumber(streamPerfMetrics.profileUpdates),
    deferredFlushes: safeNumber(streamPerfMetrics.deferredFlushes),
    socketBufferedBytes: safeNumber(streamPerfMetrics.socketBufferedBytes),
    activeClients: safeNumber(streamPerfMetrics.activeClients),
    activeProfile:
      streamPerfMetrics.activeProfile === 'background' || streamPerfMetrics.activeProfile === 'mobile'
        ? streamPerfMetrics.activeProfile
        : 'foreground',
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
    resizeAckWaitMs: safeNumber(streamPerfMetrics.resizeAckWaitMs),
  }
}
async function getDependencies() {
  const entries = await Promise.all(
    Object.entries(dependencyCommands).map(async ([name, dependency]) => {
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
    }),
  )
  return Object.fromEntries(entries) as Record<keyof typeof dependencyCommands, boolean>
}
function quoteShellValue(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
// 进程级上下行速率：inet_diag(SOCK_DIAG_BY_FAMILY) 拿每 TCP socket 的
// bytes_acked/bytes_received 累计计数，两次采样差分出 B/s。内核 tcp_diag
// 模块未加载（ss -i 同样失效）时无 per-socket 字节计数可用——宁可报
// unsupported 也不用 /proc/<pid>/io 的进程总 I/O 冒充网速（含管道/tty）。
// socket→pid 归属靠 /proc/<pid>/fd 的 socket:[ino] 链接，非 root 只见自己
// 进程；conns 含 UDP（udp_diag 无字节计数，UDP 进程速率恒 0）。
// 采样窗口约 1.2s，结果缓存 4s 防止悬停反复触发远端 ssh 采样。
const NET_TOP_SAMPLE_S = 1.2
const netTopScript = `import json,os,socket,struct,time
def inos():
 m={}
 for f in ('/proc/net/tcp','/proc/net/tcp6','/proc/net/udp','/proc/net/udp6'):
  try:lns=open(f).read().splitlines()[1:]
  except OSError:continue
  for l in lns:
   p=l.split()
   if len(p)>9 and p[3]!='0A' and p[9] not in m:m[p[9]]=1
 return m
def pidmap(inos):
 m={}
 try:pids=sorted(int(p) for p in os.listdir('/proc') if p.isdigit())
 except OSError:return m
 for pid in pids:
  try:fds=os.listdir('/proc/%d/fd'%pid)
  except OSError:continue
  for fd in fds:
   try:l=os.readlink('/proc/%d/fd/%s'%(pid,fd))
   except OSError:continue
   if l.startswith('socket:['):
    i=l[8:-1]
    if i in inos and i not in m:m[i]=pid
 return m
# SOCK_DIAG_BY_FAMILY(20) dump inet_diag：req_v2 56B(family,proto=IPPROTO_TCP,
# ext=0x0e 即请求 INFO/VEGAS/CONG attr,states 掩码)+48B sockid；响应
# inet_diag_msg 里 inode@68、rtattr 列表自 72 起，INET_DIAG_INFO(type2)载荷是
# tcp_info，bytes_acked/bytes_received 在 tcp_info 偏移 120/128（attr 起点 p+124）。
def diag(fam):
 try:sk=socket.socket(socket.AF_NETLINK,socket.SOCK_RAW,4);sk.settimeout(3)
 except OSError:return None
 try:
  req=struct.pack('=BBBBI',fam,6,0x0e,0,0xfff)+b'\\0'*48
  sk.send(struct.pack('=IHHII',16+len(req),20,0x301,1,0)+req)
  out={}
  while True:
   d=sk.recv(1<<20);o=0
   while o+16<=len(d):
    ln,ty=struct.unpack_from('=IH',d,o)
    if ty==3:return out
    if ty==2:return None
    b=d[o+16:o+ln];ino=struct.unpack_from('=I',b,68)[0];p=72
    while p+4<=len(b):
     al,at=struct.unpack_from('=HH',b,p)
     if at==2 and al>=136:
      out[ino]=struct.unpack_from('<QQ',b,p+124)
     p+=(al+3)&~3
    o+=(ln+3)&~3
 except OSError:return None
 finally:sk.close()
def diag_all():
 a=diag(2);b=diag(10)
 return None if a is None and b is None else (a or {})|(b or {})
d0=diag_all()
if d0 is None:
 print(json.dumps({'mode':'nodiag'}));raise SystemExit
t0=time.monotonic();time.sleep(${NET_TOP_SAMPLE_S});dt=time.monotonic()-t0
d1=diag_all() or {}
procs={}
# socket 归属中途不变，一次 pidmap 同时服务两帧与连接数统计
for i,p in pidmap(inos()).items():
 r=procs.setdefault(p,{'name':'','pid':p,'conns':0,'rx':0.0,'tx':0.0});r['conns']+=1
 if i in d0 and i in d1:
  r['rx']+=max(0,d1[i][1]-d0[i][1]);r['tx']+=max(0,d1[i][0]-d0[i][0])
rows=sorted(procs.values(),key=lambda r:-(r['rx']+r['tx']))[:5]
for r in rows:
 try:r['name']=open('/proc/%d/comm'%r['pid']).read().strip() or '?'
 except OSError:r['name']='?'
 r['rx']=round(r['rx']/dt);r['tx']=round(r['tx']/dt)
print(json.dumps({'mode':'sock','processes':rows}))`
const NET_TOP_CMD = `if command -v python3 >/dev/null 2>&1; then exec python3 -c ${quoteShellValue(netTopScript)}; elif command -v python >/dev/null 2>&1; then exec python -c ${quoteShellValue(netTopScript)}; else echo __NOPY__; fi`
type NetTopProc = { name: string; pid: number; conns: number; txBps: number; rxBps: number }
type NetTopData = { available: boolean; mode?: 'sock' | 'nopy' | 'nodiag'; processes: NetTopProc[] }
const NET_TOP_TTL_MS = 4000
const netTopCache = new Map<string, { at: number; data: NetTopData }>()
const netTopInflight = new Map<string, Promise<NetTopData>>()
async function sampleNetTop(hostId: string): Promise<NetTopData> {
  try {
    const { stdout } = await execHostShell(hostId, NET_TOP_CMD, { timeoutMs: 15000 })
    if (stdout.includes('__NOPY__')) return { available: false, mode: 'nopy', processes: [] }
    const data = JSON.parse(stdout)
    const processes = Array.isArray(data?.processes)
      ? data.processes.map((p: any) => ({
          name: String(p?.name || '?'),
          pid: safeNumber(p?.pid),
          conns: safeNumber(p?.conns),
          rxBps: safeNumber(p?.rx),
          txBps: safeNumber(p?.tx),
        }))
      : []
    if (data?.mode === 'nodiag') return { available: false, mode: 'nodiag', processes: [] }
    if (data?.mode !== 'sock') return { available: false, processes: [] }
    return { available: true, mode: 'sock', processes }
  } catch {
    return { available: false, processes: [] }
  }
}
async function getNetTop(hostId: string) {
  const hit = netTopCache.get(hostId)
  if (hit && Date.now() - hit.at < NET_TOP_TTL_MS) return hit.data
  const pending = netTopInflight.get(hostId)
  if (pending) return pending
  const req = sampleNetTop(hostId)
    .then((data) => {
      netTopCache.set(hostId, { at: Date.now(), data })
      return data
    })
    .finally(() => netTopInflight.delete(hostId))
  netTopInflight.set(hostId, req)
  return req
}
function normalizeHostSystemInfo(hostId: string, value: any) {
  const dependencies = value?.dependencies && typeof value.dependencies === 'object' ? value.dependencies : {}
  const gpu =
    value?.gpu && Number.isFinite(Number(value.gpu.used)) && Number.isFinite(Number(value.gpu.total))
      ? { used: safeNumber(value.gpu.used), total: safeNumber(value.gpu.total) }
      : null
  const disks = Array.isArray(value?.disks)
    ? value.disks
        .filter((disk: any) => disk && typeof disk.mount === 'string')
        .map((disk: any) => ({ mount: disk.mount, used: safeNumber(disk.used), total: safeNumber(disk.total) }))
    : []
  const counters =
    value?.net && typeof value.net === 'object'
      ? {
          sentBytes: Math.max(0, safeNumber(value.net.sentBytes)),
          recvBytes: Math.max(0, safeNumber(value.net.recvBytes)),
        }
      : { sentBytes: 0, recvBytes: 0 }
  const net = withNetWindow(hostId, counters)
  return {
    hostId,
    gpu,
    cpu: Math.max(0, Math.min(100, safeNumber(value?.cpu))),
    mem: { used: safeNumber(value?.mem?.used), total: safeNumber(value?.mem?.total) },
    disks,
    net,
    dependencies: {
      tmux: dependencies.tmux === true,
      git: dependencies.git === true,
      python: dependencies.python === true,
      rg: dependencies.rg === true,
      sshpass: dependencies.sshpass === true,
    },
    stream: getSafeStreamMetrics(),
  }
}
function withNetWindow(hostId: string, net: { sentBytes: number; recvBytes: number }): NetWindowStats {
  return observeNetWindow(hostId, net)
}
async function getLocalSystemInfo() {
  const [gpu, cpu, mem, disks, net, dependencies] = await Promise.all([
    getGpuInfo(),
    getCpuUsage(),
    getMemory(),
    getDisk(),
    getNetwork(),
    getDependencies(),
  ])
  return {
    hostId: 'local',
    gpu,
    cpu,
    mem,
    disks,
    net: withNetWindow('local', net),
    dependencies,
    stream: getSafeStreamMetrics(),
  }
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
  createUpdateRunner?: () => RestartTaskRunner
  updateChecker?: UpdateChecker
  taskManager?: TaskManager
}
function getRestartTask(runner: RestartTaskRunner) {
  const state = runner.getState()
  return {
    id: 'restart-rebuild',
    type: 'restart-rebuild',
    title: 'Restart + Rebuild',
    ...state,
    cancellable: state.status === 'running',
    retryable: state.status === 'error' || state.status === 'cancelled',
  }
}
function getUpdateTask(runner: RestartTaskRunner) {
  const state = runner.getState()
  return {
    id: 'self-update',
    type: 'self-update',
    title: 'App Update',
    ...state,
    cancellable: state.status === 'running',
    retryable: state.status === 'error' || state.status === 'cancelled',
  }
}
let localNetSampleTimer: NodeJS.Timeout | null = null
function ensureLocalNetSampler() {
  if (localNetSampleTimer) return
  localNetSampleTimer = setInterval(() => {
    void getNetwork()
      .then((net) => {
        withNetWindow('local', net)
      })
      .catch(() => {})
  }, 60_000)
  if (typeof localNetSampleTimer.unref === 'function') localNetSampleTimer.unref()
}
export async function systemRoutes(fastify: FastifyInstance, options: SystemRoutesOptions = {}) {
  const restartRunner = (options.createRestartRunner || createRestartTaskRunner)()
  const updateRunner = (options.createUpdateRunner || createUpdateTaskRunner)()
  const checker = options.updateChecker || createUpdateChecker()
  const backgroundTasks = options.taskManager || taskManager
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
        net: {
          sentBytes: 0,
          recvBytes: 0,
          daySentBytes: 0,
          dayRecvBytes: 0,
          last24hSentBytes: 0,
          last24hRecvBytes: 0,
          trackedMs: 0,
          windowMs: 0,
        },
        dependencies: { tmux: false, git: false, python: false, rg: false, sshpass: false },
        stream: getSafeStreamMetrics(),
      }
    }
  })
  fastify.get('/hosts/:hostId/system', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return getSystemInfo(hostId)
  })
  fastify.get('/hosts/:hostId/net-top', async (request) => {
    const { hostId } = request.params as { hostId: string }
    return getNetTop(hostId)
  })
  fastify.get('/system/tasks', async () => ({
    tasks: [getRestartTask(restartRunner), getUpdateTask(updateRunner), ...backgroundTasks.list()],
  }))
  fastify.get('/system/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    if (taskId === 'restart-rebuild') return getRestartTask(restartRunner)
    if (taskId === 'self-update') return getUpdateTask(updateRunner)
    const task = backgroundTasks.get(taskId)
    return task || reply.status(404).send({ message: 'Task not found', code: 'TASK_NOT_FOUND' })
  })
  fastify.post('/system/tasks/:taskId/cancel', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    if (taskId === 'restart-rebuild') {
      await restartRunner.cancel()
      return getRestartTask(restartRunner)
    }
    if (taskId === 'self-update') {
      await updateRunner.cancel()
      return getUpdateTask(updateRunner)
    }
    const task = await backgroundTasks.cancel(taskId)
    return task || reply.status(404).send({ message: 'Task not found', code: 'TASK_NOT_FOUND' })
  })
  fastify.post('/system/tasks/:taskId/retry', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    if (taskId === 'restart-rebuild') {
      await restartRunner.start()
      return getRestartTask(restartRunner)
    }
    if (taskId === 'self-update') {
      await updateRunner.start()
      return getUpdateTask(updateRunner)
    }
    const task = await backgroundTasks.retry(taskId)
    return task || reply.status(404).send({ message: 'Task not found', code: 'TASK_NOT_FOUND' })
  })
  fastify.get('/system/restart-rebuild', async () => restartRunner.getState())
  fastify.post('/system/restart-rebuild', async () => restartRunner.start())
  fastify.get('/system/update', async () => ({ ...(await checker.getStatus()), task: getUpdateTask(updateRunner) }))
  fastify.post('/system/update/check', async () => ({
    ...(await checker.getStatus(true)),
    task: getUpdateTask(updateRunner),
  }))
  fastify.get('/system/update/task', async () => getUpdateTask(updateRunner))
  fastify.post('/system/update', async () => updateRunner.start())
}
