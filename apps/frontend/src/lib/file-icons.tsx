import type { ReactNode } from 'react'
import type { IconType } from 'react-icons'
import {
  SiCss,
  SiDocker,
  SiGit,
  SiGnubash,
  SiGo,
  SiHtml5,
  SiJavascript,
  SiJson,
  SiLess,
  SiMarkdown,
  SiMysql,
  SiNpm,
  SiOpenjdk,
  SiPnpm,
  SiPython,
  SiRust,
  SiSass,
  SiSvelte,
  SiToml,
  SiTypescript,
  SiVitest,
  SiVuedotjs,
  SiYaml,
} from 'react-icons/si'
import {
  VscFile,
  VscFileMedia,
  VscFilePdf,
  VscFileZip,
  VscFolder,
  VscFolderOpened,
  VscGear,
  VscLaw,
} from 'react-icons/vsc'

// VSCode material-icon-theme 风格配色；resolveFileIcon 供单测直接断言映射
export interface FileIconSpec {
  icon: IconType
  color?: string
}

// 文件名精确/模式匹配优先于扩展名（VSCode 语义）
const FILE_NAME_ICONS: Array<[RegExp, IconType, string?]> = [
  [/^package(-lock)?\.json$/, SiNpm, '#CB3837'],
  [/^npm-shrinkwrap\.json$/, SiNpm, '#CB3837'],
  [/^yarn\.lock$/, SiYaml, '#2C8EBB'],
  [/^pnpm-lock\.yaml$/, SiPnpm, '#F69220'],
  [/^tsconfig.*\.json$/, SiTypescript, '#3178C6'],
  [/^(dockerfile|.*\.dockerfile|docker-compose.*\.(ya?ml))$/, SiDocker, '#2496ED'],
  [/^\.git(ignore|attributes|modules|config)?$/, SiGit, '#F05032'],
  [/^readme(\..*)?$/, SiMarkdown, '#519ABA'],
  [/^(license|licence|copying)(\..*)?$/, VscLaw, '#CBCB41'],
  [/^changelog(\..*)?$/, SiMarkdown, '#519ABA'],
  [/^\.env(\..*)?$/, VscGear, '#FBBC05'],
  [/^(makefile|gnumakefile)$/, VscGear, '#6D8086'],
  [/\.(test|spec)\.[jt]sx?$/, SiVitest, '#99425B'],
]

const EXT_ICONS: Record<string, [IconType, string?]> = {
  '.ts': [SiTypescript, '#3178C6'],
  '.tsx': [SiTypescript, '#3178C6'],
  '.mts': [SiTypescript, '#3178C6'],
  '.cts': [SiTypescript, '#3178C6'],
  '.js': [SiJavascript, '#F7DF1E'],
  '.jsx': [SiJavascript, '#F7DF1E'],
  '.mjs': [SiJavascript, '#F7DF1E'],
  '.cjs': [SiJavascript, '#F7DF1E'],
  '.py': [SiPython, '#3776AB'],
  '.go': [SiGo, '#00ADD8'],
  '.rs': [SiRust, '#DEA584'],
  '.java': [SiOpenjdk, '#ED8B00'],
  '.json': [SiJson, '#5E5C5C'],
  '.yaml': [SiYaml, '#CB171E'],
  '.yml': [SiYaml, '#CB171E'],
  '.toml': [SiToml, '#9C4121'],
  '.md': [SiMarkdown, '#519ABA'],
  '.mdx': [SiMarkdown, '#519ABA'],
  '.html': [SiHtml5, '#E34F26'],
  '.htm': [SiHtml5, '#E34F26'],
  '.css': [SiCss, '#1572B6'],
  '.scss': [SiSass, '#CC6699'],
  '.sass': [SiSass, '#CC6699'],
  '.less': [SiLess, '#2B4C80'],
  '.vue': [SiVuedotjs, '#4FC08D'],
  '.svelte': [SiSvelte, '#FF3E00'],
  '.sh': [SiGnubash, '#4EAA25'],
  '.bash': [SiGnubash, '#4EAA25'],
  '.zsh': [SiGnubash, '#4EAA25'],
  '.sql': [SiMysql, '#00758F'],
  '.pdf': [VscFilePdf, '#F44336'],
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif'])
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz', '.jar'])

export function resolveFileIcon(path: string, type: 'file' | 'directory', open = false): FileIconSpec {
  if (type === 'directory') return { icon: open ? VscFolderOpened : VscFolder, color: '#90A4AE' }
  const name = (path.split(/[\\/]/).pop() || path).toLowerCase()
  for (const [pattern, icon, color] of FILE_NAME_ICONS) {
    if (pattern.test(name)) return { icon, color }
  }
  const ext = name.slice(name.lastIndexOf('.'))
  const mapped = EXT_ICONS[ext]
  if (mapped) return { icon: mapped[0], color: mapped[1] }
  if (IMAGE_EXTENSIONS.has(ext)) return { icon: VscFileMedia, color: '#42A5F5' }
  if (ARCHIVE_EXTENSIONS.has(ext)) return { icon: VscFileZip, color: '#E8B33D' }
  return { icon: VscFile }
}

export function getFileIcon(path: string, type: 'file' | 'directory', opts?: { open?: boolean }): ReactNode {
  const name = path.split(/[\\/]/).pop() || path
  const { icon: Icon, color } = resolveFileIcon(path, type, opts?.open)
  // 隐藏文件（.开头）降透明度是 VSCode Explorer 惯例；固定 14px 盒防行高跳动
  const hidden = name.startsWith('.')
  return (
    <span className={`inline-flex h-[14px] w-[14px] items-center justify-center ${hidden ? 'opacity-60' : ''}`}>
      <Icon size={14} color={color} />
    </span>
  )
}
