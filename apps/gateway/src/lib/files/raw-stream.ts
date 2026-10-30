import { Readable } from 'stream'

/**
 * 按字节上限截断可读流。
 *
 * 远端下载流从 offset 开始续传，但不知道文件剩余长度：206 必须只写出 Content-Range
 * 声明的字节数，否则客户端会收到比 Content-Length 更多的数据（断连/解码错位）。
 * 到达上限时主动 destroy 上游，避免继续从 SSH/agent 通道白拉整份文件。
 */
export function limitBytes(source: Readable, limit: number): Readable {
  return Readable.from(
    (async function* () {
      let remaining = limit
      try {
        if (remaining <= 0) return
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          if (buf.length <= remaining) {
            remaining -= buf.length
            yield buf
            if (remaining === 0) return
            continue
          }
          yield buf.subarray(0, remaining)
          return
        }
      } finally {
        source.destroy()
      }
    })(),
  )
}
