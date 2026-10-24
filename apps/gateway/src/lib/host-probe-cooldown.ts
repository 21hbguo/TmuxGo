// 每主机失败退避：远端不可达/认证失败/配置缺失时，轮询不再每周期都烧
// ConnectTimeout + 刷堆栈日志。冷却窗内直接抛缓存的同构错误——调用方拿到的
// message 不变，上层 unreachable 语义不变
export class HostCooldownError extends Error {}
const cooldowns = new Map<string, { until: number; message: string }>()
export const HOST_PROBE_COOLDOWN_MS = 60_000

export async function probeWithCooldown<T>(
  hostId: string,
  probe: () => Promise<T>,
  cooldownMs = HOST_PROBE_COOLDOWN_MS,
) {
  const cooled = cooldowns.get(hostId)
  if (cooled && cooled.until > Date.now()) throw new HostCooldownError(cooled.message)
  try {
    const result = await probe()
    cooldowns.delete(hostId)
    return result
  } catch (error) {
    cooldowns.set(hostId, {
      until: Date.now() + cooldownMs,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
export function resetHostProbeCooldowns() {
  cooldowns.clear()
}
