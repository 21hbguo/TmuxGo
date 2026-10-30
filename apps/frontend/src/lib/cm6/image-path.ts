// 图片地址 → root 相对路径。纯函数，单独成文件：路径规则不该埋在装饰层里，也方便直接单测。
//
// 规则（与整合方的约定）：
// - 外部地址（http/https/data/blob/协议相对 `//`）返回 null：交给调用方或浏览器，不做仓库内解析；
// - 以 `/` 开头的按 root 绝对路径处理（Markdown 里常见），归一化后去掉前导斜杠；
// - 传了 documentPath（当前文档的 root 相对路径）时按 dirname 拼接并做 posix 归一化；
// - 没传 documentPath，或归一化越出 root（`../` 弹穿），退回「去掉 ./ 前缀」的原样相对路径；
// - 空串返回 null。

const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

// posix 归一化拼接：逐段处理 . 和 ..，`..` 在根上再弹一次即判定越界
function joinFromRoot(base: string, path: string): string | null {
  const parts: string[] = []
  for (const segment of `${base}/${path}`.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

// documentPath 的目录部分（posix）；文档本身越界或为空时返回 null，交给回退分支
function documentDirectory(documentPath: string): string | null {
  const clean = documentPath.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean) return null
  const index = clean.lastIndexOf('/')
  if (index < 0) return ''
  return joinFromRoot('', clean.slice(0, index))
}

export function resolveImagePath(src: string, documentPath?: string): string | null {
  const trimmed = src.trim()
  if (!trimmed) return null
  if (EXTERNAL_URL.test(trimmed)) return null
  const fallback = trimmed.replace(/^\.\//, '')
  // root 绝对路径与文档目录无关，直接按根归一化
  if (trimmed.startsWith('/')) return joinFromRoot('', trimmed) ?? fallback
  if (!documentPath) return fallback
  const base = documentDirectory(documentPath)
  if (base === null) return fallback
  return joinFromRoot(base, trimmed) ?? fallback
}
