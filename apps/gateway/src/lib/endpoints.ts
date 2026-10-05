import { execHostShell } from './tmux-executor.js'

// 端点清单采集：nginx conf / docker 发布端口 / tailscale serve / ss 监听 四源合并。
// 本地与远端统一走 execHostShell（local 自动落 runLocalShell），采集逻辑只写一份
// python——shell 里做 nginx conf 括号块解析代价过高；无 python 的主机回报
// supported:false，前端按空态处理。
export type EndpointSource = 'nginx' | 'docker' | 'tailscale' | 'socket'
export type EndpointSourceState = 'ok' | 'unavailable' | 'error'
export interface EndpointLocation {
  path: string
  target: string
  kind: 'proxy' | 'root' | 'return' | 'other'
}
export interface EndpointItem {
  id: string
  source: EndpointSource
  listen: string
  name: string
  target: string
  detail?: string
  locations?: EndpointLocation[]
}
export interface EndpointsResult {
  hostId: string
  collectedAt: string
  supported: boolean
  sources: Record<EndpointSource, EndpointSourceState>
  endpoints: EndpointItem[]
}

const collectScript = `import glob,json,os,re,shutil,subprocess
def run(cmd,timeout=8):
 # 返回 (stdout, rc)；异常一律 rc=1——区分「没装」与「装了但跑挂」（如 docker socket 无权限）
 try:
  p=subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
  return p.stdout,p.returncode
 except Exception:
  return '',1
def strip_c(t):return re.sub(r'#[^\\n]*','',t)
def blocks(text,kw):
 out=[]
 for m in re.finditer(r'(?<![\\w.-])'+re.escape(kw)+r'\\s+([^{};]*)\\{',text):
  depth,j=1,m.end()
  while j<len(text) and depth:
   if text[j]=='{':depth+=1
   elif text[j]=='}':depth-=1
   j+=1
  if depth==0:out.append((m.group(1).strip(),text[m.end():j-1],m.start(),j))
 return out
def directives(body):
 out={}
 for m in re.finditer(r'([a-zA-Z_][\\w-]*)\\s+([^;{}]+);',body):
  out.setdefault(m.group(1),[]).append(m.group(2).strip())
 return out
NGINX_ROOTS=['/etc/nginx','/usr/local/etc/nginx','/usr/local/nginx/conf','/opt/homebrew/etc/nginx','/opt/etc/nginx']
def nginx_eps():
 roots=[r for r in NGINX_ROOTS if os.path.isdir(r)]
 if not roots:return [],'unavailable'
 files=set();queue=[]
 for r in roots:
  queue+=glob.glob(os.path.join(r,'nginx.conf'))
  queue+=glob.glob(os.path.join(r,'conf.d','*.conf'))
  queue+=glob.glob(os.path.join(r,'sites-enabled','*'))
 texts={}
 for _ in range(4):
  nxt=[]
  for f in queue:
   rf=os.path.realpath(f)
   if rf in texts or not os.path.isfile(rf):continue
   try:t=open(rf,errors='replace').read()
   except OSError:continue
   texts[rf]=t
   for m in re.finditer(r'(?m)^\\s*include\\s+([^;]+);',strip_c(t)):
    for pat in m.group(1).split():
     nxt+=glob.glob(pat if pat.startswith('/') else os.path.join(os.path.dirname(rf),pat))
  queue=nxt
 rows=[]
 for rf,t in sorted(texts.items()):
  t=strip_c(t)
  for _sarg,body,_s,_e in blocks(t,'server'):
   locs=blocks(body,'location')
   top=[l for l in locs if not any(o[2]<l[2]<o[3] for o in locs if o is not l)]
   rest=body
   for _a,_b,ls,le in sorted(top,key=lambda x:-x[2]):rest=rest[:ls]+rest[le:]
   # 再剥 if/limit_except 等其余容器块：块内指令（如 if{return 403}）不得算作 server 直属
   prev=None
   while prev!=rest:
    prev=rest
    rest=re.sub(r'[a-zA-Z_@][\\w@.-]*\\s+[^{};]*\\{[^{}]*\\}','',rest)
   d=directives(rest)
   listen=' '.join(d.get('listen',[])).strip()
   if not listen:continue
   name=' '.join(d.get('server_name',[])).strip()
   def loc_kind(bd):
    ld=directives(bd)
    if ld.get('proxy_pass'):return 'proxy',' '.join(ld['proxy_pass'])
    if ld.get('root') or ld.get('alias'):return 'root',' '.join(ld.get('root') or ld.get('alias') or [])
    if ld.get('return'):return 'return',' '.join(ld['return'])
    if ld.get('proxy_pass') is None and ld.get('grpc_pass'):return 'proxy',' '.join(ld['grpc_pass'])
    return 'other',''
   locations=[{'path':a or '/','target':loc_kind(b)[1],'kind':loc_kind(b)[0]} for a,b,_ls,_le in top]
   target=' '.join(d.get('proxy_pass') or d.get('root') or d.get('return') or [])
   if not target:
    proxied=[l['target'] for l in locations if l['kind']=='proxy']
    target=proxied[0] if proxied else (locations[0]['target'] if locations else '')
   rows.append({'source':'nginx','listen':listen,'name':name,'target':target,'detail':rf,'locations':locations})
 return rows,'ok'
def docker_eps():
 if not shutil.which('docker'):return [],'unavailable'
 out,rc=run(['docker','ps','--format','{{json .}}'])
 if rc!=0:return [],'error'
 rows=[]
 for line in out.splitlines():
  line=line.strip()
  if not line:continue
  try:c=json.loads(line)
  except ValueError:continue
  merged={}
  for part in (c.get('Ports') or '').split(', '):
   m=re.match(r'^(?:([\\[\\]\\w:.*-]+):)?(\\d+)->(\\d+)/(tcp|udp|sctp)$',part.strip())
   if not m:continue
   host=(m.group(1) or '*')+':'+m.group(2)
   merged.setdefault(m.group(3)+'/'+m.group(4),[]).append(host)
  for cport,hosts in merged.items():
   rows.append({'source':'docker','listen':', '.join(hosts),'name':c.get('Names',''),'target':':'+cport,'detail':c.get('Image','')})
 return rows,'ok'
def tailscale_eps():
 if not shutil.which('tailscale'):return [],'unavailable'
 rows=[]
 out,rc=run(['tailscale','serve','status','--json'])
 if rc==0 and out:
  try:
   st=json.loads(out)
   for web,cfg in (st.get('Web') or {}).items():
    for path,h in ((cfg.get('Handlers') or {}).items()):
     target=h.get('Proxy') or h.get('Path') or h.get('Text') or ''
     kind='proxy' if h.get('Proxy') else 'root' if h.get('Path') else 'other'
     rows.append({'source':'tailscale','listen':web,'name':'','target':'','detail':'tailscale serve','locations':[{'path':path,'target':target,'kind':kind}]})
    if cfg and not cfg.get('Handlers'):
     rows.append({'source':'tailscale','listen':web,'name':'','target':'','detail':'tailscale serve'})
  except ValueError:
   pass
 if not rows:
  txt,trc=run(['tailscale','serve','status'])
  if trc!=0:return rows,'error'
  cur=''
  for line in txt.splitlines():
   m=re.match(r'^(https?://\\S+)',line.strip())
   if m:cur=m.group(1);continue
   m=re.match(r'^\\|--\\s+(\\S+)\\s+(\\w+)\\s+(\\S.*)$',line.strip())
   if m and cur:
    rows.append({'source':'tailscale','listen':cur,'name':'','target':'','detail':'tailscale serve','locations':[{'path':m.group(1),'target':m.group(3),'kind':'proxy' if m.group(2)=='proxy' else 'root' if m.group(2)=='path' else 'other'}]})
 return rows,'ok'
def socket_eps(claimed):
 out,rc=run(['ss','-tlnp'])
 if rc!=0:return [],'unavailable'
 rows=[]
 for line in out.splitlines():
  p=line.split()
  if 'LISTEN' not in p:continue
  idx=p.index('LISTEN')
  if len(p)<idx+4:continue
  local=p[idx+3]
  m=re.match(r'^(.*):(\\d+)$',local)
  if not m:continue
  port=int(m.group(2))
  if port in claimed:continue
  rest=' '.join(p[idx+5:])
  name=re.search(r'"([^"]+)"',rest)
  pid=re.search(r'pid=(\\d+)',rest)
  rows.append({'source':'socket','listen':local,'name':name.group(1) if name else '?','target':'','detail':('pid '+pid.group(1)) if pid else ''})
 return rows,'ok'
srcs={}
all_rows=[]
ng,st=nginx_eps();srcs['nginx']=st
claimed=set()
for r in ng:
 for tok in re.findall(r'(?:^|\\s)(?:\\[::\\]|[\\w.*:-]+:)?(\\d+)(?=\\s|$)',r['listen']):
  claimed.add(int(tok))
ts,st=tailscale_eps();srcs['tailscale']=st
dk,st=docker_eps();srcs['docker']=st
for r in dk:
 for hm in re.findall(r':(\\d+)',r['listen']):
  claimed.add(int(hm))
sk,st=socket_eps(claimed);srcs['socket']=st
all_rows=ng+ts+dk+sk
for i,r in enumerate(all_rows):r['id']='%s-%d'%(r['source'],i)
print(json.dumps({'sources':srcs,'endpoints':all_rows}))`

