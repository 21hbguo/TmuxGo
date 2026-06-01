'use client'

import { useMemo, useState } from 'react'
import { useTranslation } from '@/i18n'
import type { SessionLayout, SessionWindowLayoutPreset, SessionWindowSplitDirection } from '@/types'

interface Template {
  id: string
  name: string
  description: string
  layout: SessionLayout
}

const templates: Template[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Single window with one pane',
    layout: {
      windows: [{ name: 'main', panes: [{}] }],
    },
  },
  {
    id: 'dev',
    name: 'Development',
    description: 'Editor + terminal + server',
    layout: {
      windows: [
        { name: 'editor', panes: [{ command: 'vim' }] },
        { name: 'terminal', panes: [{}] },
        { name: 'server', panes: [{ command: 'npm run dev' }] },
      ],
    },
  },
  {
    id: 'monitor',
    name: 'Monitoring',
    description: 'Multiple monitoring panes',
    layout: {
      windows: [
        {
          name: 'monitor',
          panes: [
            { command: 'htop' },
            { command: 'docker stats' },
          ],
        },
      ],
    },
  },
  {
    id: 'training',
    name: 'ML Training',
    description: 'Training + monitoring + logs',
    layout: {
      windows: [
        { name: 'training', panes: [{ command: 'python train.py' }] },
        { name: 'gpu', panes: [{ command: 'nvidia-smi -l 1' }] },
        { name: 'logs', panes: [{ command: 'tail -f logs/train.log' }] },
      ],
    },
  },
]
interface CustomWindowConfig {
  id: string
  name: string
  paneCount: number
  splitDirection: SessionWindowSplitDirection
  layoutPreset: SessionWindowLayoutPreset
}
const maxCustomWindows = 6
const maxCustomPanes = 6
const minCustomPanes = 1
const layoutPresetOptions: Array<{ value: SessionWindowLayoutPreset; label: string }> = [
  { value: 'tiled', label: 'templates.layout.tiled' },
  { value: 'even-horizontal', label: 'templates.layout.evenHorizontal' },
  { value: 'even-vertical', label: 'templates.layout.evenVertical' },
  { value: 'main-horizontal', label: 'templates.layout.mainHorizontal' },
  { value: 'main-vertical', label: 'templates.layout.mainVertical' },
]
const splitDirectionOptions: Array<{ value: SessionWindowSplitDirection; label: string }> = [
  { value: 'horizontal', label: 'templates.split.horizontal' },
  { value: 'vertical', label: 'templates.split.vertical' },
]
function createCustomWindow(index: number): CustomWindowConfig {
  return {
    id: `custom-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    name: `win-${index + 1}`,
    paneCount: 1,
    splitDirection: 'horizontal',
    layoutPreset: 'tiled',
  }
}
function clampPaneCount(value: number) {
  if (!Number.isFinite(value)) return minCustomPanes
  return Math.max(minCustomPanes, Math.min(maxCustomPanes, Math.floor(value)))
}

const templateI18nKeys: Record<string, { name: string; desc: string }> = {
  default: { name: 'templates.default', desc: 'templates.defaultDesc' },
  dev: { name: 'templates.development', desc: 'templates.developmentDesc' },
  monitor: { name: 'templates.monitoring', desc: 'templates.monitoringDesc' },
  training: { name: 'templates.training', desc: 'templates.trainingDesc' },
}

interface SessionTemplatesProps {
  onSelect: (template: Template) => void
  onClose: () => void
}

export function SessionTemplates({ onSelect, onClose }: SessionTemplatesProps) {
  const { t } = useTranslation()
  const [showCustom, setShowCustom] = useState(false)
  const [customWindows, setCustomWindows] = useState<CustomWindowConfig[]>([createCustomWindow(0)])
  const customLayout = useMemo<SessionLayout>(() => ({
    windows: customWindows.map((window, index) => ({
      name: window.name.trim() || `win-${index + 1}`,
      panes: Array.from({ length: clampPaneCount(window.paneCount) }, () => ({})),
      splitDirection: window.splitDirection,
      layoutPreset: window.layoutPreset,
    })),
  }), [customWindows])
  const updateCustomWindow = (id: string, patch: Partial<CustomWindowConfig>) => {
    setCustomWindows((prev) => prev.map((window) => window.id === id ? { ...window, ...patch } : window))
  }
  const addCustomWindow = () => {
    setCustomWindows((prev) => {
      if (prev.length >= maxCustomWindows) return prev
      return [...prev, createCustomWindow(prev.length)]
    })
  }
  const removeCustomWindow = (id: string) => {
    setCustomWindows((prev) => prev.length <= 1 ? prev : prev.filter((window) => window.id !== id))
  }
  const handleCustomCreate = () => {
    onSelect({ id: 'custom', name: 'custom', description: 'custom', layout: customLayout })
    setShowCustom(false)
  }
  const handleCustomClose = () => {
    setShowCustom(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[600px] max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-[var(--line)]">
          <h2 className="text-text-1 text-lg font-medium">{t('templates.title')}</h2>
          <p className="text-text-3 text-sm mt-1">{t('templates.desc')}</p>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 overflow-y-auto max-h-[60vh]">
          <button
            onClick={() => setShowCustom(true)}
            className="p-4 bg-bg-2 rounded-lg hover:bg-bg-1 border border-dashed border-accent/40 hover:border-accent transition-colors text-left"
          >
            <div className="text-text-1 font-medium">{t('templates.custom')}</div>
            <div className="text-text-3 text-sm mt-1">{t('templates.customDesc')}</div>
            <div className="flex gap-2 mt-3">
              <div className="px-2 py-1 bg-bg-1 rounded text-text-3 text-xs">{t('templates.windowRange', { count: maxCustomWindows })}</div>
              <div className="px-2 py-1 bg-bg-1 rounded text-text-3 text-xs">{t('templates.paneRange', { count: maxCustomPanes })}</div>
            </div>
          </button>
          {templates.map((template) => (
            <button
              key={template.id}
              onClick={() => onSelect(template)}
              className="p-4 bg-bg-2 rounded-lg hover:bg-bg-1 border border-transparent hover:border-accent transition-colors text-left"
            >
              <div className="text-text-1 font-medium">{t(templateI18nKeys[template.id].name as any)}</div>
              <div className="text-text-3 text-sm mt-1">{t(templateI18nKeys[template.id].desc as any)}</div>
              <div className="flex gap-2 mt-3">
                {template.layout.windows.map((w, i) => (
                  <div key={i} className="px-2 py-1 bg-bg-1 rounded text-text-3 text-xs">
                    {w.name} ({w.panes.length})
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-[var(--line)] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-text-3 hover:text-text-1"
          >
            {t('templates.cancel')}
          </button>
        </div>
      </div>
      {showCustom && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={handleCustomClose}>
          <div className="w-full max-w-3xl max-h-[86vh] rounded-lg border border-[var(--line)] bg-bg-1 p-4 overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg text-text-1">{t('templates.custom')}</div>
            <div className="mt-1 text-sm text-text-3">{t('templates.customDesc')}</div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto space-y-3 pr-1">
              {customWindows.map((window, index) => (
                <div key={window.id} className="rounded-lg border border-[var(--line)] bg-bg-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-text-3">{t('templates.windowIndex', { index: index + 1 })}</div>
                    <button onClick={() => removeCustomWindow(window.id)} disabled={customWindows.length <= 1} className="rounded px-2 py-1 text-xs text-text-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40">×</button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-4">
                    <input value={window.name} onChange={(e) => updateCustomWindow(window.id, { name: e.target.value })} className="tmuxgo-control tmuxgo-input w-full rounded px-2 py-1.5 text-sm" placeholder={t('templates.windowNamePlaceholder', { index: index + 1 })} />
                    <input type="number" min={minCustomPanes} max={maxCustomPanes} value={window.paneCount} onChange={(e) => updateCustomWindow(window.id, { paneCount: clampPaneCount(Number(e.target.value)) })} className="tmuxgo-control tmuxgo-input w-full rounded px-2 py-1.5 text-sm" />
                    <select value={window.splitDirection} onChange={(e) => updateCustomWindow(window.id, { splitDirection: e.target.value as SessionWindowSplitDirection })} className="tmuxgo-control tmuxgo-select w-full rounded px-2 py-1.5 text-sm">
                      {splitDirectionOptions.map((item) => <option key={item.value} value={item.value}>{t(item.label as any)}</option>)}
                    </select>
                    <select value={window.layoutPreset} onChange={(e) => updateCustomWindow(window.id, { layoutPreset: e.target.value as SessionWindowLayoutPreset })} className="tmuxgo-control tmuxgo-select w-full rounded px-2 py-1.5 text-sm">
                      {layoutPresetOptions.map((item) => <option key={item.value} value={item.value}>{t(item.label as any)}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
              <button onClick={addCustomWindow} disabled={customWindows.length >= maxCustomWindows} className="rounded px-3 py-2 text-sm bg-bg-2 text-text-2 hover:bg-bg-0 disabled:cursor-not-allowed disabled:opacity-50">+ {t('templates.addWindow')}</button>
              <div className="flex items-center gap-2">
                <button onClick={handleCustomClose} className="rounded px-3 py-2 text-sm text-text-3 hover:text-text-1">{t('common.cancel')}</button>
                <button onClick={handleCustomCreate} className="rounded px-3 py-2 text-sm bg-accent/20 text-accent hover:bg-accent/30">{t('common.confirm')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export { templates }
export type { Template }
