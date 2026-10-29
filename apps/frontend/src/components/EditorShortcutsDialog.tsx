'use client'
import { EDITOR_COMMANDS, formatKeybinding, type EditorCommandGroup } from '@/lib/editor-commands'
import { isApplePlatform } from '@/lib/terminal-platform'
import { useTranslation } from '@/i18n'
import { ModalPortal } from './ModalPortal'
import { Button } from './Button'
import { FiX } from 'react-icons/fi'

interface EditorShortcutsDialogProps {
  open: boolean
  onClose: () => void
}

const GROUP_ORDER: EditorCommandGroup[] = ['navigation', 'edit', 'view', 'tabs']

// 快捷键看板：直接由命令表渲染，新增命令不必再改这里——
// 命令表是唯一事实源，避免「文档写了但键没绑」的漂移
export function EditorShortcutsDialog({ open, onClose }: EditorShortcutsDialogProps) {
  const { t } = useTranslation()
  if (!open) return null
  const isMac = isApplePlatform()
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: t(`editor.shortcuts.${group}` as const),
    commands: EDITOR_COMMANDS.filter((command) => command.group === group && command.keybinding),
  })).filter((section) => section.commands.length > 0)

  return (
    <ModalPortal modal onEscape={onClose}>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('editor.shortcuts.title')}
          data-testid="editor-shortcuts"
          onClick={(event) => event.stopPropagation()}
          className="flex max-h-[min(34rem,85vh)] w-[min(46rem,100%)] flex-col overflow-hidden rounded-apple border border-[var(--line-strong)] bg-bg-1 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-1">{t('editor.shortcuts.title')}</div>
              <div className="mt-0.5 text-[11px] text-text-3">{t('editor.shortcuts.hint')}</div>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={t('editor.shortcuts.close')} onClick={onClose}>
              <FiX size={14} />
            </Button>
          </div>
          <div className="tmuxgo-scrollbar grid min-h-0 flex-1 grid-cols-1 gap-x-8 gap-y-4 overflow-y-auto px-4 py-3 sm:grid-cols-2">
            {grouped.map((section) => (
              <section key={section.group} aria-label={section.label}>
                <h3 className="mb-1 text-[10px] uppercase tracking-[0.16em] text-text-3">{section.label}</h3>
                <ul className="space-y-0.5">
                  {section.commands.map((command) => (
                    <li key={command.id} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-text-2">{t(command.titleKey)}</span>
                      <kbd className="shrink-0 rounded border border-[var(--line)] bg-bg-0/70 px-1.5 py-0.5 font-mono text-[10px] text-text-3">
                        {formatKeybinding(command.keybinding, isMac)}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
