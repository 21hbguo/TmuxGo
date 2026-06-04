import type { FastifyInstance } from 'fastify'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, opendir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { assertTargetAllowed } from '../lib/tmux-policy.js'
import { getHostById, type HostRecord } from '../lib/hosts.js'
import { readFile as readPreferencesFile } from 'fs/promises'

const execFileAsync = promisify(execFile)
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PREVIEW_LIMIT = 200 * 1024
const LARGE_FILE_LIMIT = 512 * 1024
const MAX_DIRS = 50000
const MAX_FILES = 50000
const MAX_RESULTS = 200
const MAX_READ_LINES = 1200
const DEFAULT_UPLOAD_DIR = 'uploads'
const DEFAULT_UPLOAD_RATE_LIMIT_KBPS = 200
const MAX_UPLOAD_RATE_LIMIT_KBPS = 10 * 1024
const SEARCH_MATCH_LIMIT = 3
const RG_MAX_BUFFER = 16 * 1024 * 1024
const homeRoot = os.homedir()
const rootSpec = process.env.TMUX_WEB_FILE_ROOTS || `workspace=${defaultRoot}${path.delimiter}home=${homeRoot}`
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
}

interface FileRoot {
  id: string
  label: string
  path: string
}
interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
}
interface SearchMatchLine {
  number: number
  content: string
}
interface ContentSearchResult extends FileItem {
  matches: SearchMatchLine[]
}

let rootsCache: Promise<FileRoot[]> | null = null
const knownAuthMarkers = ['Permission denied']
const knownHostKeyMarkers = ['Host key verification failed', 'REMOTE HOST IDENTIFICATION HAS CHANGED']
const knownTimeoutMarkers = ['Connection timed out', 'Operation timed out', 'No route to host']
const knownNetworkMarkers = ['Could not resolve hostname', 'Connection refused', 'Network is unreachable']
function isDotPath(relativePath: string) {
  return relativePath.split(/[\\/]+/).some((part) => part.startsWith('.') && part.length > 1)
}

