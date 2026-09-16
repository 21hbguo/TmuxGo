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

export interface VncSetupStatus {
  os: string
  server: string | null
  session: string
  listening: boolean
  sudo: boolean
  supported: boolean
  hint: string
}

// 探测脚本只输出 key=value 行，远端 sh -lc 即可跑（agent/ssh/local 同一条命令）
const VNC_PROBE_SCRIPT = [
  'echo "os=$(uname -s)"',
  'echo "session=${XDG_SESSION_TYPE:-}"',
  'command -v x11vnc >/dev/null 2>&1 && echo server=x11vnc',
  'command -v wayvnc >/dev/null 2>&1 && echo wayvnc=1',
  'command -v xtigervnc >/dev/null 2>&1 && echo tigervnc=1',
  'sudo -n true >/dev/null 2>&1 && echo sudo=ok',
  // 5900 是否已在监听：优先 ss，退到 netstat，都没有就跳过（无法判断当 unknown 处理）
  'if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q ":5900 " && echo listening=1;',
  'elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null | grep -q ":5900 " && echo listening=1; fi',
  'pgrep -x x11vnc >/dev/null 2>&1 && echo running=1',
].join('\n')

export function parseVncProbe(stdout: string): VncSetupStatus {
  const kv = new Map(
    stdout
      .split('\n')
      .map((line) => line.trim().split('='))
      .filter((pair): pair is string[] => pair.length === 2 && !!pair[0])
      .map(([key, value]) => [key, value] as const),
  )
  const os = kv.get('os') || ''
  const server = kv.get('server') || (kv.has('wayvnc') ? 'wayvnc' : kv.has('tigervnc') ? 'tigervnc' : null)
  const session = kv.get('session') || ''
  const listening = kv.has('listening') || kv.has('running')
  const sudo = kv.has('sudo')
  if (os === 'Darwin') {
    // macOS 自带屏幕共享（RFB 兼容），launchd 开关较新版本需 GUI 确认，给手动指引不自动改系统设置
    return { os, server: 'builtin', session, listening, sudo, supported: true, hint: 'macos-builtin' }
  }
  const supported = os === 'Linux'
  const hint = supported
    ? session === 'wayland'
      ? 'wayland-compositor'
      : server
        ? ''
        : 'need-install'
    : 'unsupported-os'
  return { os, server, session, listening, sudo, supported, hint }
}

// execHostShell 对非零退出会 throw 且不保留 exitCode，结果改用 stdout 标记位传递
export const VNC_INSTALL_SCRIPT = [
  'sudo -n true >/dev/null 2>&1 || { echo __need_sudo__; exit 0; }',
  'if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get update -qq && sudo -n apt-get install -y x11vnc;',
  'elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y x11vnc;',
  'elif command -v yum >/dev/null 2>&1; then sudo -n yum install -y x11vnc;',
  'elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -S --noconfirm x11vnc;',
  'elif command -v zypper >/dev/null 2>&1; then sudo -n zypper --non-interactive install x11vnc;',
  'else echo __no_pkg_manager__; exit 0; fi',
  'command -v x11vnc >/dev/null 2>&1 && echo __installed__',
].join('\n')

export const VNC_START_SCRIPT = [
  'command -v x11vnc >/dev/null 2>&1 || { echo __missing__; exit 0; }',
  // -bg 由 x11vnc 自身 daemon 化（不依赖 nohup 语义），-localhost 保证只走本机回环
  'x11vnc -display "${DISPLAY:-:0}" -localhost -forever -shared -bg -o /tmp/tmuxgo-x11vnc.log >/dev/null 2>&1',
  'sleep 1',
  'pgrep -x x11vnc >/dev/null 2>&1 && echo __started__',
].join('\n')

// 需要手动执行时给用户的可复制命令
export const VNC_MANUAL_INSTALL_COMMAND =
  'sudo apt-get install -y x11vnc && x11vnc -display :0 -localhost -forever -shared -bg'
export const VNC_PROBE_COMMAND = VNC_PROBE_SCRIPT
