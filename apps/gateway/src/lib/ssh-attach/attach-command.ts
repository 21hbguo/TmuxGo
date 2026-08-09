import { isValidSessionName } from '../tmux-policy.js'
export type AttachMode = 'shared' | 'exclusive' | 'readonly'
export interface AttachCommand {
  hostId: string
  sessionName: string
  mode: AttachMode
}
export const ATTACH_COMMAND_HELP = 'Usage: attach --host <host> --session <name> [--shared|--exclusive|--readonly]\nModes: --shared (default), --exclusive, --readonly'
export function parseAttachCommand(argv: string[]): AttachCommand {
  if (argv[0] !== 'attach') throw new Error('Unknown command')
  let hostId = ''
  let sessionName = ''
  let mode: AttachMode | undefined
  const requireValue = (option: string, index: number) => {
    if (index >= argv.length) throw new Error(`Missing value for option: ${option}`)
    const value = argv[index]
    if (value === '' || value.startsWith('-')) throw new Error(`Missing value for option: ${option}`)
    return value
  }
  const setMode = (value: AttachMode) => {
    if (mode) throw new Error('Conflicting mode options')
    mode = value
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--host':
      case '-h':
        hostId = requireValue(arg, ++i)
        break
      case '--session':
      case '-s':
        sessionName = requireValue(arg, ++i)
        break
      case '--shared':
        setMode('shared')
        break
      case '--exclusive':
        setMode('exclusive')
        break
      case '--readonly':
        setMode('readonly')
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (!hostId) throw new Error('Missing required option: --host')
  if (!sessionName) throw new Error('Missing required option: --session')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(hostId)) throw new Error('Invalid host id')
  if (!isValidSessionName(sessionName)) throw new Error('Invalid session name')
  return { hostId, sessionName, mode: mode ?? 'shared' }
}
