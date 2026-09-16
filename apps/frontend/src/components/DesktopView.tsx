'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type RFBType from '@novnc/novnc'
import { FiClipboard, FiCopy, FiEye, FiEyeOff, FiKey, FiMonitor, FiPlay, FiSquare, FiTool, FiX } from 'react-icons/fi'
import { Button } from './Button'
import { api, type VncSetupStatus } from '@/lib/api'
import { getWebSocketUrl } from '@/lib/auth'
import { getVncWebSocketBase } from '@/lib/runtime-endpoints'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

type VncStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'
interface DesktopViewProps {
  hostId: string
  port: number
  onClose: () => void
}

export function DesktopView({ hostId, port, onClose }: DesktopViewProps) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFBType | null>(null)
  const connectSeqRef = useRef(0)
  const [status, setStatus] = useState<VncStatus>('idle')
  const [error, setError] = useState('')
  const [desktopName, setDesktopName] = useState('')
  const [credentialTypes, setCredentialTypes] = useState<string[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [viewOnly, setViewOnly] = useState(false)
  const [portInput, setPortInput] = useState(String(port))
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupBusy, setSetupBusy] = useState<'' | 'check' | 'install' | 'start'>('')
  const [setupInfo, setSetupInfo] = useState<{
    status: VncSetupStatus
    manualCommand: string
    needSudo?: boolean
  } | null>(null)
  const [setupCopied, setSetupCopied] = useState(false)
  const portRef = useRef(port)
  const hiddenRef = useRef(typeof document !== 'undefined' && document.hidden)
  // 隐藏时记录是否有活动连接：手动断开过的会话回到前台不自动重连；初始 true 兜底"挂着后台打开"场景
  const wasActiveRef = useRef(true)
  // 可见性重连时免重复弹窗：提交过的凭据存 ref，securityfailure 时作废
  const credentialsRef = useRef<{ username?: string; password: string } | null>(null)
  // RFB 事件回调在 connect 时注册一次，用 ref 拿最新 viewOnly/t，避免 connect 身份抖动触发重连
  const viewOnlyRef = useRef(viewOnly)
  const tRef = useRef(t)
  viewOnlyRef.current = viewOnly
  tRef.current = t

  const connect = useCallback(
    async (targetPort: number) => {
      if (!containerRef.current) return
      rfbRef.current?.disconnect()
      rfbRef.current = null
      containerRef.current.innerHTML = ''
      setStatus('connecting')
      setError('')
      setDesktopName('')
      setCredentialTypes([])
      const seq = ++connectSeqRef.current
      let url: string
      let RFB: typeof RFBType
      try {
        ;[url, { default: RFB }] = await Promise.all([
          getWebSocketUrl(getVncWebSocketBase(hostId, targetPort)),
          import('@novnc/novnc'),
        ])
      } catch (err) {
        setStatus('idle')
        setError(err instanceof Error ? err.message : String(err))
        return
      }
      // 等待 ticket/模块期间发生了新的 connect 或卸载，丢弃本次结果避免双 RFB
      if (seq !== connectSeqRef.current || !containerRef.current) return
      portRef.current = targetPort
      const rfb = new RFB(containerRef.current, url, { shared: true })
      rfb.scaleViewport = true
      rfb.viewOnly = viewOnlyRef.current
      // 交互优先：JPEG 质量中等 + tight 低压缩级别，画质/CPU/延迟折中
      rfb.qualityLevel = 6
      rfb.compressionLevel = 2
      rfb.addEventListener('connect', () => setStatus('connected'))
      rfb.addEventListener('disconnect', (event) => {
        rfbRef.current = null
        setStatus('disconnected')
        setCredentialTypes([])
        if (!event.detail.clean) setError(tRef.current('vnc.disconnectUnclean'))
      })
      rfb.addEventListener('credentialsrequired', (event) => {
        const saved = credentialsRef.current
        if (saved) {
          rfb.sendCredentials({ username: saved.username, password: saved.password })
          return
        }
        setCredentialTypes(event.detail.types)
      })
      rfb.addEventListener('securityfailure', (event) => {
        credentialsRef.current = null
        setError(event.detail.reason || `${tRef.current('vnc.securityFailure')} (${event.detail.status})`)
      })
      rfb.addEventListener('desktopname', (event) => setDesktopName(event.detail.name))
      // 远端剪贴板同步到本地：浏览器要求用户手势/权限，失败静默降级
      rfb.addEventListener('clipboard', (event) => {
        void navigator.clipboard?.writeText(event.detail.text).catch(() => {})
      })
      rfbRef.current = rfb
      wasActiveRef.current = true
    },
    [hostId],
  )

  const disconnect = useCallback(() => {
    connectSeqRef.current += 1
    wasActiveRef.current = false
    rfbRef.current?.disconnect()
    rfbRef.current = null
    setStatus('idle')
  }, [])

  const handleConnect = useCallback(() => {
    const next = Number(portInput)
    void connect(Number.isInteger(next) && next >= 5900 && next <= 5999 ? next : 5900)
  }, [connect, portInput])

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly
  }, [viewOnly])
  useEffect(() => {
    if (!document.hidden) void connect(port)
    return () => {
      connectSeqRef.current += 1
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [connect, port])
  // 浏览器 tab 隐藏即断流：整棵 VNC 链路（WS→TCP）随 RFB.disconnect 拆除，回前台自动重连
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        hiddenRef.current = true
        wasActiveRef.current = rfbRef.current !== null
        connectSeqRef.current += 1
        rfbRef.current?.disconnect()
        rfbRef.current = null
        setCredentialTypes([])
      } else if (hiddenRef.current) {
        hiddenRef.current = false
        if (wasActiveRef.current) void connect(portRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [connect])

  const submitCredentials = () => {
    const credentials = { username: credentialTypes.includes('username') ? username : undefined, password }
    credentialsRef.current = credentials
    rfbRef.current?.sendCredentials(credentials)
    setCredentialTypes([])
    setPassword('')
  }
  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) rfbRef.current?.clipboardPasteFrom(text)
    } catch {
      pushToast({ type: 'error', message: t('vnc.clipboardDenied') })
    }
  }

  const checkSetup = useCallback(async () => {
    setSetupBusy('check')
    try {
      const result = await api.vnc.status(hostId)
      setSetupInfo({ status: result.status, manualCommand: result.manualCommand })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSetupBusy('')
    }
  }, [hostId, pushToast])

  const runSetup = useCallback(
    async (action: 'install' | 'start') => {
      setSetupBusy(action)
      try {
        const result = await api.vnc.setup(hostId, action)
        setSetupInfo({ status: result.status, manualCommand: result.manualCommand, needSudo: result.needSudo })
        if (result.ok) {
          setSetupOpen(false)
          void connect(portRef.current)
        }
      } catch (err) {
        pushToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        setSetupBusy('')
      }
    },
    [hostId, pushToast, connect],
  )

  const copyManualCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setSetupCopied(true)
      setTimeout(() => setSetupCopied(false), 1500)
    } catch {
      setSetupCopied(false)
    }
  }, [])

  const statusLabel =
    status === 'connected'
      ? t('vnc.connected')
      : status === 'connecting'
        ? t('vnc.connecting')
        : status === 'disconnected'
          ? t('vnc.disconnected')
          : ''
  return (
    <section className="tmuxgo-content-surface flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-apple bg-bg-2 text-accent">
          <FiMonitor size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-text-1">{desktopName || t('vnc.title')}</div>
          <div className="truncate text-caption text-text-3">
            {hostId}
            {statusLabel ? ` · ${statusLabel}` : ''}
          </div>
        </div>
        <input
          value={portInput}
          onChange={(event) => setPortInput(event.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleConnect()
          }}
          inputMode="numeric"
          aria-label={t('vnc.port')}
          title={t('vnc.port')}
          className="h-7 w-16 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-accent"
        />
        {status === 'connected' || status === 'connecting' ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={disconnect}
            aria-label={t('vnc.disconnect')}
            title={t('vnc.disconnect')}
          >
            <FiSquare size={14} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleConnect}
            aria-label={t('vnc.connect')}
            title={t('vnc.connect')}
          >
            <FiPlay size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setViewOnly((value) => !value)}
          aria-label={t('vnc.viewOnly')}
          title={t('vnc.viewOnly')}
          className={viewOnly ? 'text-accent' : ''}
        >
          {viewOnly ? <FiEyeOff size={14} /> : <FiEye size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => rfbRef.current?.sendCtrlAltDel()}
          disabled={status !== 'connected' || viewOnly}
          aria-label={t('vnc.sendCad')}
          title={t('vnc.sendCad')}
        >
          <FiKey size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void pasteClipboard()}
          disabled={status !== 'connected' || viewOnly}
          aria-label={t('vnc.paste')}
          title={t('vnc.paste')}
        >
          <FiClipboard size={14} />
        </Button>
        {status !== 'connected' && status !== 'connecting' && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              const next = !setupOpen
              setSetupOpen(next)
              if (next && !setupInfo && !setupBusy) void checkSetup()
            }}
            aria-label={t('vnc.setupCheck')}
            title={t('vnc.setupCheck')}
            className={setupOpen ? 'text-accent' : ''}
          >
            <FiTool size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <FiX size={15} />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 bg-black">
        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
        {credentialTypes.length > 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
            <form
              className="tmuxgo-glass flex w-64 flex-col gap-2 rounded-apple-lg p-4"
              onSubmit={(event) => {
                event.preventDefault()
                submitCredentials()
              }}
            >
              <div className="text-xs font-medium text-text-1">{t('vnc.credentialsRequired')}</div>
              {credentialTypes.includes('username') && (
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t('vnc.username')}
                  autoComplete="username"
                  className="h-8 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-accent"
                />
              )}
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('vnc.password')}
                autoComplete="current-password"
                autoFocus
                className="h-8 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-accent"
              />
              <Button type="submit" size="sm">
                {t('vnc.connect')}
              </Button>
            </form>
          </div>
        )}
        {setupOpen && credentialTypes.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
            <div className="tmuxgo-glass flex w-80 max-w-full flex-col gap-2 rounded-apple-lg p-4 text-xs text-text-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t('vnc.setupCheck')}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSetupOpen(false)}
                  aria-label={t('common.close')}
                >
                  <FiX size={13} />
                </Button>
              </div>
              {setupBusy === 'check' && <div className="text-text-3">{t('vnc.setupChecking')}</div>}
              {setupInfo && (
                <>
                  <div className="text-text-3">
                    {setupInfo.status.os || '?'}
                    {setupInfo.status.server ? ` · ${setupInfo.status.server}` : ' · no vnc server'}
                    {setupInfo.status.listening ? ' · :5900' : ''}
                  </div>
                  {setupInfo.status.hint === 'macos-builtin' && <div>{t('vnc.setupMacos')}</div>}
                  {setupInfo.status.hint === 'wayland-compositor' && <div>{t('vnc.setupWayland')}</div>}
                  {setupInfo.status.hint === 'unsupported-os' && <div>{t('vnc.setupUnsupported')}</div>}
                  {setupInfo.status.listening && <div className="text-accent-2">{t('vnc.setupReady')}</div>}
                  {setupInfo.status.supported && setupInfo.status.server && !setupInfo.status.listening && (
                    <Button size="sm" disabled={!!setupBusy} onClick={() => void runSetup('start')}>
                      {setupBusy === 'start' ? t('vnc.setupInstalling') : t('vnc.setupStart')}
                    </Button>
                  )}
                  {setupInfo.status.supported &&
                    !setupInfo.status.server &&
                    setupInfo.status.sudo &&
                    !setupInfo.needSudo && (
                      <Button size="sm" disabled={!!setupBusy} onClick={() => void runSetup('install')}>
                        {setupBusy === 'install' ? t('vnc.setupInstalling') : t('vnc.setupInstall')}
                      </Button>
                    )}
                  {(setupInfo.needSudo ||
                    (setupInfo.status.supported && !setupInfo.status.sudo && !setupInfo.status.server) ||
                    setupInfo.status.hint === 'unsupported-os') && (
                    <>
                      <div className="text-text-3">
                        {t(setupInfo.needSudo ? 'vnc.setupNeedSudo' : 'vnc.setupManual')}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-bg-1 px-2 py-1 text-caption">
                          {setupInfo.manualCommand}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void copyManualCommand(setupInfo.manualCommand)}
                          aria-label={t('vnc.copyCommand')}
                          title={t('vnc.copyCommand')}
                        >
                          <FiCopy size={13} />
                        </Button>
                      </div>
                      {setupCopied && <div className="text-accent-2">{t('vnc.copied')}</div>}
                    </>
                  )}
                </>
              )}
              {!setupInfo && setupBusy !== 'check' && (
                <Button size="sm" onClick={() => void checkSetup()}>
                  {t('vnc.setupCheck')}
                </Button>
              )}
            </div>
          </div>
        )}
        {(status !== 'connected' || error) && credentialTypes.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
            <div
              className={`rounded-apple px-3 py-1.5 text-xs ${error ? 'bg-danger/90 text-white' : 'bg-bg-1/90 text-text-2'}`}
            >
              {error ||
                (status === 'connecting'
                  ? t('vnc.connecting')
                  : status === 'disconnected'
                    ? t('vnc.disconnected')
                    : t('vnc.idle'))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
