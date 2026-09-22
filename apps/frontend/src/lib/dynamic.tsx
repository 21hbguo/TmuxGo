'use client'

import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
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
class LazyBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, _: ErrorInfo) {
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

export default function dynamic<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  return function DynamicComponent(props: React.ComponentProps<T>) {
    const [attempt, setAttempt] = useState(0)
    // React.lazy 对同一实例永久缓存结果：import 失败后原 lazy 永远是 rejected。
    // 重试必须 attempt+1 重新 lazy() 才会真正再次发起 import() 请求；
    // key={attempt} 同时让边界组件 remount 清空错误态
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attempt 是刻意的重建触发器，不直接参与计算
    const LazyComponent = useMemo(() => lazy(loader), [loader, attempt])
    return (
      <LazyBoundary key={attempt} onRetry={() => setAttempt((value) => value + 1)}>
        <Suspense fallback={<LazyPanelLoading />}>
          <LazyComponent {...props} />
        </Suspense>
      </LazyBoundary>
    )
  }
}
