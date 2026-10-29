'use client'
import { FiFilePlus, FiFolder, FiPlusSquare } from 'react-icons/fi'
import { useTranslation } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'

/**
 * 编辑区空态：替代原来居中一行灰字。
 * 只做「下一步能做什么」的引导，不引入新的业务动作——
 * 打开文件面板 / 新建会话 都走既有 store 与事件，避免空态自己发 RPC。
 */
export function WorkspaceEmptyState({ dropActive }: { dropActive: boolean }) {
  const { t } = useTranslation()
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  return (
    <div className="tmuxgo-workspace-empty">
      <span className="tmuxgo-workspace-empty__glyph">
        <FiFilePlus aria-hidden="true" size={20} />
      </span>
      <div className="tmuxgo-workspace-empty__title">
        {dropActive ? t('workspace.empty.dropTitle') : t('workspace.empty.title')}
      </div>
      <p className="tmuxgo-workspace-empty__desc">
        {dropActive ? t('workspace.empty.dropDesc') : t('workspace.empty.desc')}
      </p>
      <div className="tmuxgo-workspace-empty__actions">
        <button
          type="button"
          onClick={toggleFilePanel}
          className="tmuxgo-button tmuxgo-button--sm inline-flex items-center gap-2"
        >
          <FiFolder aria-hidden="true" size={13} />
          {t('workspace.empty.browse')}
        </button>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('tmuxgo-new-session'))}
          className="tmuxgo-button tmuxgo-button--sm inline-flex items-center gap-2"
        >
          <FiPlusSquare aria-hidden="true" size={13} />
          {t('workspace.empty.newSession')}
        </button>
      </div>
      <p className="tmuxgo-workspace-empty__hint">
        <kbd>⌘</kbd>
        <kbd>K</kbd>
        {t('workspace.empty.paletteHint')}
        <span className="mx-2 text-text-3/40">·</span>
        <FiFilePlus aria-hidden="true" className="inline align-[-2px]" size={11} /> {t('workspace.empty.dragHint')}
      </p>
    </div>
  )
}
