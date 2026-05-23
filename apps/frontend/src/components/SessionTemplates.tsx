'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'

interface Template {
  id: string
  name: string
  description: string
  layout: {
    windows: {
      name: string
      panes: { command?: string }[]
    }[]
  }
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-1 border border-[var(--line)] rounded-lg w-full max-w-[600px] max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-[var(--line)]">
          <h2 className="text-text-1 text-lg font-medium">{t('templates.title')}</h2>
          <p className="text-text-3 text-sm mt-1">{t('templates.desc')}</p>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 overflow-y-auto max-h-[60vh]">
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
    </div>
  )
}

export { templates }
export type { Template }
