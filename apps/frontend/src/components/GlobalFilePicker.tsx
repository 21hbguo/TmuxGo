'use client'
import { useEffect, useRef } from 'react'
import { stageRejectionMessage, stageUploadFiles } from '@/lib/file-meta'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

export interface PickUploadFilesDetail {
  hostId?: string
  rootId?: string
  path?: string
  // stage=true：选中的文件进入全局暂存列表（上传页分批挑选/中途离开不丢），
  // 而非直接打开确认弹窗
  stage?: boolean
}

// 全局常驻 file input，挂 ConsoleLayout 根部、永不卸载。
// 各入口（FilePanel/上传页/命令面板）只派发 tmuxgo-pick-upload-files 事件：
// 1. dispatchEvent 同步执行在用户手势调用栈内，iOS/Android 不会拦程序化 click()；
// 2. 移动端 bottom sheet 在原生文件选择器打开期间可能被返回手势或系统事件关闭——
//    input 若随 FilePanel 卸载，change 回调永久丢失；全局挂载保证选择结果必达 openUploadDialog；
// 3. sr-only 而非 display:none：部分移动 WebView 对 display:none 的 input 不响应 click()。
export function GlobalFilePicker() {
  const inputRef = useRef<HTMLInputElement>(null)
  const contextRef = useRef<PickUploadFilesDetail | null>(null)
  const { t } = useTranslation()
  useEffect(() => {
    const handler = (event: Event) => {
      contextRef.current = (event as CustomEvent<PickUploadFilesDetail>).detail || null
      inputRef.current?.click()
    }
    window.addEventListener('tmuxgo-pick-upload-files', handler)
    return () => window.removeEventListener('tmuxgo-pick-upload-files', handler)
  }, [])
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      className="sr-only"
      onChange={(event) => {
        const files = Array.from(event.target.files || [])
        // 清空 value：同一文件取消后可再次选择并重触发 change
        event.target.value = ''
        if (!files.length) return
        const ctx = contextRef.current
        const store = useConsoleStore.getState()
        if (ctx?.stage) {
          const staged = stageUploadFiles(store.stagedUploadFiles, files)
          if (staged.files.length !== store.stagedUploadFiles.length) store.setStagedUploadFiles(staged.files)
          // 拒收立即告知：不入暂存列表，避免误以为这些文件会随批上传
          if (staged.rejected.length)
            store.pushToast({ type: 'error', message: stageRejectionMessage(staged.rejected, t) })
          return
        }
        store.openUploadDialog({
          files,
          hostId: ctx?.hostId,
          preferredRootId: ctx?.rootId,
          preferredPath: ctx?.path,
        })
      }}
    />
  )
}
