'use client'

import { useState, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

export function CommandPalette() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { hosts, sessions, toggleCommandPalette, setActiveHost, setActiveSession } = useConsoleStore()
  const { t } = useTranslation()

  useEffect(() => {
    inputRef.current?.focus()
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
    toggleCommandPalette()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50" onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        toggleCommandPalette()
      }
    }}>
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-[500px] shadow-lg overflow-hidden" onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          toggleCommandPalette()
        }
      }}>
        <div className="p-3 border-b border-[var(--line)]">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            className="w-full bg-transparent text-text-1 outline-none placeholder:text-text-3"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                toggleCommandPalette()
              }
            }}
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto">
          {filteredHosts.length > 0 && (
            <div>
              <div className="px-3 py-2 text-text-3 text-xs">{t('palette.hosts')}</div>
              {filteredHosts.map((host: any) => (
                <button
                  key={host.id}
                  onClick={() => handleSelect('host', host.id)}
                  className="w-full px-3 py-2 text-left hover:bg-bg-2 flex items-center gap-3"
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
                  className="w-full px-3 py-2 text-left hover:bg-bg-2 flex items-center gap-3"
                >
                  <div className="text-accent text-sm">▸</div>
                  <div>
                    <div className="text-text-1 text-sm">{session.name}</div>
                    <div className="text-text-3 text-xs">{t('palette.windows', { count: session.windowCount })}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {filteredHosts.length === 0 && filteredSessions.length === 0 && (
            <div className="px-3 py-4 text-text-3 text-sm text-center">
              {t('palette.noResults')}
            </div>
          )}
        </div>

        <div className="p-2 border-t border-[var(--line)] flex items-center justify-between text-text-3 text-xs">
          <span>{t('palette.navigate')}</span>
          <span>{t('palette.select')}</span>
          <span>{t('palette.close')}</span>
        </div>
      </div>
    </div>
  )
}
