import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const serviceLabel = 'com.tmuxgo.gateway'
const servicePath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
process.env.PATH = `${servicePath}:${process.env.PATH || ''}`

function commandExists(command) {
  return !spawnSync(command, ['--version'], { stdio: 'ignore', env: process.env }).error
}
function run(command, args, allowFailure = false) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env })
  if (result.error) {
    if (allowFailure) return false
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} exited with status ${result.status}`)
  return result.status === 0
}
function runPrivileged(command, args) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return run(command, args)
  if (!commandExists('sudo')) throw new Error('sudo is required to install production dependencies')
  return run('sudo', [command, ...args])
}
function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function brewPath() {
  if (existsSync('/opt/homebrew/bin/brew')) return '/opt/homebrew/bin/brew'
  if (existsSync('/usr/local/bin/brew')) return '/usr/local/bin/brew'
  return ''
}
function installMacDependencies() {
  let brew = brewPath()
  if (!brew) {
    run('/bin/bash', ['-c', 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'])
    brew = brewPath()
  }
  if (!brew) throw new Error('Homebrew installation did not produce brew')
  process.env.PATH = `${dirname(brew)}:${process.env.PATH}`
  if (!['tmux', 'rg', 'python3', 'git', 'curl'].every(commandExists)) run(brew, ['install', 'tmux', 'ripgrep', 'python', 'git', 'curl'])
}
function installLinuxDependencies() {
  if (['tmux', 'rg', 'python3', 'git', 'curl'].every(commandExists)) return
  if (commandExists('apt-get')) {
    runPrivileged('apt-get', ['update'])
    runPrivileged('apt-get', ['install', '-y', 'tmux', 'ripgrep', 'python3', 'lsof', 'git', 'curl'])
    return
  }
  if (commandExists('dnf')) {
    runPrivileged('dnf', ['install', '-y', 'tmux', 'ripgrep', 'python3', 'lsof', 'git', 'curl'])
    return
  }
  if (commandExists('pacman')) {
    runPrivileged('pacman', ['-Sy', '--noconfirm', '--needed', 'tmux', 'ripgrep', 'python', 'lsof', 'git', 'curl'])
    return
  }
  throw new Error('Unsupported Linux package manager; install tmux, ripgrep, python3, lsof, git, and curl manually')
}
function installDependencies() {
  if (platform() === 'darwin') return installMacDependencies()
  if (platform() === 'linux') return installLinuxDependencies()
  throw new Error(`TmuxGo production install supports macOS and Linux, received ${platform()}`)
}
function findNodeModules() {
  let directory = packageRoot
  while (!existsSync(join(directory, 'node_modules'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Unable to find the npm package dependencies')
    directory = parent
  }
  return join(directory, 'node_modules')
}
function repairNativePermissions(nodeModules) {
  const pending = [nodeModules]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(target)
        continue
      }
      if (!entry.isFile() || !(entry.name.endsWith('.node') || entry.name === 'spawn-helper' || entry.name === 'esbuild' || entry.name === 'swc')) continue
      chmodSync(target, 0o755)
    }
  }
}
function runtimePackageRoot() {
  const runtimeRoot = join(homedir(), '.tmuxgo', 'runtime', packageJson.version)
  const runtimeModules = join(runtimeRoot, 'node_modules')
  rmSync(runtimeModules, { recursive: true, force: true })
  mkdirSync(runtimeRoot, { recursive: true })
  cpSync(findNodeModules(), runtimeModules, { recursive: true, dereference: true })
  repairNativePermissions(runtimeModules)
  return join(runtimeModules, ...packageJson.name.split('/'))
}
function ensureTmux() {
  if (!run('tmux', ['has-session', '-t', 'default'], true)) run('tmux', ['new-session', '-d', '-s', 'default'])
}
function launchdDomain() {
  const uid = process.getuid?.() ?? 0
  return run('launchctl', ['print', `gui/${uid}`], true) ? `gui/${uid}` : `user/${uid}`
}
function installLaunchdService(runtimeRoot) {
  const uid = process.getuid?.() ?? 0
  const domain = launchdDomain()
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`)
  const logDir = join(homedir(), 'Library', 'Logs', 'TmuxGo')
  const server = join(runtimeRoot, 'lib', 'server.mjs')
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(logDir, { recursive: true })
  run('launchctl', ['bootout', domain, `${domain}/${serviceLabel}`], true)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${serviceLabel}</string><key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(server)}</string></array><key>WorkingDirectory</key><string>${xmlEscape(runtimeRoot)}</string><key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string><key>PORT</key><string>3001</string><key>PATH</key><string>${servicePath}</string><key>TMUXGO_FRONTEND_DIST</key><string>${xmlEscape(join(runtimeRoot, 'vendor', 'frontend'))}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xmlEscape(join(logDir, 'gateway.log'))}</string><key>StandardErrorPath</key><string>${xmlEscape(join(logDir, 'gateway.log'))}</string></dict></plist>\n`
  writeFileSync(plistPath, xml)
  run('launchctl', ['bootstrap', domain, plistPath])
  run('launchctl', ['enable', `${domain}/${serviceLabel}`], true)
  run('launchctl', ['kickstart', '-k', `${domain}/${serviceLabel}`])
}
function systemdEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\x20')
}
function installSystemdService(runtimeRoot) {
  if (!commandExists('systemctl')) throw new Error('systemctl is required for a Linux production install')
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
  const unitPath = join(unitDir, 'tmuxgo-gateway.service')
  const server = join(runtimeRoot, 'lib', 'server.mjs')
  mkdirSync(unitDir, { recursive: true })
  const unit = `[Unit]\nDescription=TmuxGo Gateway\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdEscape(runtimeRoot)}\nExecStart=${systemdEscape(process.execPath)} ${systemdEscape(server)}\nRestart=always\nRestartSec=3\nEnvironment=NODE_ENV=production\nEnvironment=PORT=3001\nEnvironment=PATH=${servicePath}\nEnvironment=TMUXGO_FRONTEND_DIST=${systemdEscape(join(runtimeRoot, 'vendor', 'frontend'))}\n\n[Install]\nWantedBy=default.target\n`
  writeFileSync(unitPath, unit)
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', 'tmuxgo-gateway.service'])
  run('systemctl', ['--user', 'restart', 'tmuxgo-gateway.service'])
}
async function waitForGateway() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:3001/health')
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Gateway did not become healthy on http://127.0.0.1:3001')
}
function openBrowser() {
  if (process.env.SSH_CONNECTION) return
  if (platform() === 'darwin') run('open', ['http://127.0.0.1:3001'], true)
  if (platform() === 'linux' && commandExists('xdg-open')) run('xdg-open', ['http://127.0.0.1:3001'], true)
}
async function install() {
  installDependencies()
  ensureTmux()
  const runtimeRoot = runtimePackageRoot()
  if (platform() === 'darwin') installLaunchdService(runtimeRoot)
  else installSystemdService(runtimeRoot)
  await waitForGateway()
  openBrowser()
  console.log('TmuxGo is ready at http://127.0.0.1:3001')
}
function uninstall() {
  if (platform() === 'darwin') {
    const domain = launchdDomain()
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`)
    run('launchctl', ['bootout', domain, `${domain}/${serviceLabel}`], true)
    rmSync(plistPath, { force: true })
    return
  }
  if (platform() === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', 'tmuxgo-gateway.service'], true)
    rmSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'tmuxgo-gateway.service'), { force: true })
    run('systemctl', ['--user', 'daemon-reload'], true)
  }
}
function status() {
  if (platform() === 'darwin') run('launchctl', ['print', `${launchdDomain()}/${serviceLabel}`])
  else run('systemctl', ['--user', '--no-pager', 'status', 'tmuxgo-gateway.service'])
}
const command = process.argv[2] || 'install'
if (command === '--help' || command === '-h' || command === 'help') console.log('Usage: npx @21hbguo/tmuxgo [install|status|uninstall]')
else if (command === 'install') await install()
else if (command === 'status') status()
else if (command === 'uninstall') uninstall()
else throw new Error(`Unknown command: ${command}`)
