'use client'
import { useEffect, useMemo, useState } from 'react'
import { FiChevronLeft, FiChevronRight, FiFolder, FiFolderPlus, FiX } from 'react-icons/fi'
import { api } from '@/lib/api'
import { useFileList, useFileRoots } from '@/hooks/useApi'
import { usePrompt } from '@/hooks/usePrompt'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { ModalPortal } from './ModalPortal'
import { Select } from './Select'

export interface WorkspaceDirectoryTarget {
  rootId: string
  rootPath: string
  rootLabel: string
  relativePath: string
  absolutePath: string
}
function toAbsolutePath(rootPath: string, relativePath: string) {
  const root = rootPath.replace(/\/+$/, '') || '/'
  return relativePath ? `${root === '/' ? '' : root}/${relativePath}` : root
}
export function WorkspaceDirectoryPicker({
  hostId,
  onPick,
  onClose,
}: {
  hostId: string
  onPick: (target: WorkspaceDirectoryTarget) => Promise<void> | void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { prompt, PromptElement } = usePrompt()
  const { data: roots = [] } = useFileRoots(hostId)
  const [rootId, setRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const {
    data: currentDirectory,
    isLoading: currentLoading,
    isError: currentError,
    refetch: refetchCurrent,
  } = useFileList(hostId, rootId, currentPath, !!rootId)
  const {
    data: selectedDirectory,
    isLoading: selectedLoading,
    isError: selectedError,
    refetch: refetchSelected,
  } = useFileList(hostId, rootId, selectedPath, !!rootId && !!selectedPath)
  const defaultRoot = roots.find((item) => item.label.toLowerCase() === 'home') || roots[0] || null
  const activeRoot = roots.find((item) => item.id === rootId) || defaultRoot
  const parentPath = currentDirectory?.breadcrumbs?.slice(-2)[0]?.path || ''
  const visibleItems = useMemo(
    () =>
      (currentDirectory?.items || []).filter(
        (item) => item.type === 'directory' && (showHidden || !item.name.startsWith('.')),
      ),
    [currentDirectory, showHidden],
  )
  const selectedItems = useMemo(
    () =>
      (selectedDirectory?.items || []).filter(
        (item) => item.type === 'directory' && (showHidden || !item.name.startsWith('.')),
      ),
    [selectedDirectory, showHidden],
  )
  useEffect(() => {
    if (!rootId && defaultRoot) setRootId(defaultRoot.id)
  }, [rootId, defaultRoot])
  useEffect(() => {
    setCurrentPath('')
    setSelectedPath('')
  }, [rootId])
  const handleOpen = async () => {
    if (!activeRoot || submitting) return
    setSubmitting(true)
    try {
      await onPick({
        rootId: activeRoot.id,
        rootPath: activeRoot.path,
        rootLabel: activeRoot.label,
        relativePath: selectedPath || currentPath,
        absolutePath: toAbsolutePath(activeRoot.path, selectedPath || currentPath),
      })
    } finally {
      setSubmitting(false)
    }
  }
  const handleCreateDirectory = async () => {
    if (!rootId || submitting) return
    const name = await prompt(t('file.newFolder'), '')
    if (!name?.trim()) return
    setSubmitting(true)
    try {
      const created = await api.files.createDirectory(hostId, rootId, currentPath, name.trim())
      setSelectedPath(created.item.path)
      void refetchCurrent()
    } finally {
      setSubmitting(false)
    }
  }
  const handleEnter = (path: string) => {
    setCurrentPath(path)
    setSelectedPath('')
  }
  const handleSelectChild = (path: string) => {
    setCurrentPath(selectedPath)
    setSelectedPath(path)
  }
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[80] flex items-center justify-center tmuxgo-scrim p-4" onClick={onClose}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog flex h-[min(500px,calc(100vh-2rem))] w-full max-w-[680px] flex-col overflow-hidden rounded-apple border"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-3">
            <FiFolder aria-hidden="true" className="shrink-0 text-accent" size={16} />
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">
              {t('workspace.directoryTitle')}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={t('common.cancel')} onClick={onClose}>
              <FiX aria-hidden="true" size={16} />
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-2">
            <Select
              value={activeRoot?.id || ''}
              onChange={setRootId}
              options={roots.map((root) => ({ value: root.id, label: root.label }))}
              className="w-36 shrink-0 rounded-apple px-2 py-1.5 text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('common.back')}
              title={t('common.back')}
              onClick={() => {
                setCurrentPath(parentPath)
                setSelectedPath('')
              }}
              disabled={!currentPath}
            >
              <FiChevronLeft aria-hidden="true" size={16} />
            </Button>
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto text-xs text-text-3">
              {(currentDirectory?.breadcrumbs || [{ name: activeRoot?.path || '/', path: '' }]).map((item, index) => (
                <button
                  key={item.path || 'root'}
                  onClick={() => {
                    setCurrentPath(item.path)
                    setSelectedPath('')
                  }}
                  className="flex shrink-0 items-center hover:text-text-1"
                >
                  <span className="max-w-32 truncate">{item.name}</span>
                  {index < (currentDirectory?.breadcrumbs?.length || 1) - 1 && (
                    <FiChevronRight aria-hidden="true" className="mx-1 shrink-0" size={13} />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-[var(--line)]">
            <div className="tmuxgo-scrollbar min-h-0 overflow-y-auto py-1">
              {currentLoading && <div className="px-3 py-2 text-xs text-text-3">{t('file.loading')}</div>}
              {currentError && (
                <button
                  onClick={() => void refetchCurrent()}
                  className="w-full px-3 py-2 text-left text-xs text-danger"
                >
                  {t('common.retry')}
                </button>
              )}
              {!currentLoading &&
                !currentError &&
                visibleItems.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => setSelectedPath(item.path)}
                    onDoubleClick={() => handleEnter(item.path)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${selectedPath === item.path ? 'bg-accent/15 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'}`}
                  >
                    <FiFolder aria-hidden="true" className="shrink-0 text-[#dcb67a]" size={14} />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <FiChevronRight aria-hidden="true" className="shrink-0 text-text-3" size={13} />
                  </button>
                ))}
            </div>
            <div className="tmuxgo-scrollbar min-h-0 overflow-y-auto py-1">
              {!selectedPath && <div className="px-3 py-2 text-xs text-text-3">{t('workspace.selectDirectory')}</div>}
              {selectedPath && selectedLoading && (
                <div className="px-3 py-2 text-xs text-text-3">{t('file.loading')}</div>
              )}
              {selectedPath && selectedError && (
                <button
                  onClick={() => void refetchSelected()}
                  className="w-full px-3 py-2 text-left text-xs text-danger"
                >
                  {t('common.retry')}
                </button>
              )}
              {selectedPath &&
                !selectedLoading &&
                !selectedError &&
                selectedItems.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => handleSelectChild(item.path)}
                    onDoubleClick={() => handleEnter(item.path)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${selectedPath === item.path ? 'bg-accent/15 text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'}`}
                  >
                    <FiFolder aria-hidden="true" className="shrink-0 text-[#dcb67a]" size={14} />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <FiChevronRight aria-hidden="true" className="shrink-0 text-text-3" size={13} />
                  </button>
                ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line)] px-4 py-3">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCreateDirectory()}
                disabled={!rootId || submitting}
              >
                <FiFolderPlus aria-hidden="true" size={15} />
                {t('file.newFolder')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowHidden((value) => !value)}>
                {showHidden ? t('workspace.hideHidden') : t('workspace.showHidden')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleOpen()}
                disabled={!activeRoot || submitting}
              >
                {t('workspace.openDirectory')}
              </Button>
            </div>
          </div>
        </div>
      </div>
      {PromptElement}
    </ModalPortal>
  )
}