function quoteShellValue(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
const COLLECT_CMD = `if command -v python3 >/dev/null 2>&1; then exec python3 -c ${quoteShellValue(collectScript)}; elif command -v python >/dev/null 2>&1; then exec python -c ${quoteShellValue(collectScript)}; else echo __NOPY__; fi`

const SOURCE_ORDER: EndpointSource[] = ['nginx', 'tailscale', 'docker', 'socket']
const LOCATION_KINDS = new Set(['proxy', 'root', 'return', 'other'])
function normalizeSourceState(value: unknown): EndpointSourceState {
  return value === 'ok' || value === 'error' ? value : 'unavailable'
}
function normalizeEndpoint(value: any, fallbackId: string): EndpointItem | null {
  if (!value || typeof value !== 'object') return null
  const source = String(value.source || '')
  if (!SOURCE_ORDER.includes(source as EndpointSource)) return null
  const locations = Array.isArray(value.locations)
    ? value.locations
        .filter((loc: any) => loc && typeof loc === 'object' && typeof loc.path === 'string')
        .slice(0, 50)
        .map((loc: any): EndpointLocation => {
          const kind = String(loc.kind || '')
          return {
            path: loc.path.slice(0, 256),
            target: String(loc.target || '').slice(0, 512),
            kind: LOCATION_KINDS.has(kind) ? (kind as EndpointLocation['kind']) : 'other',
          }
        })
    : undefined
  return {
    id: String(value.id || fallbackId).slice(0, 128),
    source: source as EndpointSource,
    listen: String(value.listen || '').slice(0, 256),
    name: String(value.name || '').slice(0, 256),
    target: String(value.target || '').slice(0, 512),
    detail: value.detail ? String(value.detail).slice(0, 512) : undefined,
    locations,
  }
}

const CACHE_TTL_MS = 15000
const cache = new Map<string, { at: number; result: EndpointsResult }>()
const inflight = new Map<string, Promise<EndpointsResult>>()

async function runCollect(hostId: string): Promise<EndpointsResult> {
  const { stdout } = await execHostShell(hostId, COLLECT_CMD, { timeoutMs: 20000 })
  if (stdout.includes('__NOPY__')) {
    return {
      hostId,
      collectedAt: new Date().toISOString(),
      supported: false,
      sources: { nginx: 'unavailable', tailscale: 'unavailable', docker: 'unavailable', socket: 'unavailable' },
      endpoints: [],
    }
  }
  const data = JSON.parse(stdout)
  const endpoints = (Array.isArray(data?.endpoints) ? data.endpoints : [])
    .map((item: any, index: number) => normalizeEndpoint(item, `${index}`))
    .filter((item: EndpointItem | null): item is EndpointItem => !!item)
    .slice(0, 500)
  const rawSources = data?.sources && typeof data.sources === 'object' ? data.sources : {}
  const sources = Object.fromEntries(SOURCE_ORDER.map((key) => [key, normalizeSourceState(rawSources[key])])) as Record<
    EndpointSource,
    EndpointSourceState
  >
  return { hostId, collectedAt: new Date().toISOString(), supported: true, sources, endpoints }
}

export async function collectEndpoints(hostId: string): Promise<EndpointsResult> {
  const hit = cache.get(hostId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result
  const pending = inflight.get(hostId)
  if (pending) return pending
  const task = runCollect(hostId)
    .then((result) => {
      cache.set(hostId, { at: Date.now(), result })
      return result
    })
    .finally(() => inflight.delete(hostId))
  inflight.set(hostId, task)
  return task
}

export const __testables = { normalizeEndpoint, normalizeSourceState }
