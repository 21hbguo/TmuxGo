'use client'

import { useState, useEffect } from 'react'
import { AuditLog } from './AuditLog'
import { usePreferences } from '@/hooks/usePreferences'
import { useTranslation } from '@/i18n'

interface SettingsProps {
  onClose: () => void
}

export function Settings({ onClose }: SettingsProps) {
  const { preferences, updatePreferences, resetPreferences } = usePreferences()
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'audit'>('general')
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [terminalPaddingDraft, setTerminalPaddingDraft] = useState(preferences.terminalPadding)
  useEffect(() => {
    setTerminalPaddingDraft(preferences.terminalPadding)
  }, [preferences.terminalPadding, activeTab])

  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'appearance' as const, label: t('settings.appearance') },
    { id: 'audit' as const, label: t('settings.auditLog') },
  ]

  const commitTerminalPadding = () => {
    if (terminalPaddingDraft === preferences.terminalPadding) return
    updatePreferences({ terminalPadding: terminalPaddingDraft })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[700px] max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-[var(--line)] flex items-center justify-between">
          <h2 className="text-text-1 text-lg font-medium">{t('settings.title')}</h2>
          <button onClick={onClose} className="text-text-3 hover:text-text-1">✕</button>
        </div>

        <div className="flex border-b border-[var(--line)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm ${
                activeTab === tab.id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-text-3 hover:text-text-1'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.language')}</h3>
                <select
                  value={preferences.language}
                  onChange={(e) => updatePreferences({ language: e.target.value as 'zh' | 'en' })}
                  className="bg-bg-2 text-text-1 text-sm px-3 py-2 rounded outline-none border border-[var(--line)]"
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.connection')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.autoReconnect')}</span>
                    <button
                      onClick={() => updatePreferences({ autoReconnect: !preferences.autoReconnect })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.autoReconnect ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.autoReconnect ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.reconnectInterval')}</span>
                    <span className="text-text-1 text-sm">{preferences.reconnectInterval / 1000}s</span>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.terminal')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.fontSize')}</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => updatePreferences({ fontSize: Math.max(12, preferences.fontSize - 1) })}
                        className="px-2 py-1 bg-bg-2 rounded text-text-2"
                      >
                        -
                      </button>
                      <span className="text-text-1 text-sm w-8 text-center">{preferences.fontSize}px</span>
                      <button
                        onClick={() => updatePreferences({ fontSize: Math.min(20, preferences.fontSize + 1) })}
                        className="px-2 py-1 bg-bg-2 rounded text-text-2"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.fontFamily')}</span>
                    <select
                      value={preferences.fontFamily}
                      onChange={(e) => updatePreferences({ fontFamily: e.target.value })}
                      className="bg-bg-2 text-text-1 text-sm px-3 py-1.5 rounded outline-none border border-[var(--line)]"
                    >
                      <option value="JetBrains Mono, monospace">JetBrains Mono</option>
                      <option value="Fira Code, monospace">Fira Code</option>
                      <option value="monospace">Monospace</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.cursorBlink')}</span>
                    <button
                      onClick={() => updatePreferences({ cursorBlink: !preferences.cursorBlink })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.cursorBlink ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.cursorBlink ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.terminalPadding')}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={20}
                        value={terminalPaddingDraft}
                        onChange={(e) => setTerminalPaddingDraft(Number(e.target.value))}
                        onMouseUp={commitTerminalPadding}
                        onTouchEnd={commitTerminalPadding}
                        onKeyUp={commitTerminalPadding}
                        className="w-24 accent-accent"
                      />
                      <span className="text-text-1 text-sm w-8 text-center">{terminalPaddingDraft}px</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-[var(--line)]">
                <button
                  onClick={resetPreferences}
                  className="px-4 py-2 bg-bg-2 rounded text-text-2 text-sm hover:bg-bg-1"
                >
                  {t('settings.resetDefaults')}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.theme')}</h3>
                <div className="grid grid-cols-3 gap-3">
                  {(['dark', 'light', 'high-contrast', 'dracula', 'nord', 'catppuccin'] as const).map((theme) => {
                    const key = theme === 'high-contrast' ? 'highContrast' : theme
                    return (
                      <button
                        key={theme}
                        onClick={() => updatePreferences({ theme })}
                        className={`p-3 bg-bg-2 rounded-lg border-2 ${
                          preferences.theme === theme ? 'border-accent' : 'border-transparent'
                        }`}
                      >
                        <div className="text-text-1 text-sm">
                          {t(`settings.theme.${key}` as any)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <h3 className="text-text-1 text-sm font-medium mb-3">{t('settings.layout')}</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.sidebarPosition')}</span>
                    <div className="flex gap-2">
                      {(['left', 'right'] as const).map((pos) => (
                        <button
                          key={pos}
                          onClick={() => updatePreferences({ sidebarPosition: pos })}
                          className={`px-3 py-1.5 rounded text-sm ${
                            preferences.sidebarPosition === pos
                              ? 'bg-accent text-bg-0'
                              : 'bg-bg-2 text-text-2'
                          }`}
                        >
                          {pos}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.showStatusBar')}</span>
                    <button
                      onClick={() => updatePreferences({ showStatusBar: !preferences.showStatusBar })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.showStatusBar ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.showStatusBar ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-text-2 text-sm">{t('settings.showQuickActions')}</span>
                    <button
                      onClick={() => updatePreferences({ showQuickActions: !preferences.showQuickActions })}
                      className={`w-10 h-6 rounded-full relative ${
                        preferences.showQuickActions ? 'bg-accent' : 'bg-bg-2'
                      }`}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                          preferences.showQuickActions ? 'right-1' : 'left-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'audit' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-text-1 text-sm font-medium">{t('settings.auditLog')}</h3>
                  <p className="text-text-3 text-xs mt-1">{t('settings.auditDesc')}</p>
                </div>
                <button
                  onClick={() => setShowAuditLog(true)}
                  className="px-4 py-2 bg-accent text-bg-0 rounded text-sm"
                >
                  {t('settings.viewLog')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showAuditLog && <AuditLog onClose={() => setShowAuditLog(false)} />}
    </div>
  )
}