async function getRoots() {
  if (!rootsCache) {
    rootsCache = Promise.all(rootSpec.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map(async (entry, index) => {
      const [labelRaw, pathRaw] = entry.includes('=') ? entry.split(/=(.*)/s).filter(Boolean) : ['', entry]
      const resolved = await realpath(path.resolve(pathRaw))
      return { id: `root-${index}`, label: labelRaw || path.basename(resolved) || resolved, path: resolved }
    }))
  }
  return rootsCache
}
function escapeShellSingleQuoted(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`
}
function normalizeRemoteErrorMessage(raw: string, fallback: string) {
  const value = raw.trim() || fallback
  if (knownHostKeyMarkers.some((m) => value.includes(m))) return 'Host key verification failed'
  if (knownTimeoutMarkers.some((m) => value.includes(m))) return 'SSH connection timed out'
  if (knownNetworkMarkers.some((m) => value.includes(m))) return 'SSH network is unreachable'
  if (knownAuthMarkers.some((m) => value.includes(m))) return 'SSH authentication failed'
  return value
}
function resolveHostPassword(host: HostRecord) {
  if (host.password) return host.password
  const envName = host.passwordEnv.trim()
  if (!envName) return ''
  return process.env[envName] || ''
}
async function hasSshPass() {
  try {
    await execFileAsync('sshpass', ['-V'])
    return true
  } catch {
    return false
  }
}
async function getResolvedHost(hostIdRaw: string) {
  const hostId = hostIdRaw.trim()
  if (!hostId) throw new Error('Missing host id')
  const host = await getHostById(hostId)
  if (!host) throw new Error(`Host "${hostId}" not found`)
  return host
}
async function runRemoteCommand(host: HostRecord, remoteCommand: string, binary = false) {
  const sshArgs = ['-p', String(host.port), '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-T', `${host.user}@${host.address}`, '--', remoteCommand]
  const password = resolveHostPassword(host)
  try {
    if (password) {
      if (!await hasSshPass()) throw new Error('SSH password configured but sshpass is not installed')
      return await execFileAsync('sshpass', ['-e', 'ssh', ...sshArgs], { env: { ...process.env, SSHPASS: password }, maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' } as any)
    }
    return await execFileAsync('ssh', sshArgs, { maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' } as any)
  } catch (err: any) {
    throw new Error(normalizeRemoteErrorMessage(`${err?.stderr || ''}\n${err?.stdout || ''}`, err?.message || 'SSH file command failed'))
  }
}
async function runRemotePython<T>(hostId: string, script: string, args: string[]): Promise<T> {
  const host = await getResolvedHost(hostId)
  const remoteCommand = `python3 -c ${escapeShellSingleQuoted(script)} -- ${args.map((arg) => escapeShellSingleQuoted(arg)).join(' ')}`
  const { stdout } = await runRemoteCommand(host, remoteCommand)
  return JSON.parse(String(stdout)) as T
}
async function readRemoteBinary(hostId: string, absolutePath: string) {
  const host = await getResolvedHost(hostId)
  const remoteCommand = `python3 -c ${escapeShellSingleQuoted(`import pathlib,sys;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())`)} -- ${escapeShellSingleQuoted(absolutePath)}`
  const { stdout } = await runRemoteCommand(host, remoteCommand, true)
  return Buffer.from(stdout as Uint8Array)
}
const REMOTE_FILE_SCRIPT = `import base64,datetime,json,os,pathlib,shutil,sys
PREVIEW_LIMIT=200*1024
LARGE_FILE_LIMIT=512*1024
MAX_RESULTS=200
MAX_READ_LINES=1200
SEARCH_MATCH_LIMIT=3
DEFAULT_UPLOAD_DIR='uploads'
payload=json.loads(base64.b64decode(sys.argv[1]).decode())
def iso(ts):
 return datetime.datetime.fromtimestamp(ts,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def root_spec():
 return os.environ.get('TMUX_WEB_FILE_ROOTS') or f"workspace={os.getcwd()}{os.pathsep}home={os.path.expanduser('~')}"
def roots():
 out=[]
 for i,entry in enumerate([e.strip() for e in root_spec().split(os.pathsep) if e.strip()]):
  if '=' in entry: label,p=entry.split('=',1)
  else: label,p='',entry
  resolved=str(pathlib.Path(p).expanduser().resolve())
  out.append({'id':f'root-{i}','label':label or pathlib.Path(resolved).name or resolved,'path':resolved})
 return out
def norm_rel(value=''):
 return '/'.join([part for part in str(value).replace('\\\\','/').split('/') if part and part!='.'])
def get_root(root_id):
 for item in roots():
  if item['id']==root_id: return item
 raise Exception('Invalid root')
def resolve_inside(root_id, rel=''):
 root=get_root(root_id)
 base=pathlib.Path(root['path']).resolve()
 target=(base / norm_rel(rel)).resolve()
 if str(target)!=str(base) and str(target)[:len(str(base))+1]!=str(base)+os.sep: raise Exception('Path escapes root')
 return root,str(target),norm_rel(os.path.relpath(str(target),str(base)))
def is_binary(data):
 return b'\\0' in data[:min(len(data),4096)]
def file_item(root_path, abs_path, name):
 st=os.stat(abs_path)
 return {'name':name,'path':norm_rel(os.path.relpath(abs_path,root_path)),'type':'directory' if pathlib.Path(abs_path).is_dir() else 'file','size':st.st_size,'modifiedAt':iso(st.st_mtime)}
def breadcrumbs(rel):
 parts=[p for p in rel.split('/') if p]
 out=[{'name':'/','path':''}]
 for i,name in enumerate(parts): out.append({'name':name,'path':'/'.join(parts[:i+1])})
 return out
include_dotfiles=payload.get('includeDotFiles',True)
if isinstance(include_dotfiles,str): include_dotfiles=include_dotfiles.lower()!='false'
op=payload['op']
if op=='roots':
 print(json.dumps(roots()));sys.exit(0)
if op=='default-upload-target':
 items=roots();root=next((item for item in items if item['label'].lower()=='workspace'),items[0] if items else None)
 if not root: raise Exception('No file roots configured')
 abs_path=str((pathlib.Path(root['path'])/DEFAULT_UPLOAD_DIR).resolve())
 print(json.dumps({'rootId':root['id'],'rootLabel':root['label'],'rootPath':root['path'],'path':DEFAULT_UPLOAD_DIR,'absolutePath':abs_path,'source':'fallback'}));sys.exit(0)
root,abs_path,rel=resolve_inside(payload.get('root',''),payload.get('path',''))
st=os.stat(abs_path)
if op=='list':
 items=[]
 for entry in os.scandir(abs_path):
  if entry.name in ('.','..'): continue
  try: items.append(file_item(root['path'],entry.path,entry.name))
  except: pass
 items.sort(key=lambda item:(0 if item['type']=='directory' else 1,item['name'].lower()))
 print(json.dumps({'root':root,'path':rel,'breadcrumbs':breadcrumbs(rel),'items':items}));sys.exit(0)
if op=='preview':
 if pathlib.Path(abs_path).is_dir():
  print(json.dumps({'path':rel,'type':'directory','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':False,'truncated':False,'lines':[]}));sys.exit(0)
 if st.st_size>LARGE_FILE_LIMIT:
  print(json.dumps({'path':rel,'type':'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':False,'truncated':True,'reason':'large-file','lines':[]}));sys.exit(0)
 data=pathlib.Path(abs_path).read_bytes()
 if is_binary(data):
  print(json.dumps({'path':rel,'type':'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':True,'truncated':False,'reason':'binary-file','lines':[]}));sys.exit(0)
 start=max(1,int(payload.get('line',1) or 1))
 text=data[:PREVIEW_LIMIT].decode('utf-8',errors='replace')
 all_lines=text.splitlines()
 sliced=all_lines[start-1:start-1+MAX_READ_LINES]
 lines=[{'number':start+i,'content':content} for i,content in enumerate(sliced)]
 print(json.dumps({'path':rel,'type':'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':False,'truncated':len(data)>PREVIEW_LIMIT or len(all_lines)>len(lines),'lines':lines}));sys.exit(0)
if op=='content':
 if pathlib.Path(abs_path).is_dir():
  print(json.dumps({'path':rel,'type':'directory','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':False,'truncated':False,'reason':'directory','encoding':'utf8','content':''}));sys.exit(0)
 if st.st_size>LARGE_FILE_LIMIT:
  print(json.dumps({'path':rel,'type':'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':False,'truncated':True,'reason':'large-file','encoding':'utf8','content':''}));sys.exit(0)
 data=pathlib.Path(abs_path).read_bytes()
 if is_binary(data):
  print(json.dumps({'path':rel,'type':'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':True,'truncated':False,'reason':'binary-file','encoding':'utf8','content':''}));sys.exit(0)
 print(json.dumps({'path':rel,'type':'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'binary':False,'truncated':False,'encoding':'utf8','content':data.decode('utf-8')}));sys.exit(0)
if op=='save':
 if pathlib.Path(abs_path).is_dir(): raise Exception('Directories cannot be saved')
 if st.st_size>LARGE_FILE_LIMIT: raise Exception('Large files are read only')
 current=pathlib.Path(abs_path).read_bytes()
 if is_binary(current): raise Exception('Binary files are read only')
 current_m=iso(st.st_mtime)
 if payload.get('modifiedAt') and payload['modifiedAt']!=current_m: raise Exception('FILE_MODIFIED:File changed on disk')
 pathlib.Path(abs_path).write_text(payload.get('content',''),encoding='utf-8')
 next_st=os.stat(abs_path)
 print(json.dumps({'ok':True,'content':payload.get('content',''),'modifiedAt':iso(next_st.st_mtime),'size':next_st.st_size}));sys.exit(0)
if op=='create-file':
 name=payload.get('name','').strip()
 if not name or '/' in name or '\\\\' in name or name in ('.','..'): raise Exception('Invalid name')
 if not pathlib.Path(abs_path).is_dir(): raise Exception('Target directory not found')
 target=pathlib.Path(abs_path)/name
 if target.exists(): raise Exception('File already exists')
 target.write_text('',encoding='utf-8')
 print(json.dumps({'ok':True,'item':file_item(root['path'],str(target),name),'parentPath':rel}));sys.exit(0)
if op=='create-directory':
 name=payload.get('name','').strip()
 if not name or '/' in name or '\\\\' in name or name in ('.','..'): raise Exception('Invalid name')
 if not pathlib.Path(abs_path).is_dir(): raise Exception('Target directory not found')
 target=pathlib.Path(abs_path)/name
 if target.exists(): raise Exception('Directory already exists')
 target.mkdir()
 print(json.dumps({'ok':True,'item':file_item(root['path'],str(target),name),'parentPath':rel}));sys.exit(0)
if op=='rename':
 name=payload.get('name','').strip()
 if not name or '/' in name or '\\\\' in name or name in ('.','..'): raise Exception('Invalid name')
 if str(pathlib.Path(abs_path).resolve())==str(pathlib.Path(root['path']).resolve()): raise Exception('Root cannot be renamed')
 target=str(pathlib.Path(abs_path).with_name(name))
 if target!=abs_path and pathlib.Path(target).exists(): raise Exception('Target already exists')
 if target!=abs_path: pathlib.Path(abs_path).rename(target)
 print(json.dumps({'ok':True,'item':file_item(root['path'],target,name),'previousPath':rel}));sys.exit(0)
if op=='remove':
 if str(pathlib.Path(abs_path).resolve())==str(pathlib.Path(root['path']).resolve()): raise Exception('Root cannot be removed')
 typ='directory' if pathlib.Path(abs_path).is_dir() else 'file'
 shutil.rmtree(abs_path) if typ=='directory' else pathlib.Path(abs_path).unlink()
 print(json.dumps({'ok':True,'path':rel,'type':typ}));sys.exit(0)
if op=='resolve-file':
 print(json.dumps({'root':root,'absolutePath':abs_path,'relativePath':rel,'size':st.st_size,'isFile':pathlib.Path(abs_path).is_file()}));sys.exit(0)
query=str(payload.get('query','')).lower().strip()
clauses=[[token.strip().lower() for token in part.split() if token.strip()] for part in query.split('|') if part.strip()]
def match_name(name):
 low=name.lower()
 return any(all(term in low for term in clause) for clause in clauses)
def match_content(text):
 low=text.lower()
 return any(all(term in low for term in clause) for clause in clauses)
def match_line(text):
 low=text.lower()
 return any(any(term in low for term in clause) for clause in clauses)
results=[]
for current_root,dirs,files in os.walk(abs_path):
 if not include_dotfiles:
  dirs[:]=[name for name in dirs if not any(part.startswith('.') and len(part)>1 for part in name.replace('\\\\','/').split('/'))]
 for name in list(dirs)+list(files):
  current=os.path.join(current_root,name)
  is_dir=os.path.isdir(current)
  relative=norm_rel(os.path.relpath(current,root['path']))
  if not include_dotfiles and any(part.startswith('.') and len(part)>1 for part in relative.split('/')): continue
  if op=='search-name':
   if not match_name(name): continue
   try: results.append(file_item(root['path'],current,name))
   except: pass
  else:
   if is_dir: continue
   try:
    info=os.stat(current)
    if info.st_size>LARGE_FILE_LIMIT: continue
    data=pathlib.Path(current).read_bytes()
    if is_binary(data): continue
    text=data.decode('utf-8',errors='replace')
    if not match_content(text): continue
    matches=[]
    for i,line in enumerate(text.splitlines()):
     if len(matches)>=SEARCH_MATCH_LIMIT: break
     if match_line(line): matches.append({'number':i+1,'content':line[:240]})
    if matches: results.append({'name':name,'path':relative,'type':'file','size':info.st_size,'modifiedAt':iso(info.st_mtime),'matches':matches})
   except: pass
  if len(results)>=MAX_RESULTS: break
 if len(results)>=MAX_RESULTS: break
print(json.dumps(results[:MAX_RESULTS]))`
function encodeRemotePayload(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}
async function runRemoteFileJson<T>(hostId: string, payload: Record<string, unknown>) {
  return runRemotePython<T>(hostId, REMOTE_FILE_SCRIPT, [encodeRemotePayload(payload)])
}
function normalizeRelativePath(relativePath = '') {
  return relativePath.split(/[\\/]+/).filter(Boolean).join('/')
}
function sanitizePathSegment(name: string) {
  const normalized = (name || '').replace(/\0/g, '').trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/.test(normalized)) throw new Error('Invalid name')
  return normalized
}
function getRootPrefix(rootPath: string) {
  return rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
}
async function resolveInside(rootId: string, relativePath = '') {
  const roots = await getRoots()
  const root = roots.find((item) => item.id === rootId)
  if (!root) throw new Error('Invalid root')
  const normalizedPath = normalizeRelativePath(relativePath)
  const requested = path.resolve(root.path, normalizedPath || '.')
  const normalizedRoot = getRootPrefix(root.path)
  if (requested !== root.path && !requested.startsWith(normalizedRoot)) throw new Error('Path escapes root')
  let actual = requested
  try {
    actual = await realpath(requested)
  } catch {
    actual = requested
  }
  if (actual !== root.path && !actual.startsWith(normalizedRoot)) throw new Error('Path escapes root')
  return { root, absolutePath: actual, relativePath: normalizeRelativePath(path.relative(root.path, actual)) }
}
function toRelative(rootPath: string, absolutePath: string) {
  return normalizeRelativePath(path.relative(rootPath, absolutePath))
}
function getBreadcrumbs(relativePath: string) {
  const parts = relativePath ? relativePath.split(/[\\/]+/).filter(Boolean) : []
  return [{ name: '/', path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))]
}
function isLikelyBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  return sample.includes(0)
}
async function toFileItem(rootPath: string, absolutePath: string, name: string): Promise<FileItem> {
  const info = await stat(absolutePath)
  return {
    name,
    path: toRelative(rootPath, absolutePath),
    type: info.isDirectory() ? 'directory' : 'file',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  }
}
async function listDirectory(rootId: string, relativePath: string) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const directory = await opendir(absolutePath)
  const items: FileItem[] = []
  for await (const entry of directory) {
    if (entry.name === '.' || entry.name === '..') continue
    try {
      items.push(await toFileItem(root.path, path.join(absolutePath, entry.name), entry.name))
    } catch {}
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { root, path: toRelative(root.path, absolutePath), breadcrumbs: getBreadcrumbs(toRelative(root.path, absolutePath)), items }
}
async function readPreview(rootId: string, relativePath: string, line = 1) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory()) return { path: toRelative(root.path, absolutePath), type: 'directory', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: false, lines: [] }
  if (info.size > LARGE_FILE_LIMIT) return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: true, reason: 'large-file', lines: [] }
  const chunk = await readFile(absolutePath)
  if (isLikelyBinary(chunk)) return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: true, truncated: false, reason: 'binary-file', lines: [] }
  const startLine = Math.max(1, Number(line) || 1)
  const text = chunk.subarray(0, PREVIEW_LIMIT).toString('utf8')
  const allLines = text.split(/\r?\n/)
  const lines = allLines.slice(startLine - 1, startLine - 1 + MAX_READ_LINES).map((content, index) => ({ number: startLine + index, content }))
  return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: chunk.length > PREVIEW_LIMIT || allLines.length > lines.length, lines }
}
async function readContent(rootId: string, relativePath: string) {
  const { root, absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory()) return { path: toRelative(root.path, absolutePath), type: 'directory', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: false, reason: 'directory', encoding: 'utf8', content: '' }
  if (info.size > LARGE_FILE_LIMIT) return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: true, reason: 'large-file', encoding: 'utf8', content: '' }
  const chunk = await readFile(absolutePath)
  if (isLikelyBinary(chunk)) return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: true, truncated: false, reason: 'binary-file', encoding: 'utf8', content: '' }
  return { path: toRelative(root.path, absolutePath), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), binary: false, truncated: false, encoding: 'utf8', content: chunk.toString('utf8') }
}
async function saveContent(rootId: string, relativePath: string, content: string, modifiedAt?: string) {
  const { absolutePath } = await resolveInside(rootId, relativePath)
  const info = await stat(absolutePath)
  if (info.isDirectory()) throw new Error('Directories cannot be saved')
  if (info.size > LARGE_FILE_LIMIT) throw new Error('Large files are read only')
  const existing = await readFile(absolutePath)
  if (isLikelyBinary(existing)) throw new Error('Binary files are read only')
  const currentModifiedAt = info.mtime.toISOString()
  if (modifiedAt && modifiedAt !== currentModifiedAt) {
    const error = new Error('File changed on disk')
    ;(error as Error & { code?: string }).code = 'FILE_MODIFIED'
    throw error
  }
  await writeFile(absolutePath, content, 'utf8')
  const nextInfo = await stat(absolutePath)
  return { ok: true as const, content, modifiedAt: nextInfo.mtime.toISOString(), size: nextInfo.size }
}
async function createFile(rootId: string, directoryPath: string, name: string) {
  const safeName = sanitizePathSegment(name)
  const { root, absolutePath, relativePath } = await resolveInside(rootId, directoryPath)
  const info = await stat(absolutePath)
  if (!info.isDirectory()) throw new Error('Target directory not found')
  const targetPath = path.join(absolutePath, safeName)
  if (await fileExists(targetPath)) throw new Error('File already exists')
  await writeFile(targetPath, '', 'utf8')
  return { ok: true as const, item: await toFileItem(root.path, targetPath, safeName), parentPath: relativePath }
}
async function createDirectory(rootId: string, directoryPath: string, name: string) {
  const safeName = sanitizePathSegment(name)
  const { root, absolutePath, relativePath } = await resolveInside(rootId, directoryPath)
  const info = await stat(absolutePath)
  if (!info.isDirectory()) throw new Error('Target directory not found')
  const targetPath = path.join(absolutePath, safeName)
  if (await fileExists(targetPath)) throw new Error('Directory already exists')
  await mkdir(targetPath, { recursive: false })
  return { ok: true as const, item: await toFileItem(root.path, targetPath, safeName), parentPath: relativePath }
}
async function renameEntry(rootId: string, relativePath: string, name: string) {
  const safeName = sanitizePathSegment(name)
  const { root, absolutePath, relativePath: currentPath } = await resolveInside(rootId, relativePath)
  const targetPath = path.join(path.dirname(absolutePath), safeName)
  if (absolutePath === root.path) throw new Error('Root cannot be renamed')
  if (targetPath === absolutePath) return { ok: true as const, item: await toFileItem(root.path, absolutePath, safeName), previousPath: currentPath }
  if (await fileExists(targetPath)) throw new Error('Target already exists')
  await rename(absolutePath, targetPath)
  return { ok: true as const, item: await toFileItem(root.path, targetPath, safeName), previousPath: currentPath }
}
async function removeEntry(rootId: string, relativePath: string) {
  const { root, absolutePath, relativePath: currentPath } = await resolveInside(rootId, relativePath)
  if (absolutePath === root.path) throw new Error('Root cannot be removed')
  const info = await stat(absolutePath)
  if (info.isDirectory()) await rm(absolutePath, { recursive: true, force: false })
  else await unlink(absolutePath)
  return { ok: true as const, path: currentPath, type: info.isDirectory() ? 'directory' as const : 'file' as const }
}
async function walk(rootPath: string, startPath: string, visitor: (absolutePath: string, relativePath: string, entryType: 'file' | 'directory') => Promise<boolean | 'skip' | void>) {
  const queue = [startPath]
  let dirs = 0
  let files = 0
  while (queue.length && dirs < MAX_DIRS && files < MAX_FILES) {
    const current = queue.shift()!
    dirs++
    let directory
    try {
      directory = await opendir(current)
    } catch {
      continue
    }
    for await (const entry of directory) {
      const absolutePath = path.join(current, entry.name)
      const relativePath = toRelative(rootPath, absolutePath)
      if (entry.isDirectory()) {
        const result = await visitor(absolutePath, relativePath, 'directory')
        if (result === false) return
        if (result === 'skip') continue
        queue.push(absolutePath)
      } else if (entry.isFile()) {
        files++
        if (await visitor(absolutePath, relativePath, 'file') === false) return
      }
      if (dirs >= MAX_DIRS || files >= MAX_FILES) return
    }
  }
}
function parseSearchQuery(query: string) {
  return query.split('|').map((part) => {
    const tokens = Array.from(part.matchAll(/"([^"]+)"|(\S+)/g)).map((match) => (match[1] || match[2] || '').trim().toLowerCase()).filter(Boolean)
    return [...new Set(tokens)]
  }).filter((tokens) => tokens.length > 0)
}
function matchesSearchQuery(value: string, clauses: string[][]) {
  const target = value.toLowerCase()
  return clauses.some((terms) => terms.every((term) => target.includes(term)))
}
function matchesAnySearchTerm(value: string, clauses: string[][]) {
  const target = value.toLowerCase()
  return clauses.some((terms) => terms.some((term) => target.includes(term)))
}
async function searchName(rootId: string, query: string, basePath = '', includeDotFiles = true) {
  const clauses = parseSearchQuery(query)
  if (!clauses.length) return []
  const { root, absolutePath } = await resolveInside(rootId, basePath)
  const results: FileItem[] = []
  await walk(root.path, absolutePath, async (current, relativePath, entryType) => {
    if (!includeDotFiles && isDotPath(relativePath)) return entryType === 'directory' ? 'skip' : undefined
    if (!matchesSearchQuery(path.basename(relativePath), clauses)) return
    try {
      results.push(await toFileItem(root.path, current, path.basename(current)))
    } catch {}
    return results.length < MAX_RESULTS
  })
  return results
}
async function searchContentWithRg(rootPath: string, absolutePath: string, clauses: string[][], includeDotFiles = true) {
  const results = new Map<string, ContentSearchResult>()
  for (const terms of clauses) {
    const args = ['--json', '-n', '-i', '--fixed-strings', '--hidden', '-uu']
    for (const term of terms) args.push('-e', term)
    args.push('.')
    try {
      const { stdout } = await execFileAsync('rg', args, { cwd: absolutePath, maxBuffer: RG_MAX_BUFFER })
      const matchesByPath = new Map<string, { path: string; name: string; termHits: Set<string>; matches: SearchMatchLine[] }>()
      for (const line of stdout.split('\n')) {
        if (!line) continue
        let payload: any
        try {
          payload = JSON.parse(line)
        } catch {
          continue
        }
        if (payload.type !== 'match') continue
        const rawPath = typeof payload.data?.path?.text === 'string' ? payload.data.path.text : ''
        if (!rawPath) continue
        const resolvedPath = path.resolve(absolutePath, rawPath)
        const relativePath = toRelative(rootPath, resolvedPath)
        if (!includeDotFiles && isDotPath(relativePath)) continue
        const lineNumber = Number(payload.data?.line_number || 0)
        const content = typeof payload.data?.lines?.text === 'string' ? payload.data.lines.text.replace(/\r?\n$/, '').slice(0, 240) : ''
        const item = matchesByPath.get(relativePath) || { path: relativePath, name: path.basename(relativePath), termHits: new Set<string>(), matches: [] }
        const lowerContent = content.toLowerCase()
        for (const term of terms) {
          if (lowerContent.includes(term)) item.termHits.add(term)
        }
        if (lineNumber > 0 && content && item.matches.length < SEARCH_MATCH_LIMIT && !item.matches.some((entry) => entry.number === lineNumber)) {
          item.matches.push({ number: lineNumber, content })
        }
        matchesByPath.set(relativePath, item)
      }
      for (const item of matchesByPath.values()) {
        if (item.termHits.size !== terms.length) continue
        if (results.has(item.path)) {
          const current = results.get(item.path)!
          for (const match of item.matches) {
            if (current.matches.length >= SEARCH_MATCH_LIMIT) break
            if (!current.matches.some((entry) => entry.number === match.number)) current.matches.push(match)
          }
          continue
        }
        try {
          const info = await stat(path.join(rootPath, item.path))
          results.set(item.path, { name: item.name, path: item.path, type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), matches: item.matches })
        } catch {}
        if (results.size >= MAX_RESULTS) return [...results.values()]
      }
    } catch (error) {
      const err = error as Error & { code?: number }
      if (err.code === 1) continue
      throw error
    }
  }
  return [...results.values()]
}
async function searchContentFallback(rootId: string, clauses: string[][], basePath = '', includeDotFiles = true) {
  const { root, absolutePath } = await resolveInside(rootId, basePath)
  const results: ContentSearchResult[] = []
  await walk(root.path, absolutePath, async (current, relativePath, entryType) => {
    if (!includeDotFiles && isDotPath(relativePath)) return entryType === 'directory' ? 'skip' : undefined
    if (entryType !== 'file') return
    try {
      const info = await stat(current)
      if (info.size > LARGE_FILE_LIMIT) return
      const buffer = await readFile(current)
      if (isLikelyBinary(buffer)) return
      const text = buffer.toString('utf8')
      if (!matchesSearchQuery(text, clauses)) return
      const lines = text.split(/\r?\n/)
      const matches: SearchMatchLine[] = []
      for (let i = 0; i < lines.length && matches.length < SEARCH_MATCH_LIMIT; i++) {
        if (matchesAnySearchTerm(lines[i], clauses)) matches.push({ number: i + 1, content: lines[i].slice(0, 240) })
      }
      if (matches.length) results.push({ path: relativePath, name: path.basename(current), type: 'file', size: info.size, modifiedAt: info.mtime.toISOString(), matches })
    } catch {}
    return results.length < MAX_RESULTS
  })
  return results
}
async function searchContent(rootId: string, query: string, basePath = '', includeDotFiles = true) {
  const clauses = parseSearchQuery(query)
  if (!clauses.length) return []
  const { root, absolutePath } = await resolveInside(rootId, basePath)
  try {
    return await searchContentWithRg(root.path, absolutePath, clauses, includeDotFiles)
  } catch {
    return searchContentFallback(rootId, clauses, basePath, includeDotFiles)
  }
}
function getFallbackRoot(roots: FileRoot[]) {
  return roots.find((item) => item.label.toLowerCase() === 'workspace') || roots[0]
}
function mapAbsolutePathToRoot(roots: FileRoot[], absolutePath: string) {
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length)
  return sortedRoots.find((root) => absolutePath === root.path || absolutePath.startsWith(getRootPrefix(root.path))) || null
}
async function getPaneCurrentPath(paneId: string) {
  await assertTargetAllowed(paneId)
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}'])
  return stdout.trim()
}
async function resolveDefaultUploadTarget(paneId?: string) {
  const roots = await getRoots()
  const fallbackRoot = getFallbackRoot(roots)
  if (paneId) {
    try {
      const cwd = await getPaneCurrentPath(paneId)
      const matchedRoot = mapAbsolutePathToRoot(roots, cwd)
      if (matchedRoot) {
        const relativePath = toRelative(matchedRoot.path, cwd)
        return { rootId: matchedRoot.id, rootLabel: matchedRoot.label, rootPath: matchedRoot.path, path: relativePath, absolutePath: cwd, source: 'pane' as const }
      }
    } catch {}
  }
  const absolutePath = path.join(fallbackRoot.path, DEFAULT_UPLOAD_DIR)
  return { rootId: fallbackRoot.id, rootLabel: fallbackRoot.label, rootPath: fallbackRoot.path, path: DEFAULT_UPLOAD_DIR, absolutePath, source: 'fallback' as const }
}
function sanitizeUploadFileName(filename: string) {
  const normalized = path.basename(filename || '').replace(/\0/g, '').trim()
  if (!normalized || normalized === '.' || normalized === '..') throw new Error('Invalid file name')
  return normalized
}
async function fileExists(absolutePath: string) {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}
async function resolveUploadDestination(directoryPath: string, fileName: string) {
  const parsed = path.parse(fileName)
  let attempt = 0
  while (attempt < 1000) {
    const candidateName = attempt === 0 ? fileName : `${parsed.name} (${attempt})${parsed.ext}`
    const candidatePath = path.join(directoryPath, candidateName)
    if (!(await fileExists(candidatePath))) return { candidateName, candidatePath }
    attempt += 1
  }
  throw new Error('Too many conflicting files')
}
function normalizeUploadRateLimitKBps(input: unknown) {
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  return Math.max(1, Math.min(MAX_UPLOAD_RATE_LIMIT_KBPS, Math.round(value)))
}
async function readStoredUploadRateLimitKBps(profile = 'default') {
  const preferencesDir = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')
  const file = path.join(preferencesDir, `${profile}.json`)
  try {
    const content = await readPreferencesFile(file, 'utf8')
    const parsed = JSON.parse(content)
    return normalizeUploadRateLimitKBps(parsed?.uploadRateLimitKBps)
  } catch {
    return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  }
}
async function readStoredDownloadRateLimitKBps(profile = 'default') {
  const preferencesDir = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')
  const file = path.join(preferencesDir, `${profile}.json`)
  try {
    const content = await readPreferencesFile(file, 'utf8')
    const parsed = JSON.parse(content)
    return normalizeUploadRateLimitKBps(parsed?.downloadRateLimitKBps)
  } catch {
    return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  }
}
function createRateLimitStream(rateLimitKBps: number) {
  const bytesPerSecond = Math.max(1, rateLimitKBps) * 1024
  let budget = bytesPerSecond
  let lastRefill = Date.now()
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  return new Transform({
    async transform(chunk, _encoding, callback) {
      let offset = 0
      try {
        while (offset < chunk.length) {
          const now = Date.now()
          const elapsed = now - lastRefill
          if (elapsed > 0) {
            budget = Math.min(bytesPerSecond, budget + (bytesPerSecond * elapsed) / 1000)
            lastRefill = now
          }
          if (budget < 1) {
            const waitMs = Math.max(1, Math.ceil(((1 - budget) / bytesPerSecond) * 1000))
            await wait(waitMs)
            continue
          }
          const size = Math.min(chunk.length - offset, Math.max(1, Math.floor(budget)))
          this.push(chunk.subarray(offset, offset + size))
          offset += size
          budget -= size
        }
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
  })
}
async function resolveDownloadRateLimitKBps(queryRateLimitKBps?: unknown, profile = 'default') {
  const value = typeof queryRateLimitKBps === 'number' ? queryRateLimitKBps : typeof queryRateLimitKBps === 'string' && queryRateLimitKBps.trim() ? Number(queryRateLimitKBps) : NaN
  if (Number.isFinite(value)) return normalizeUploadRateLimitKBps(value)
  return readStoredDownloadRateLimitKBps(profile)
}
function getImageMimeType(filePath: string) {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || ''
}
async function listDirectoryForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') return listDirectory(rootId, relativePath)
  return runRemoteFileJson(hostId, { op: 'list', root: rootId, path: relativePath })
}
async function readPreviewForHost(hostId: string, rootId: string, relativePath: string, line = 1) {
  if (hostId === 'local') return readPreview(rootId, relativePath, line)
  return runRemoteFileJson(hostId, { op: 'preview', root: rootId, path: relativePath, line })
}
async function readContentForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') return readContent(rootId, relativePath)
  return runRemoteFileJson(hostId, { op: 'content', root: rootId, path: relativePath })
}
async function saveContentForHost(hostId: string, rootId: string, relativePath: string, content: string, modifiedAt?: string) {
  if (hostId === 'local') return saveContent(rootId, relativePath, content, modifiedAt)
  try {
    return await runRemoteFileJson(hostId, { op: 'save', root: rootId, path: relativePath, content, modifiedAt })
  } catch (error) {
    const err = error as Error & { code?: string }
    if (err.message.startsWith('FILE_MODIFIED:')) {
      err.message = err.message.slice('FILE_MODIFIED:'.length)
      err.code = 'FILE_MODIFIED'
    }
    throw err
  }
}
async function createFileForHost(hostId: string, rootId: string, directoryPath: string, name: string) {
  if (hostId === 'local') return createFile(rootId, directoryPath, name)
  return runRemoteFileJson(hostId, { op: 'create-file', root: rootId, path: directoryPath, name })
}
async function createDirectoryForHost(hostId: string, rootId: string, directoryPath: string, name: string) {
  if (hostId === 'local') return createDirectory(rootId, directoryPath, name)
  return runRemoteFileJson(hostId, { op: 'create-directory', root: rootId, path: directoryPath, name })
}
async function renameEntryForHost(hostId: string, rootId: string, relativePath: string, name: string) {
  if (hostId === 'local') return renameEntry(rootId, relativePath, name)
  return runRemoteFileJson(hostId, { op: 'rename', root: rootId, path: relativePath, name })
}
async function removeEntryForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') return removeEntry(rootId, relativePath)
  return runRemoteFileJson(hostId, { op: 'remove', root: rootId, path: relativePath })
}
async function searchNameForHost(hostId: string, rootId: string, query: string, basePath = '', includeDotFiles = true) {
  if (hostId === 'local') return searchName(rootId, query, basePath, includeDotFiles)
  return runRemoteFileJson(hostId, { op: 'search-name', root: rootId, path: basePath, query, includeDotFiles })
}
async function searchContentForHost(hostId: string, rootId: string, query: string, basePath = '', includeDotFiles = true) {
  if (hostId === 'local') return searchContent(rootId, query, basePath, includeDotFiles)
  return runRemoteFileJson(hostId, { op: 'search-content', root: rootId, path: basePath, query, includeDotFiles })
}
async function resolveDefaultUploadTargetForHost(hostId: string, paneId?: string) {
  if (hostId === 'local') return resolveDefaultUploadTarget(paneId)
  return runRemoteFileJson(hostId, { op: 'default-upload-target' })
}
async function resolveFileForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') {
    const resolved = await resolveInside(rootId, relativePath)
    const info = await stat(resolved.absolutePath)
    return { ...resolved, size: info.size, isFile: info.isFile() }
  }
  return runRemoteFileJson<{ root: FileRoot; absolutePath: string; relativePath: string; size: number; isFile: boolean }>(hostId, { op: 'resolve-file', root: rootId, path: relativePath })
}

export async function fileRoutes(fastify: FastifyInstance) {
  fastify.get('/hosts/:hostId/files/roots', async (request) => {
    const { hostId } = request.params as { hostId: string }
    if (hostId === 'local') return getRoots()
    return runRemoteFileJson<FileRoot[]>(hostId, { op: 'roots' })
  })
  fastify.get('/hosts/:hostId/files/list', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string }
    return listDirectoryForHost(hostId, query.root || '', query.path || '')
  })
  fastify.get('/hosts/:hostId/files/preview', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string; line?: string }
    return readPreviewForHost(hostId, query.root || '', query.path || '', parseInt(query.line || '1', 10))
  })
  fastify.get('/hosts/:hostId/files/content', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string }
    return readContentForHost(hostId, query.root || '', query.path || '')
  })
  fastify.put('/hosts/:hostId/files/content', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const body = request.body as { root?: string; path?: string; content?: string; modifiedAt?: string }
    try {
      return await saveContentForHost(hostId, body.root || '', body.path || '', typeof body.content === 'string' ? body.content : '', body.modifiedAt)
    } catch (error) {
      const err = error as Error & { code?: string }
      if (err.code === 'FILE_MODIFIED') return reply.status(409).send({ message: err.message, code: err.code })
      return reply.status(400).send({ message: err.message || 'Save failed', code: err.code || 'SAVE_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/create-file', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const body = request.body as { root?: string; path?: string; name?: string }
    try {
      return await createFileForHost(hostId, body.root || '', body.path || '', typeof body.name === 'string' ? body.name : '')
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Create failed', code: 'CREATE_FILE_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/create-directory', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const body = request.body as { root?: string; path?: string; name?: string }
    try {
      return await createDirectoryForHost(hostId, body.root || '', body.path || '', typeof body.name === 'string' ? body.name : '')
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Create failed', code: 'CREATE_DIRECTORY_FAILED' })
    }
  })
  fastify.post('/hosts/:hostId/files/rename', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const body = request.body as { root?: string; path?: string; name?: string }
    try {
      return await renameEntryForHost(hostId, body.root || '', body.path || '', typeof body.name === 'string' ? body.name : '')
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Rename failed', code: 'RENAME_FAILED' })
    }
  })
  fastify.delete('/hosts/:hostId/files/remove', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string }
    try {
      return await removeEntryForHost(hostId, query.root || '', query.path || '')
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Remove failed', code: 'REMOVE_FAILED' })
    }
  })
  fastify.get('/hosts/:hostId/files/search-name', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; q?: string; basePath?: string; includeDotFiles?: string }
    return searchNameForHost(hostId, query.root || '', query.q || '', query.basePath || '', query.includeDotFiles !== 'false')
  })
  fastify.get('/hosts/:hostId/files/search-content', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; q?: string; basePath?: string; includeDotFiles?: string }
    return searchContentForHost(hostId, query.root || '', query.q || '', query.basePath || '', query.includeDotFiles !== 'false')
  })
  fastify.get('/hosts/:hostId/files/default-upload-target', async (request) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { paneId?: string }
    return resolveDefaultUploadTargetForHost(hostId, query.paneId)
  })
  fastify.post('/hosts/:hostId/files/upload', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    if (hostId !== 'local') return reply.status(400).send({ message: 'Remote upload is not supported yet', code: 'REMOTE_UPLOAD_UNSUPPORTED' })
    const parts = request.parts()
    let targetRootId = ''
    let targetPath = ''
    let conflictPolicy = 'rename'
    let rateLimitKBps = await readStoredUploadRateLimitKBps()
    let resolvedTarget: Awaited<ReturnType<typeof resolveInside>> | null = null
    const uploadedFiles = []
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!targetRootId) throw new Error('Missing target root')
        if (conflictPolicy !== 'rename') throw new Error('Unsupported conflict policy')
        if (!resolvedTarget) {
          resolvedTarget = await resolveInside(targetRootId, targetPath)
          await mkdir(resolvedTarget.absolutePath, { recursive: true })
        }
        const safeName = sanitizeUploadFileName(part.filename)
        const { candidateName, candidatePath } = await resolveUploadDestination(resolvedTarget.absolutePath, safeName)
        await pipeline(part.file, createRateLimitStream(rateLimitKBps), createWriteStream(candidatePath))
        const info = await stat(candidatePath)
        uploadedFiles.push({
          name: candidateName,
          path: toRelative(resolvedTarget.root.path, candidatePath),
          absolutePath: candidatePath,
          size: info.size,
        })
        continue
      }
      const value = typeof part.value === 'string' ? part.value : ''
      if (part.fieldname === 'targetRootId') targetRootId = value
      else if (part.fieldname === 'targetPath') targetPath = value
      else if (part.fieldname === 'conflictPolicy') conflictPolicy = value || 'rename'
      else if (part.fieldname === 'rateLimitKBps') rateLimitKBps = normalizeUploadRateLimitKBps(value)
    }
    if (!resolvedTarget) throw new Error('No files uploaded')
    return {
      ok: true,
      target: {
        rootId: resolvedTarget.root.id,
        rootLabel: resolvedTarget.root.label,
        rootPath: resolvedTarget.root.path,
        path: resolvedTarget.relativePath,
        absolutePath: resolvedTarget.absolutePath,
        source: 'preferred' as const,
      },
      files: uploadedFiles,
    }
  })
  fastify.get('/hosts/:hostId/files/download', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string; profile?: string; rateLimitKBps?: string }
    try {
      const fileInfo = await resolveFileForHost(hostId, query.root || '', query.path || '')
      if (!fileInfo.isFile) return reply.status(400).send({ message: 'Directories are not downloadable here', code: 'DOWNLOAD_UNSUPPORTED' })
      const rateLimitKBps = await resolveDownloadRateLimitKBps(query.rateLimitKBps, query.profile || 'default')
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Length', String(fileInfo.size))
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(fileInfo.absolutePath)).replace(/%20/g, ' ')}"`)
      if (hostId === 'local') return reply.send(createReadStream(fileInfo.absolutePath).pipe(createRateLimitStream(rateLimitKBps)))
      const buffer = await readRemoteBinary(hostId, fileInfo.absolutePath)
      return reply.send(buffer)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Download failed', code: 'DOWNLOAD_FAILED' })
    }
  })
  fastify.get('/hosts/:hostId/files/image', async (request, reply) => {
    const { hostId } = request.params as { hostId: string }
    const query = request.query as { root?: string; path?: string }
    try {
      const fileInfo = await resolveFileForHost(hostId, query.root || '', query.path || '')
      if (!fileInfo.isFile) return reply.status(400).send({ message: 'Directories are not previewable here', code: 'IMAGE_PREVIEW_UNSUPPORTED' })
      const mimeType = getImageMimeType(fileInfo.absolutePath)
      if (!mimeType) return reply.status(400).send({ message: 'Image preview unavailable for this file type', code: 'IMAGE_TYPE_UNSUPPORTED' })
      reply.header('Content-Type', mimeType)
      reply.header('Content-Length', String(fileInfo.size))
      reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(fileInfo.absolutePath)).replace(/%20/g, ' ')}"`)
      reply.header('Cache-Control', 'no-store')
      reply.header('X-Content-Type-Options', 'nosniff')
      if (hostId === 'local') return reply.send(createReadStream(fileInfo.absolutePath))
      const buffer = await readRemoteBinary(hostId, fileInfo.absolutePath)
      return reply.send(buffer)
    } catch (error) {
      const err = error as Error
      return reply.status(400).send({ message: err.message || 'Image preview failed', code: 'IMAGE_PREVIEW_FAILED' })
    }
  })
}
