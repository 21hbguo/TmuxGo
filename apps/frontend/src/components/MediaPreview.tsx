'use client'

import { useEffect, useState } from 'react'

export interface MediaPreviewProps {
  kind: 'audio' | 'video'
  name: string
  url: string
  size?: number
  labels: { failed: string }
}

export function MediaPreview({ kind, name, url, labels }: MediaPreviewProps) {
  const [failed, setFailed] = useState(false)

  // 换源后要允许重试：不解掉 failed，切到下一个文件会一直显示错误
  useEffect(() => setFailed(false), [url])

  return (
    <div className="flex h-full w-full items-center justify-center rounded-apple bg-black/90 p-3">
      {failed ? (
        <p data-testid="media-error" className="max-w-full truncate text-xs text-text-2">
          {labels.failed}
        </p>
      ) : kind === 'video' ? (
        <video
          data-testid="media-video"
          aria-label={name}
          src={url}
          controls
          preload="metadata"
          className="max-h-full max-w-full rounded-apple bg-black"
          onError={() => setFailed(true)}
        />
      ) : (
        <audio
          data-testid="media-audio"
          aria-label={name}
          src={url}
          controls
          preload="metadata"
          className="w-full"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}
