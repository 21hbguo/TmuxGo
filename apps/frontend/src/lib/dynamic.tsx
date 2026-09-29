'use client'

import {
  Component,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
} from 'react'
import { FiAlertTriangle, FiRefreshCw } from 'react-icons/fi'
import { isChunkLoadError, recoverFromChunkLoadError, hasUnsavedEditors } from './chunk-recovery'
import { useTranslation } from '@/i18n'
import { Button } from '@/components/Button'

function LazyPanelLoading() {
  const { t } = useTranslation()
  return (
    <div role="status" className="flex h-full min-h-[120px] items-center justify-center gap-2 p-4 text-xs text-text-3">
      <FiRefreshCw aria-hidden="true" className="animate-spin" size={14} />
      {t('common.loading')}
    </div>
  )
}

/** fixed 覆盖层（scrim+dialog 形态）的懒加载 fallback：与最终结构同形，避免文档流占位引发布局重排闪帧 */
export function LazyOverlayLoading({ zClass = 'z-50' }: { zClass?: string }) {
  return (
    <div role="status" className={`fixed inset-0 ${zClass} flex items-center justify-center tmuxgo-scrim`}>
      <FiRefreshCw aria-hidden="true" className="animate-spin text-white/70" size={18} />
    </div>
  )
}

function LazyPanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-4 text-center">
      <FiAlertTriangle aria-hidden="true" className="text-warn" size={18} />
      <div className="text-xs text-text-2">{t('common.loadFailed')}</div>
      {message ? <div className="max-w-full truncate text-caption text-text-3">{message}</div> : null}
      <Button variant="ghost" size="sm" onClick={onRetry}>
        <FiRefreshCw aria-hidden="true" size={12} className="mr-1 inline" />
        {t('common.retry')}
      </Button>
    </div>
  )
}

// 面板级懒加载边界：chunk 失败时只替换该面板区域，不卸载终端、不上抛整页报错
class LazyBoundary extends Component<
  { onRetry: () => void; onError?: (error: Error) => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, _: ErrorInfo) {
    this.props.onError?.(error)
    // 部署后旧 chunk 失效：在线时沿用整页刷新恢复策略（sessionStorage 防循环）；
    // 离线（onLine=false）走面板内重试，有未保存编辑时不自动刷新——编辑状态优先
    if (isChunkLoadError(error.message || '') && navigator.onLine !== false && !hasUnsavedEditors()) {
      recoverFromChunkLoadError(error.message || '', window.sessionStorage, () => window.location.reload())
    }
  }
  render() {
    if (!this.state.error) return this.props.children
    return <LazyPanelError message={this.state.error.message || ''} onRetry={this.props.onRetry} />
  }
}

// lazy 实例按 loader 跨挂载缓存：同一面板再次打开时 lazy 已 fulfilled，同步渲染真实组件，
// 不再 suspend 出 fallback（否则每次打开都会闪一帧 fallback）。import 失败的 lazy 永远 rejected，
// 不能入缓存——由 LazyBoundary.onError 驱逐、以及 attempt>0 的重试路径整体换新
const lazyCache = new Map<() => Promise<{ default: ComponentType<any> }>, LazyExoticComponent<ComponentType<any>>>()

export default function dynamic<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  opts?: { fallback?: ReactNode },
) {
  return function DynamicComponent(props: React.ComponentProps<T>) {
    const [attempt, setAttempt] = useState(0)
    // attempt 是刻意的重建触发器（失败重试须换新 lazy）；loader 为外层闭包常量
    const LazyComponent = useMemo(() => {
      let cached = attempt > 0 ? undefined : lazyCache.get(loader)
      if (!cached) {
        cached = lazy(loader)
        lazyCache.set(loader, cached)
      }
      return cached as LazyExoticComponent<T>
    }, [attempt])
    return (
      <LazyBoundary
        key={attempt}
        onRetry={() => setAttempt((value) => value + 1)}
        onError={() => lazyCache.delete(loader)}
      >
        <Suspense fallback={opts?.fallback ?? <LazyPanelLoading />}>
          <LazyComponent {...props} />
        </Suspense>
      </LazyBoundary>
    )
  }
}
