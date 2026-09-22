import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
export const PREVIEW_LIMIT = 200 * 1024
export const LARGE_FILE_LIMIT = 512 * 1024
export const MAX_DIRS = 50000
export const MAX_FILES = 300000
export const MAX_RESULTS = 200
export const MAX_READ_LINES = 1200
export const DEFAULT_UPLOAD_DIR = 'uploads'
export const DEFAULT_UPLOAD_RATE_LIMIT_KBPS = 5120
export const MAX_UPLOAD_RATE_LIMIT_KBPS = 10 * 1024
export const SEARCH_MATCH_LIMIT = 3
export const RG_MAX_BUFFER = 16 * 1024 * 1024
export const GIT_REPOSITORY_MAX_DEPTH = 6
export const GIT_REPOSITORY_MAX_DIRS = 12000
export const GIT_REPOSITORY_MAX_RESULTS = 200
export const GIT_REPOSITORY_SKIP_DIRS = new Set([
  '.cache',
  '.local',
  '.npm',
  '.next',
  '.next-dev',
  '.next-prod',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'postgres_data',
  'venv',
])
export const FILE_SEARCH_SKIP_DIRS = new Set([
  ...GIT_REPOSITORY_SKIP_DIRS,
  '.git',
  '.hg',
  '.pnpm-store',
  '.svn',
  'Library',
  'coverage',
  'target',
  'vendor',
])
export const TEMP_UPLOAD_ROOT_ID = 'app-tmp'
export const TEMP_UPLOAD_ROOT_LABEL = 'tmp'
export const DEFAULT_TEMP_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TEMP_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
export const DEFAULT_DOWNLOAD_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_DOWNLOAD_ARTIFACT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
export const DEFAULT_DOWNLOAD_ARTIFACT_MAX_COUNT = 100
export const DEFAULT_DOWNLOAD_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024
export const homeRoot = os.homedir()
export const rootSpec = process.env.TMUX_WEB_FILE_ROOTS || `workspace=${defaultRoot}${path.delimiter}home=${homeRoot}`
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
}
export interface FileRoot {
  id: string
  label: string
  path: string
}
export interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
  mode?: number
}
export interface SearchMatchLine {
  number: number
  content: string
}
export interface ContentSearchResult extends FileItem {
  matches: SearchMatchLine[]
}
export interface TrashEntry {
  id: string
  rootId: string
  path: string
  name: string
  type: 'file' | 'directory'
  deletedAt: string
}
export interface StagedUploadFile {
  name: string
  stagedPath: string
  size: number
  destination?: { name: string; path: string; absolutePath: string }
  uploaded?: { name: string; path: string; absolutePath: string; size: number }
}
export interface BackgroundUploadInput {
  hostId: string
  targetRootId: string
  targetPath: string
  conflictPolicy: string
  rateLimitKBps: number
  files: StagedUploadFile[]
}
export interface BackgroundDownloadInput {
  hostId: string
  rootId: string
  path: string
  rateLimitKBps: number
  artifactId: string
  downloadedBytes?: number
  sourceSize?: number
  sourceModifiedAt?: string
}
export interface GitRepositoryInfo {
  path: string
  label: string
}
export function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}
