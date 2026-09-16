// VNC 桥只允许拨各宿主机回环地址的 5900–5999（display :0–:99），
// 端口超出范围直接拒绝，防止被当作任意 TCP 代理（SSRF）
const VNC_PORT_MIN = 5900
const VNC_PORT_MAX = 5999
export const VNC_DEFAULT_PORT = 5900
export const VNC_LOOPBACK_HOST = '127.0.0.1'

export function normalizeVncPort(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return VNC_DEFAULT_PORT
  const port = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(port) || port < VNC_PORT_MIN || port > VNC_PORT_MAX) return null
  return port
}
