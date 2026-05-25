'use client'

interface PasteConfirmDialogProps {
  open: boolean
  text: string
  meta: string[]
  onSend: () => void
  onEscapeSend: () => void
  onCancel: () => void
}

export function PasteConfirmDialog({ open, text, meta, onSend, onEscapeSend, onCancel }: PasteConfirmDialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-2xl rounded-lg border border-[var(--line)] bg-bg-1 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg text-text-1">Confirm paste</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-3">
          {meta.map((item) => (
            <div key={item} className="rounded bg-bg-2 px-2 py-1">{item}</div>
          ))}
        </div>
        <pre className="mt-4 max-h-[40vh] overflow-auto rounded bg-bg-2 p-3 text-xs text-text-2 whitespace-pre-wrap break-all">{text}</pre>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onClick={onCancel} className="rounded px-4 py-2 text-sm text-text-3 hover:text-text-1">Cancel</button>
          <button onClick={onEscapeSend} className="rounded bg-bg-2 px-4 py-2 text-sm text-text-1 hover:bg-bg-0">Escape Paste</button>
          <button onClick={onSend} className="rounded bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30">Send</button>
        </div>
      </div>
    </div>
  )
}
