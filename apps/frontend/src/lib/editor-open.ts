'use client'
import { api } from './api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { FileDocumentHandle } from '@/types'
import type { useTranslation } from '@/i18n'

const IMAGE_EXTENSIONS = new Set(['.avif','.bmp','.gif','.ico','.jpeg','.jpg','.png','.tif','.tiff','.webp'])
export const OPEN_EDITOR_LOCATION_EVENT = 'tmuxgo-open-editor-location'
type TranslateFn = ReturnType<typeof useTranslation>['t']
export function isImagePath(path: string) {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(lower.slice(dot))
}
export function getEditorLanguage(path: string) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'plaintext'
  if (name.endsWith('.c')) return 'c'
  if (name.endsWith('.cc') || name.endsWith('.cpp') || name.endsWith('.cxx') || name.endsWith('.hpp') || name.endsWith('.h')) return 'cpp'
  if (name.endsWith('.ts')) return 'typescript'
  if (name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js')) return 'javascript'
  if (name.endsWith('.jsx')) return 'javascript'
  if (name.endsWith('.mjs') || name.endsWith('.cjs')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.jsonc')) return 'json'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.scss')) return 'scss'
  if (name.endsWith('.less')) return 'less'
  if (name.endsWith('.html')) return 'html'
  if (name.endsWith('.xml') || name.endsWith('.svg')) return 'xml'
  if (name.endsWith('.sh')) return 'shell'
  if (name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.go')) return 'go'
  if (name.endsWith('.java')) return 'java'
  if (name.endsWith('.kt')) return 'kotlin'
  if (name.endsWith('.rs')) return 'rust'
  if (name.endsWith('.php')) return 'php'
  if (name.endsWith('.rb')) return 'ruby'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.toml')) return 'ini'
  if (name.endsWith('.ini') || name.endsWith('.cfg') || name.endsWith('.conf')) return 'ini'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  return 'plaintext'
}
export function dispatchOpenEditorLocation(editorId: string, line?: number | null, column?: number | null) {
  if (typeof window === 'undefined' || !editorId || !line || line < 1) return
  window.dispatchEvent(new CustomEvent(OPEN_EDITOR_LOCATION_EVENT, { detail: { editorId, line, column: column && column > 0 ? column : 1 } }))
}
export async function openFileInEditor(file: FileDocumentHandle, options: { t: TranslateFn; pushToast?: (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void; position?: { line?: number | null; column?: number | null } | null; openPanel?: boolean }) {
  const { t, pushToast, position, openPanel=true } = options
  const store = useConsoleStore.getState()
  if (openPanel) store.setFilePanelOpen(true)
  const existing = store.openEditors.find((item) => item.id === file.id)
  store.openEditor({ ...file, language: existing?.language || getEditorLanguage(file.path) })
  dispatchOpenEditorLocation(file.id, position?.line, position?.column)
  if (existing?.dirty) return file.id
  store.setEditorLoaded(file.id, {
    loading: true,
    saving: false,
    dirty: false,
    binary: false,
    truncated: false,
    problem: undefined,
    previewUrl: undefined,
  })
  if (isImagePath(file.path)) {
    try {
      const result = await api.files.preview(file.hostId, file.rootId, file.path)
      store.setEditorLoaded(file.id, {
        loading: false,
        content: '',
        savedContent: '',
        modifiedAt: result.modifiedAt,
        size: result.size,
        binary: true,
        truncated: false,
        problem: undefined,
        previewUrl: api.files.imageUrl(file.hostId, file.rootId, file.path, result.modifiedAt),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('desktop.openFailed')
      store.setEditorLoaded(file.id, { loading: false, problem: message })
      pushToast?.({ type: 'error', message })
    }
    return file.id
  }
  try {
    const result = await api.files.content(file.hostId, file.rootId, file.path)
    store.setEditorLoaded(file.id, {
      loading: false,
      content: result.content,
      savedContent: result.content,
      modifiedAt: result.modifiedAt,
      size: result.size,
      binary: result.binary,
      truncated: result.truncated,
      problem: result.reason === 'large-file' ? t('desktop.largePreviewMode') : result.reason === 'binary-file' ? t('desktop.binaryNotEditable') : result.reason === 'directory' ? t('desktop.directoryNotEditable') : undefined,
      previewUrl: undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : t('desktop.openFailed')
    store.setEditorLoaded(file.id, { loading: false, problem: message })
    pushToast?.({ type: 'error', message })
  }
  return file.id
}
