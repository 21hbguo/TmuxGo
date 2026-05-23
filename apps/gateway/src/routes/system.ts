import type { FastifyInstance } from 'fastify'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import fs from 'fs'

const execFileAsync = promisify(execFile)

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

export async function systemRoutes(fastify: FastifyInstance) {
  fastify.get('/system', async () => {
    const [gpu, cpu, mem, disk] = await Promise.all([
      getGpuInfo(),
      getCpuUsage(),
      getMemory(),
      getDisk(),
    ])
    return { gpu, cpu, mem, disks: disk }
  })
}
