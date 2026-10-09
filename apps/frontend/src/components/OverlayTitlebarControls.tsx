'use client'
import { FiMaximize2, FiMinimize, FiMinimize2, FiMinus } from 'react-icons/fi'
import { VscPinned } from 'react-icons/vsc'
import { Button } from './Button'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { DesktopViewMode } from '@/stores/useConsoleStore'

// desktop/browser 覆盖层共享的标题栏尾部按钮簇：全屏/最小化/窗口化/置顶
interface OverlayTitlebarControlsProps {
  ns: 'vnc' | 'browser'
  isMobileLayout: boolean
  isFullscreen: boolean
  onToggleFullscreen: () => void
  view: DesktopViewMode
  onViewChange: (view: DesktopViewMode) => void
  onMinimize: () => void
  pinned?: boolean
  onPinnedChange?: (pinned: boolean) => void
}

export function OverlayTitlebarControls({
  ns,
  isMobileLayout,
  isFullscreen,
  onToggleFullscreen,
  view,
  onViewChange,
  onMinimize,
  pinned,
  onPinnedChange,
}: OverlayTitlebarControlsProps) {
  const { t } = useTranslation()
  const key = (suffix: string) => `${ns}.${suffix}` as TranslationKey
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleFullscreen}
        aria-label={t(key('fullscreen'))}
        data-tip={t(key('fullscreen'))}
        className={`tmuxgo-tip ${isFullscreen ? 'text-accent' : ''}`}
      >
        {isFullscreen ? <FiMinimize size={14} /> : <FiMaximize2 size={14} />}
      </Button>
      {!isMobileLayout && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onMinimize}
          aria-label={t(key('minimize'))}
          data-tip={t(key('minimize'))}
          className="tmuxgo-tip"
        >
          <FiMinus size={14} />
        </Button>
      )}
      {/* 窗口化仅 PC:MIN_W=420 > 移动屏宽,修好前不给入口;view==='window' 时点击回 'full' */}
      {!isMobileLayout && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onViewChange(view === 'window' ? 'full' : 'window')}
          aria-label={view === 'window' ? t(key('fullView')) : t(key('windowed'))}
          data-tip={view === 'window' ? t(key('fullView')) : t(key('windowed'))}
          className={`tmuxgo-tip ${view === 'window' ? 'text-accent' : ''}`}
        >
          <FiMinimize2 size={14} />
        </Button>
      )}
      {/* 浮窗置顶：固定后点背景不再最小化，且背景可正常交互 */}
      {!isMobileLayout && view === 'window' && onPinnedChange && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onPinnedChange(!pinned)}
          aria-label={pinned ? t(key('unpin')) : t(key('pin'))}
          data-tip={pinned ? t(key('unpin')) : t(key('pin'))}
          className={`tmuxgo-tip ${pinned ? 'text-accent' : ''}`}
        >
          <VscPinned size={14} />
        </Button>
      )}
    </>
  )
}
