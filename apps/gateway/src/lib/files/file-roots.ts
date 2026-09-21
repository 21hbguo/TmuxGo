import os from 'os'
import path from 'path'
import { cp, mkdir, opendir, realpath, rename, rm, stat } from 'fs/promises'
import { isPathInside, normalizeRelativePath } from '../file-path.js'
import { runRemoteFilePython } from '../remote-file-command.js'
import {
  DEFAULT_TEMP_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_TEMP_UPLOAD_TTL_MS,
  TEMP_UPLOAD_ROOT_ID,
  TEMP_UPLOAD_ROOT_LABEL,
  rootSpec,
  readPositiveIntegerEnv,
  type FileItem,
  type FileRoot,
} from './file-types.js'
let rootsCache: Promise<FileRoot[]> | null = null
let tempUploadCleanupTimer: NodeJS.Timeout | null = null
export async function getRoots() {
  if (!rootsCache) {
    rootsCache = Promise.all(
      rootSpec
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(async (entry, index) => {
          const [labelRaw, pathRaw] = entry.includes('=') ? entry.split(/=(.*)/s).filter(Boolean) : ['', entry]
          const resolved = await realpath(path.resolve(pathRaw))
          return { id: `root-${index}`, label: labelRaw || path.basename(resolved) || resolved, path: resolved }
        }),
    )
  }
  return rootsCache
}
export const REMOTE_FILE_SCRIPT = `import base64,datetime,json,os,pathlib,shutil,stat,sys,urllib.parse
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
 if isinstance(root_id,str) and root_id.startswith('git:'):
  try: p=urllib.parse.unquote(root_id[4:])
  except: raise Exception('Invalid root')
  if not p: raise Exception('Invalid root')
  base=str(pathlib.Path(p).resolve())
  return {'id':root_id,'label':pathlib.Path(base).name or base,'path':base}
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
 return {'name':name,'path':norm_rel(os.path.relpath(abs_path,root_path)),'type':'directory' if stat.S_ISDIR(st.st_mode) else 'file','size':st.st_size,'modifiedAt':iso(st.st_mtime),'mode':st.st_mode & 0o7777}
def breadcrumbs(rel):
 parts=[p for p in rel.split('/') if p]
 out=[{'name':'/','path':''}]
 for i,name in enumerate(parts): out.append({'name':name,'path':'/'.join(parts[:i+1])})
 return out
def copy_name(directory,name):
 dot=name.rfind('.')
 stem,ext=(name[:dot],name[dot:]) if dot>0 else (name,'')
 for i in range(1000):
  suffix='' if i==0 else (' copy' if i==1 else ' copy '+str(i))
  candidate=stem+suffix+ext
  if not (pathlib.Path(directory)/candidate).exists(): return candidate
 raise Exception('Too many conflicting files')
include_dotfiles=payload.get('includeDotFiles',True)
if isinstance(include_dotfiles,str): include_dotfiles=include_dotfiles.lower()!='false'
op=payload['op']
if op=='roots':
 print(json.dumps(roots()));sys.exit(0)
if op=='trash-list':
 trash=pathlib.Path.home()/'.tmuxgo'/'trash';items=[]
 if trash.exists():
  for item in trash.iterdir():
   try:
    meta=json.loads((item/'meta.json').read_text(encoding='utf-8'));items.append(meta)
   except: pass
 print(json.dumps(sorted(items,key=lambda item:item.get('deletedAt',''),reverse=True)));sys.exit(0)
if op=='trash-restore':
 trash_id=str(payload.get('trashId',''))
 if not trash_id or '/' in trash_id or '\\\\' in trash_id: raise Exception('Invalid trash id')
 entry=pathlib.Path.home()/'.tmuxgo'/'trash'/trash_id;meta=json.loads((entry/'meta.json').read_text(encoding='utf-8'))
 root,target,rel=resolve_inside(meta['rootId'],meta['path'])
 if pathlib.Path(target).exists(): raise Exception('Restore target already exists')
 pathlib.Path(target).parent.mkdir(parents=True,exist_ok=True);shutil.move(str(entry/'data'),target);shutil.rmtree(entry)
 print(json.dumps({'ok':True,'item':file_item(root['path'],target,pathlib.Path(target).name)}));sys.exit(0)
if op=='git-repositories':
 skip={'.cache','.local','.npm','.next','.next-dev','.next-prod','.venv','__pycache__','build','dist','node_modules','postgres_data','venv'}
 found={}
 dirs=0
 for root in roots():
  queue=[(root['path'],0)]
  while queue and dirs<12000 and len(found)<200:
   current,depth=queue.pop(0);dirs+=1
   try: entries=list(os.scandir(current))
   except: continue
   if any(entry.name=='.git' for entry in entries): found[current]={'path':current,'label':pathlib.Path(current).name or current}
   if depth>=6: continue
   for entry in entries:
    if entry.name=='.git' or entry.name in skip or entry.name.startswith('.'): continue
    try:
     if entry.is_dir(follow_symlinks=False): queue.append((entry.path,depth+1))
    except: pass
 print(json.dumps(sorted(found.values(),key=lambda item:(item['label'].lower(),item['path'].lower()))));sys.exit(0)
if op=='default-upload-target':
 items=roots();root=next((item for item in items if item['label'].lower()=='workspace'),items[0] if items else None)
 if not root: raise Exception('No file roots configured')
 abs_path=str((pathlib.Path(root['path'])/DEFAULT_UPLOAD_DIR).resolve())
 print(json.dumps({'rootId':root['id'],'rootLabel':root['label'],'rootPath':root['path'],'path':DEFAULT_UPLOAD_DIR,'absolutePath':abs_path,'source':'fallback'}));sys.exit(0)
root,abs_path,rel=resolve_inside(payload.get('root',''),payload.get('path',''))
if op=='prepare-upload':
 name=str(payload.get('name','')).strip()
 if not name or '/' in name or '\\\\' in name or name in ('.','..'): raise Exception('Invalid name')
 pathlib.Path(abs_path).mkdir(parents=True,exist_ok=True);candidate=pathlib.Path(abs_path)/name;stem=candidate.stem;suffix=candidate.suffix;attempt=0
 while candidate.exists() and attempt<1000:
  attempt+=1;candidate=pathlib.Path(abs_path)/f'{stem} ({attempt}){suffix}'
 if candidate.exists(): raise Exception('Too many conflicting files')
 print(json.dumps({'root':root,'directoryPath':rel,'directoryAbsolutePath':abs_path,'name':candidate.name,'path':norm_rel(os.path.relpath(str(candidate),root['path'])),'absolutePath':str(candidate)}));sys.exit(0)
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
if op in ('copy','move'):
 target_root,target_dir,target_rel=resolve_inside(payload.get('targetRoot',''),payload.get('targetPath',''))
 if not pathlib.Path(target_dir).is_dir(): raise Exception('Target directory not found')
 target=str(pathlib.Path(target_dir)/copy_name(target_dir,pathlib.Path(abs_path).name))
 if op=='move': shutil.move(abs_path,target)
 elif pathlib.Path(abs_path).is_dir(): shutil.copytree(abs_path,target)
 else: shutil.copy2(abs_path,target)
 print(json.dumps({'ok':True,'item':file_item(target_root['path'],target,pathlib.Path(target).name),'previousPath':rel}));sys.exit(0)
if op=='trash':
 if str(pathlib.Path(abs_path).resolve())==str(pathlib.Path(root['path']).resolve()): raise Exception('Root cannot be trashed')
 trash_id=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f')
 entry=pathlib.Path.home()/'.tmuxgo'/'trash'/trash_id;entry.mkdir(parents=True)
 typ='directory' if pathlib.Path(abs_path).is_dir() else 'file';deleted_at=iso(datetime.datetime.now(datetime.timezone.utc).timestamp())
 shutil.move(abs_path,str(entry/'data'));meta={'id':trash_id,'rootId':root['id'],'path':rel,'name':pathlib.Path(abs_path).name,'type':typ,'deletedAt':deleted_at};(entry/'meta.json').write_text(json.dumps(meta),encoding='utf-8')
 print(json.dumps({'ok':True,'entry':meta}));sys.exit(0)
if op=='remove':
 if str(pathlib.Path(abs_path).resolve())==str(pathlib.Path(root['path']).resolve()): raise Exception('Root cannot be removed')
 typ='directory' if pathlib.Path(abs_path).is_dir() else 'file'
 shutil.rmtree(abs_path) if typ=='directory' else pathlib.Path(abs_path).unlink()
 print(json.dumps({'ok':True,'path':rel,'type':typ}));sys.exit(0)
if op=='resolve-file':
 print(json.dumps({'root':root,'absolutePath':abs_path,'relativePath':rel,'size':st.st_size,'isFile':pathlib.Path(abs_path).is_file()}));sys.exit(0)
query=str(payload.get('query','')).lower().strip()
# 可选扩展名过滤（与本地 searchContent 的 ext 对齐）；旧调用方不带此 key
ext=str(payload.get('ext') or '').lower()
path_search=os.path.isabs(query)
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
   if not match_name(name) and not (path_search and match_name(current)): continue
   try: results.append(file_item(root['path'],current,name))
   except: pass
  else:
   if is_dir: continue
   if ext and not name.lower().endswith(ext): continue
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
    if matches: results.append({'name':name,'path':relative,'type':'file','size':info.st_size,'modifiedAt':iso(info.st_mtime),'mode':info.st_mode & 0o7777,'matches':matches})
   except: pass
  if len(results)>=MAX_RESULTS: break
 if len(results)>=MAX_RESULTS: break
print(json.dumps(results[:MAX_RESULTS]))`
export function encodeRemotePayload(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}
export async function runRemoteFileJson<T>(hostId: string, payload: Record<string, unknown>) {
  return runRemoteFilePython<T>(hostId, REMOTE_FILE_SCRIPT, [encodeRemotePayload(payload)])
}
export function getTemporaryUploadDir() {
  return path.resolve(process.env.TMUXGO_TMP_DIR || path.join(os.homedir(), '.tmuxgo', 'tmp', 'paste'))
}
export async function getTemporaryUploadTarget() {
  const absolutePath = getTemporaryUploadDir()
  await mkdir(absolutePath, { recursive: true })
  return {
    rootId: TEMP_UPLOAD_ROOT_ID,
    rootLabel: TEMP_UPLOAD_ROOT_LABEL,
    rootPath: absolutePath,
    path: '',
    absolutePath,
    source: 'temporary' as const,
  }
}
async function resolveTemporaryInside(relativePath = '') {
  const target = await getTemporaryUploadTarget()
  const root = { id: target.rootId, label: target.rootLabel, path: target.rootPath }
  const normalizedPath = normalizeRelativePath(relativePath)
  const requested = path.resolve(root.path, normalizedPath || '.')
  if (!isPathInside(root.path, requested)) throw new Error('Path escapes root')
  let actual = requested
  try {
    actual = await realpath(requested)
  } catch {
    actual = requested
  }
  if (!isPathInside(root.path, actual)) throw new Error('Path escapes root')
  return { root, absolutePath: actual, relativePath: normalizeRelativePath(path.relative(root.path, actual)) }
}
export async function cleanupExpiredTemporaryUploads(now = Date.now()) {
  const ttlMs = readPositiveIntegerEnv('TMUXGO_TMP_TTL_MS', DEFAULT_TEMP_UPLOAD_TTL_MS)
  const dir = getTemporaryUploadDir()
  let entries
  try {
    entries = await opendir(dir)
  } catch {
    return
  }
  for await (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    try {
      const info = await stat(entryPath)
      if (now - info.mtimeMs > ttlMs) await rm(entryPath, { recursive: true, force: true })
    } catch {}
  }
}
export function startTemporaryUploadCleanup() {
  if (tempUploadCleanupTimer) return
  void cleanupExpiredTemporaryUploads()
  const intervalMs = readPositiveIntegerEnv('TMUXGO_TMP_CLEANUP_INTERVAL_MS', DEFAULT_TEMP_UPLOAD_CLEANUP_INTERVAL_MS)
  tempUploadCleanupTimer = setInterval(() => void cleanupExpiredTemporaryUploads(), intervalMs)
  tempUploadCleanupTimer.unref?.()
}
function resolveGitInside(rootId: string, relativePath = '') {
  let repoPath = ''
  try {
    repoPath = decodeURIComponent(rootId.slice(4))
  } catch {
    throw new Error('Invalid root')
  }
  if (!repoPath) throw new Error('Invalid root')
  const base = path.resolve(repoPath)
  const normalizedPath = normalizeRelativePath(relativePath)
  const absolutePath = path.resolve(base, normalizedPath || '.')
  if (!isPathInside(base, absolutePath)) throw new Error('Path escapes root')
  const root = { id: rootId, label: path.basename(base) || base, path: base }
  return Promise.resolve({ root, absolutePath, relativePath: normalizeRelativePath(path.relative(base, absolutePath)) })
}
export async function resolveInside(rootId: string, relativePath = '') {
  if (rootId === TEMP_UPLOAD_ROOT_ID) return resolveTemporaryInside(relativePath)
  if (rootId.startsWith('git:')) return resolveGitInside(rootId, relativePath)
  const roots = await getRoots()
  const root = roots.find((item) => item.id === rootId)
  if (!root) throw new Error('Invalid root')
  const normalizedPath = normalizeRelativePath(relativePath)
  const requested = path.resolve(root.path, normalizedPath || '.')
  if (!isPathInside(root.path, requested)) throw new Error('Path escapes root')
  let actual = requested
  try {
    actual = await realpath(requested)
  } catch {
    actual = requested
  }
  if (!isPathInside(root.path, actual)) throw new Error('Path escapes root')
  return { root, absolutePath: actual, relativePath: normalizeRelativePath(path.relative(root.path, actual)) }
}
export function toRelative(rootPath: string, absolutePath: string) {
  return normalizeRelativePath(path.relative(rootPath, absolutePath))
}
export async function toFileItem(rootPath: string, absolutePath: string, name: string): Promise<FileItem> {
  const info = await stat(absolutePath)
  return {
    name,
    path: toRelative(rootPath, absolutePath),
    type: info.isDirectory() ? 'directory' : 'file',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    mode: info.mode & 0o7777,
  }
}
export async function fileExists(absolutePath: string) {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}
export async function movePath(source: string, target: string) {
  try {
    await rename(source, target)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'EXDEV') throw error
    await cp(source, target, { recursive: true, preserveTimestamps: true })
    await rm(source, { recursive: true, force: false })
  }
}
export function getTrashDir() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'trash')
}
export async function resolveFileForHost(hostId: string, rootId: string, relativePath: string) {
  if (hostId === 'local') {
    const resolved = await resolveInside(rootId, relativePath)
    const info = await stat(resolved.absolutePath)
    return { ...resolved, size: info.size, isFile: info.isFile() }
  }
  return runRemoteFileJson<{
    root: FileRoot
    absolutePath: string
    relativePath: string
    size: number
    isFile: boolean
  }>(hostId, { op: 'resolve-file', root: rootId, path: relativePath })
}
