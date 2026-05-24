'use client'

import { useState, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

interface CommandPaletteProps {
  onClose: () => void
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { hosts, sessions, setCommandPalette, setActiveHost, setActiveSession } = useConsoleStore()
  const { t } = useTranslation()

  const close = () => {
    setCommandPalette(false)
    onClose()
  }

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const filteredHosts = hosts.filter((h: any) =>
    h.name.toLowerCase().includes(query.toLowerCase())
  )

  const filteredSessions = sessions.filter((s: any) =>
    s.name.toLowerCase().includes(query.toLowerCase())
  )

  const handleSelect = (type: string, id: string) => {
    switch (type) {
      case 'host':
        setActiveHost(id)
        break
      case 'session':
        setActiveSession(id)
        break
    }
    close()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[10vh] z-50 p-4" onClick={close}>
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[500px] shadow-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 p-3 border-b border-[var(--line)]">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-text-3 flex-shrink-0">
            <circle cx={11} cy={11} r={8} /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            className="flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3 text-sm"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
          />
          <button onClick={close} className="text-text-3 hover:text-text-1 active:text-accent p-1 flex-shrink-0">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {filteredHosts.length > 0 && (
            <div>
              <div className="px-3 py-2 text-text-3 text-xs">{t('palette.hosts')}</div>
              {filteredHosts.map((host: any) => (
                <button
                  key={host.id}
                  onClick={() => handleSelect('host', host.id)}
                  className="w-full px-3 py-2.5 text-left active:bg-bg-2 flex items-center gap-3"
                >
                  <div className={`w-2 h-2 rounded-full ${host.status === 'online' ? 'bg-accent-2' : 'bg-danger'}`} />
                  <div>
                    <div className="text-text-1 text-sm">{host.name}</div>
                    <div className="text-text-3 text-xs">{host.address}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {filteredSessions.length > 0 && (
            <div>
              <div className="px-3 py-2 text-text-3 text-xs">{t('palette.sessions')}</div>
              {filteredSessions.map((session: any) => (
                <button
                  key={session.id}
                  onClick={() => handleSelect('session', session.id)}
                  className="w-full px-3 py-2.5 text-left active:bg-bg-2 flex items-center gap-3"
                >
                  <div className="text-accent text-sm">&#9654;</div>
                  <div>
                    <div className="text-text-1 text-sm">{session.name}</div>
                    <div className="text-text-3 text-xs">{t('palette.windows', { count: session.windowCount })}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {filteredHosts.length === 0 && filteredSessions.length === 0 && (
            <div className="px-3 py-6 text-text-3 text-sm text-center">
              {t('palette.noResults')}
            </div>
          )}
        </div>

        <div className="hidden lg:flex p-2 border-t border-[var(--line)] items-center justify-between text-text-3 text-xs">
          <span>{t('palette.navigate')}</span>
          <span>{t('palette.select')}</span>
          <span>{t('palette.close')}</span>
        </div>
      </div>
    </div>
  )
}
