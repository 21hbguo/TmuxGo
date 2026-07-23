'use client'
import { useEffect, useMemo, useState } from 'react'
import { useFileList, useFileRoots, useFileSearch } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'
import { quoteShellPath } from '@/lib/path-drop'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FileItem } from '@/types'

function joinPath(base: string, name: string) {
  if (!name) return base
  if (!base || base === '/') return `/${name.replace(/^\/+/, '')}`
  return `${base.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
}
function getParentPath(path: string) {
  return path.split(/[\\/]+/).filter(Boolean).slice(0, -1).join('/')
}
function getPathName(path: string, fallback: string) {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) || fallback
}

export function MobilePathPicker({ onClose }: { onClose: () => void }) {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { t } = useTranslation()
  const fileHostId = activeHostId || 'local'
  const { data: roots = [] } = useFileRoots(fileHostId)
  const [rootId, setRootId] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [query, setQuery] = useState('')
  const root = roots.find((item) => item.id === rootId) || roots[0]
  const { data: listData, isLoading: listLoading } = useFileList(fileHostId, root?.id || '', currentPath)
  const { data: searchResults = [], isFetching: searchLoading } = useFileSearch(fileHostId, root?.id || '', 'name', query, currentPath)
  const items = useMemo(() => query.trim() ? searchResults : listData?.items || [], [listData, query, searchResults])

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id)
  }, [rootId, roots])
  useEffect(() => {
    setCurrentPath('')
    setQuery('')
  }, [rootId])

  const insertPath = (path: string, name: string) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: quoteShellPath(path) } }))
    pushToast({ type: 'success', message: t('file.inserted', { name }) })
    onClose()
  }
  const insertItem = (item: FileItem) => insertPath(joinPath(root?.path || '', item.path), item.name)
  const openDirectory = (item: FileItem) => {
    setCurrentPath(item.path)
    setQuery('')
  }

  return <section data-mobile-path-picker data-keep-mobile-keyboard className="absolute bottom-full left-0 right-0 z-50 flex max-h-[min(52dvh,360px)] flex-col border-t border-[var(--line)] bg-bg-1 shadow-[0_-16px_38px_rgba(0,0,0,0.4)]">
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-2 py-2">
      <button type="button" onClick={onClose} className="rounded-apple px-2 py-1 text-xs text-text-3 active:bg-bg-2">{t('common.close')}</button>
      <div className="min-w-0 flex-1 overflow-x-auto scrollbar-none"><div className="flex w-max gap-1">{roots.map((item) => <button key={item.id} type="button" onClick={() => setRootId(item.id)} className={`rounded-apple px-2 py-1 text-xs ${root?.id === item.id ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2 active:bg-bg-3'}`}>{item.label}</button>)}</div></div>
    </div>
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line)] px-2 py-1.5">
      <button type="button" onClick={() => setCurrentPath(getParentPath(currentPath))} disabled={!currentPath} className="rounded-apple px-2 py-1 text-xs text-text-2 disabled:opacity-30 active:bg-bg-2">{t('common.back')}</button>
      <button type="button" onClick={() => insertPath(joinPath(root?.path || '', currentPath), getPathName(currentPath, root?.label || ''))} disabled={!root} className="min-w-0 flex-1 truncate rounded-apple bg-accent/16 px-2 py-1 text-left font-mono text-xs text-accent active:bg-accent/25" title={joinPath(root?.path || '', currentPath)}>{currentPath || root?.label || ''}</button>
    </div>
    <div className="shrink-0 border-b border-[var(--line)] px-2 py-1.5"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('file.searchName')} className="h-8 w-full rounded-apple border border-[var(--line)] bg-bg-0 px-2 text-xs text-text-1 outline-none placeholder:text-text-3 focus:border-accent/60" /></div>
    <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
      {(listLoading || searchLoading) && <div className="px-3 py-2 text-xs text-text-3">{t('file.loading')}</div>}
      {!listLoading && !searchLoading && items.map((item) => item.type === 'directory' ? <div key={`${item.type}-${item.path}`} className="flex items-center gap-1 px-2 py-0.5"><button type="button" onClick={() => openDirectory(item)} className="min-w-0 flex-1 rounded-apple px-2 py-1.5 text-left active:bg-bg-2"><span className="mr-1.5 text-[#dcb67a]">▸</span><span className="font-mono text-xs text-text-1">{item.name}</span>{query.trim() && <span className="ml-2 text-[10px] text-text-3">{item.path}</span>}</button><button type="button" onClick={() => insertItem(item)} className="shrink-0 rounded-apple bg-bg-2 px-2 py-1.5 text-[11px] text-accent active:bg-accent/20" aria-label={`${t('file.insertPathCtx')} ${item.name}`}>{t('file.insertPathCtx')}</button></div> : <button key={`${item.type}-${item.path}`} type="button" onClick={() => insertItem(item)} className="flex w-full items-center gap-1.5 px-4 py-2 text-left active:bg-bg-2"><span className="font-mono text-xs text-text-1">{item.name}</span>{query.trim() && <span className="min-w-0 truncate font-mono text-[10px] text-text-3">{item.path}</span>}</button>)}
      {!listLoading && !searchLoading && !items.length && <div className="px-3 py-2 text-xs text-text-3">{query.trim() ? t('file.noResults') : t('file.emptyDir')}</div>}
    </div>
  </section>
}
