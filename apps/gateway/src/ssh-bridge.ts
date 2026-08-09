import { pathToFileURL } from 'url'
import { StringDecoder } from 'string_decoder'
import { ATTACH_COMMAND_HELP, parseAttachCommand, type AttachCommand } from './lib/ssh-attach/attach-command.js'
import { resolveSshUser } from './lib/ssh-attach/user-map.js'
import { assertSshHostAllowed } from './lib/ssh-attach/host-policy.js'
import { createTerminalAttachment, type TerminalAttachment } from './lib/terminal-attachment.js'
import { assertSessionAllowed, prepareSessionAttach } from './lib/tmux-policy.js'
import { appendAuditEvent, type AuditEvent } from './lib/audit-log.js'
import { getHostById } from './lib/hosts.js'
import { agentManager } from './agent-manager.js'
const SSH_USAGE_HINT = 'Usage: ssh tmuxgo@gateway attach --host <host> --session <name>'
function auditEvent(command: AttachCommand | undefined, user: string, result: 'success' | 'failure', statusCode: number, message?: string): AuditEvent {
  return { id: `${Date.now().toString(36)}-ssh`, timestamp: new Date().toISOString(), user, action: 'ssh-attach', target: command ? `${command.hostId}/${command.sessionName}` : 'unknown/unknown', result, method: 'SSH', statusCode, hostId: command?.hostId, message }
}
export async function main(argv: string[]): Promise<number> {
  const sshUser = process.env.TMUXGO_SSH_USER || process.env.LOGNAME || process.env.USER || 'unknown'
  const tmuxgoUser = resolveSshUser(sshUser)
  try {
    try { process.stdin.setRawMode?.(true) } catch {}
    process.stdout.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') process.stderr.write(`${error.message}\n`) })
    if (argv.includes('--help') || argv.includes('help')) {
      process.stdout.write(`${ATTACH_COMMAND_HELP}\n`)
      return 0
    }
    let command: AttachCommand
    try {
      command = parseAttachCommand(argv)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}${argv[0] !== 'attach' ? `\n${SSH_USAGE_HINT}` : ''}\n`)
      return 1
    }
    const hostId = command.hostId
    const sessionName = command.sessionName
    const mode = command.mode
    try {
      assertSshHostAllowed(sshUser, hostId)
      assertSessionAllowed(sessionName)
      if (hostId !== 'local') {
        if (!(await getHostById(hostId)) && !agentManager.getAgent(hostId)) throw new Error('Host not found')
      } else {
        await prepareSessionAttach(sessionName)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      await appendAuditEvent(auditEvent(command, tmuxgoUser, 'failure', 403, message)).catch(() => {})
      return 1
    }
    let attachment: TerminalAttachment
    try {
      attachment = await createTerminalAttachment({ hostId, sessionName, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24, exclusive: mode === 'exclusive' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      await appendAuditEvent(auditEvent(command, tmuxgoUser, 'failure', 500, message)).catch(() => {})
      return 1
    }
    await appendAuditEvent(auditEvent(command, tmuxgoUser, 'success', 200, `mode=${mode}`)).catch(() => {})
    return await new Promise<number>((resolve) => {
      const inputDecoder = new StringDecoder('utf8')
      process.stdin.on('data', (data) => { if (mode !== 'readonly') attachment.write(inputDecoder.write(data)) })
      attachment.onData((data) => process.stdout.write(data))
      process.on('SIGWINCH', () => { if (mode !== 'readonly' && process.stdout.columns && process.stdout.rows) attachment.resize(process.stdout.columns, process.stdout.rows) })
      attachment.onExit((exitCode) => resolve(exitCode))
      process.on('SIGHUP', () => { attachment.kill(); resolve(129) })
      process.on('SIGINT', () => { attachment.kill(); resolve(130) })
      process.on('SIGTERM', () => { attachment.kill(); resolve(143) })
      process.stdin.on('end', () => { attachment.kill(); resolve(0) })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    await appendAuditEvent(auditEvent(undefined, tmuxgoUser, 'failure', 500, message)).catch(() => {})
    return 1
  }
}
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).then((exitCode) => process.stdout.write('', () => process.exit(exitCode)))
}
