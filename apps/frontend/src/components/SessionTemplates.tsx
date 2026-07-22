'use client'
import { useState } from 'react'
import { useTranslation } from '@/i18n'
import { useSessionTemplates, useUpdateSessionTemplates } from '@/hooks/useApi'
import type { SessionLayout, SessionTemplate, SessionWindowLayoutPreset, SessionWindowSplitDirection } from '@/types'

interface CustomPaneConfig {
  id: string
  command: string
  cwd: string
  env: string
}
interface CustomWindowConfig {
  id: string
  name: string
  panes: CustomPaneConfig[]
  splitDirection: SessionWindowSplitDirection
  layoutPreset: SessionWindowLayoutPreset
}
const maxCustomWindows = 6
const maxCustomPanes = 6
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
function createPane(index: number): CustomPaneConfig {
  return { id: `pane-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, command: '', cwd: '', env: '' }
}
function createWindow(index: number): CustomWindowConfig {
  return { id: `window-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, name: `win-${index + 1}`, panes: [createPane(0)], splitDirection: 'horizontal', layoutPreset: 'tiled' }
}
function parseEnv(value: string) {
  const env: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const index = line.indexOf('=')
    const key = index > 0 ? line.slice(0, index).trim() : ''
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = line.slice(index + 1)
  }
  return env
}
function toCustomWindows(template: SessionTemplate) {
  return template.layout.windows.map((window, windowIndex) => ({ id: `window-${Date.now()}-${windowIndex}`, name: window.name, splitDirection: window.splitDirection || 'horizontal', layoutPreset: window.layoutPreset || 'tiled', panes: window.panes.map((pane, paneIndex) => ({ id: `pane-${Date.now()}-${windowIndex}-${paneIndex}`, command: pane.command || '', cwd: pane.cwd || '', env: Object.entries(pane.env || {}).map(([key, value]) => `${key}=${value}`).join('\n') })) }))
}
const templates: SessionTemplate[] = [
  { id: 'default', name: 'Default', description: 'Single window with one pane', layout: { windows: [{ name: 'main', panes: [{}] }] } },
  { id: 'dev', name: 'Development', description: 'Editor + terminal + server', layout: { windows: [{ name: 'editor', panes: [{ command: 'vim' }] }, { name: 'terminal', panes: [{}] }, { name: 'server', panes: [{ command: 'npm run dev' }] }] } },
  { id: 'monitor', name: 'Monitoring', description: 'Multiple monitoring panes', layout: { windows: [{ name: 'monitor', panes: [{ command: 'htop' }, { command: 'docker stats' }] }] } },
  { id: 'training', name: 'ML Training', description: 'Training + monitoring + logs', layout: { windows: [{ name: 'training', panes: [{ command: 'python train.py' }] }, { name: 'gpu', panes: [{ command: 'nvidia-smi -l 1' }] }, { name: 'logs', panes: [{ command: 'tail -f logs/train.log' }] }] } },
]
const templateI18nKeys: Record<string, { name: string; desc: string }> = {
  default: { name: 'templates.default', desc: 'templates.defaultDesc' },
  dev: { name: 'templates.development', desc: 'templates.developmentDesc' },
  monitor: { name: 'templates.monitoring', desc: 'templates.monitoringDesc' },
  training: { name: 'templates.training', desc: 'templates.trainingDesc' },
}
export function SessionTemplates({ onSelect, onClose }: { onSelect: (template: SessionTemplate) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const { data } = useSessionTemplates()
  const updateTemplates = useUpdateSessionTemplates()
  const savedTemplates = data?.templates || []
  const [showCustom, setShowCustom] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [templateName, setTemplateName] = useState('Custom')
  const [templateDescription, setTemplateDescription] = useState('')
  const [customWindows, setCustomWindows] = useState<CustomWindowConfig[]>([createWindow(0)])
  const openCustom = (template?: SessionTemplate) => {
    setEditingId(template?.id || '')
    setTemplateName(template?.name || 'Custom')
    setTemplateDescription(template?.description || '')
    setCustomWindows(template ? toCustomWindows(template) : [createWindow(0)])
    setShowCustom(true)
  }
  const updateWindow = (id: string, patch: Partial<CustomWindowConfig>) => setCustomWindows((current) => current.map((window) => window.id === id ? { ...window, ...patch } : window))
  const updatePane = (windowId: string, paneId: string, patch: Partial<CustomPaneConfig>) => setCustomWindows((current) => current.map((window) => window.id === windowId ? { ...window, panes: window.panes.map((pane) => pane.id === paneId ? { ...pane, ...patch } : pane) } : window))
  const addWindow = () => setCustomWindows((current) => current.length >= maxCustomWindows ? current : [...current, createWindow(current.length)])
  const addPane = (windowId: string) => setCustomWindows((current) => current.map((window) => window.id === windowId && window.panes.length < maxCustomPanes ? { ...window, panes: [...window.panes, createPane(window.panes.length)] } : window))
  const removeWindow = (id: string) => setCustomWindows((current) => current.length <= 1 ? current : current.filter((window) => window.id !== id))
  const removePane = (windowId: string, paneId: string) => setCustomWindows((current) => current.map((window) => window.id === windowId && window.panes.length > 1 ? { ...window, panes: window.panes.filter((pane) => pane.id !== paneId) } : window))
  const buildTemplate = (): SessionTemplate => {
    const now = new Date().toISOString()
    const layout: SessionLayout = { windows: customWindows.map((window, index) => ({ name: window.name.trim() || `win-${index + 1}`, splitDirection: window.splitDirection, layoutPreset: window.layoutPreset, panes: window.panes.map((pane) => ({ command: pane.command.trim() || undefined, cwd: pane.cwd.trim() || undefined, env: Object.keys(parseEnv(pane.env)).length ? parseEnv(pane.env) : undefined })) })) }
    const existing = savedTemplates.find((template) => template.id === editingId)
    return { id: editingId || `custom-${Date.now().toString(36)}`, name: templateName.trim() || 'Custom', description: templateDescription.trim(), layout, createdAt: existing?.createdAt || now, updatedAt: now }
  }
  const createTemplate = async (save: boolean) => {
    const template = buildTemplate()
    if (save) await updateTemplates.mutateAsync([...savedTemplates.filter((item) => item.id !== template.id), template])
    onSelect(template)
    setShowCustom(false)
  }
  const deleteTemplate = async (id: string) => updateTemplates.mutateAsync(savedTemplates.filter((template) => template.id !== id))
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"><div className="tmuxgo-glass tmuxgo-glass-dialog flex max-h-[85vh] w-full max-w-[720px] flex-col overflow-hidden rounded-lg border"><div className="border-b border-[var(--line)] p-4"><h2 className="text-lg font-medium text-text-1">{t('templates.title')}</h2><p className="mt-1 text-sm text-text-3">{t('templates.desc')}</p></div><div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2"><button onClick={() => openCustom()} className="rounded-lg border border-dashed border-accent/40 bg-bg-2 p-4 text-left hover:border-accent hover:bg-bg-1"><div className="font-medium text-text-1">{t('templates.custom')}</div><div className="mt-1 text-sm text-text-3">{t('templates.customDesc')}</div></button>{templates.map((template) => <button key={template.id} onClick={() => onSelect(template)} className="rounded-lg border border-transparent bg-bg-2 p-4 text-left hover:border-accent hover:bg-bg-1"><div className="font-medium text-text-1">{t(templateI18nKeys[template.id].name as any)}</div><div className="mt-1 text-sm text-text-3">{t(templateI18nKeys[template.id].desc as any)}</div><div className="mt-3 text-xs text-text-3">{template.layout.windows.map((window) => `${window.name} (${window.panes.length})`).join(' · ')}</div></button>)}{savedTemplates.map((template) => <div key={template.id} className="rounded-lg border border-[var(--line)] bg-bg-2 p-4"><button onClick={() => onSelect(template)} className="block w-full text-left"><div className="font-medium text-text-1">{template.name}</div><div className="mt-1 text-sm text-text-3">{template.description || t('templates.saved')}</div><div className="mt-3 text-xs text-text-3">{template.layout.windows.map((window) => `${window.name} (${window.panes.length})`).join(' · ')}</div></button><div className="mt-3 flex gap-2"><button onClick={() => openCustom(template)} className="tmuxgo-chip tmuxgo-chip--accent">{t('templates.edit')}</button><button onClick={() => void deleteTemplate(template.id)} className="tmuxgo-chip tmuxgo-chip--danger">{t('templates.delete')}</button></div></div>)}</div><div className="flex justify-end border-t border-[var(--line)] p-4"><button onClick={onClose} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--sm">{t('templates.cancel')}</button></div></div>{showCustom && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowCustom(false)}><div className="tmuxgo-glass tmuxgo-glass-dialog flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border p-4" onClick={(event) => event.stopPropagation()}><div className="grid gap-2 sm:grid-cols-2"><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={t('templates.name')} className="tmuxgo-control tmuxgo-input rounded px-3 py-2 text-sm" /><input value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} placeholder={t('templates.description')} className="tmuxgo-control tmuxgo-input rounded px-3 py-2 text-sm" /></div><div className="tmuxgo-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">{customWindows.map((window, windowIndex) => <div key={window.id} className="rounded-lg border border-[var(--line)] bg-bg-2 p-3"><div className="flex items-center gap-2"><input value={window.name} onChange={(event) => updateWindow(window.id, { name: event.target.value })} className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded px-2 py-1.5 text-sm" placeholder={t('templates.windowNamePlaceholder', { index: windowIndex + 1 })} /><select value={window.splitDirection} onChange={(event) => updateWindow(window.id, { splitDirection: event.target.value as SessionWindowSplitDirection })} className="tmuxgo-control tmuxgo-select rounded px-2 py-1.5 text-xs">{splitDirectionOptions.map((item) => <option key={item.value} value={item.value}>{t(item.label as any)}</option>)}</select><select value={window.layoutPreset} onChange={(event) => updateWindow(window.id, { layoutPreset: event.target.value as SessionWindowLayoutPreset })} className="tmuxgo-control tmuxgo-select rounded px-2 py-1.5 text-xs">{layoutPresetOptions.map((item) => <option key={item.value} value={item.value}>{t(item.label as any)}</option>)}</select><button onClick={() => removeWindow(window.id)} disabled={customWindows.length <= 1} className="tmuxgo-chip tmuxgo-chip--danger disabled:cursor-not-allowed">×</button></div><div className="mt-3 space-y-2">{window.panes.map((pane, paneIndex) => <div key={pane.id} className="grid gap-2 rounded border border-[var(--line)] bg-bg-0 p-2 md:grid-cols-[80px_1fr_1fr_1fr_28px]"><div className="self-center text-xs text-text-3">{t('templates.paneIndex', { index: paneIndex + 1 })}</div><input value={pane.command} onChange={(event) => updatePane(window.id, pane.id, { command: event.target.value })} placeholder={t('templates.command')} className="tmuxgo-control tmuxgo-input rounded px-2 py-1.5 font-mono text-xs" /><input value={pane.cwd} onChange={(event) => updatePane(window.id, pane.id, { cwd: event.target.value })} placeholder={t('templates.cwd')} className="tmuxgo-control tmuxgo-input rounded px-2 py-1.5 font-mono text-xs" /><textarea value={pane.env} onChange={(event) => updatePane(window.id, pane.id, { env: event.target.value })} placeholder={t('templates.env')} rows={1} className="tmuxgo-control tmuxgo-input resize-none rounded px-2 py-1.5 font-mono text-xs" /><button onClick={() => removePane(window.id, pane.id)} disabled={window.panes.length <= 1} className="tmuxgo-chip tmuxgo-chip--danger disabled:cursor-not-allowed">×</button></div>)}</div><button onClick={() => addPane(window.id)} disabled={window.panes.length >= maxCustomPanes} className="tmuxgo-chip tmuxgo-chip--accent mt-2 disabled:cursor-not-allowed">+ {t('templates.addPane')}</button></div>)}</div><div className="mt-4 flex items-center justify-between gap-2"><button onClick={addWindow} disabled={customWindows.length >= maxCustomWindows} className="tmuxgo-button tmuxgo-button--sm disabled:cursor-not-allowed">+ {t('templates.addWindow')}</button><div className="flex gap-2"><button onClick={() => setShowCustom(false)} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--sm">{t('common.cancel')}</button><button onClick={() => void createTemplate(false)} className="tmuxgo-button tmuxgo-button--sm">{t('templates.runOnce')}</button><button onClick={() => void createTemplate(true)} disabled={updateTemplates.isPending} className="tmuxgo-button tmuxgo-button--primary tmuxgo-button--sm disabled:cursor-not-allowed">{t('templates.saveAndCreate')}</button></div></div></div></div>}</div>
}
export { templates }
export type Template = SessionTemplate
