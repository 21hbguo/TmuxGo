import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { getAuthGeneration } from './auth.js'

export interface ShareLink {
  id: string
  hostId: string
  sessionName: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}
interface StoredShareLink extends ShareLink {
  tokenHash: string
  authGeneration: number
}
export interface ShareTicket {
  id: string
  hostId: string
  sessionName: string
  expiresAt: string
  authGeneration: number
}
interface ShareStore {
  version: 1
  links: StoredShareLink[]
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function getSharePath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'shares.json')
}
function publicLink(link: StoredShareLink): ShareLink {
  const { tokenHash:_tokenHash, authGeneration:_authGeneration, ...result }=link
  return result
}
export class ShareLinkStore {
  private filePath: string
  private links=new Map<string,StoredShareLink>()
  private tickets=new Map<string,ShareTicket & { ticketExpiresAt:number }>()
  private ready: Promise<void> | null=null
  constructor(filePath=getSharePath()) {
    this.filePath=filePath
  }
  private ensureReady() {
    if (!this.ready) this.ready=this.initialize()
    return this.ready
  }
  private async initialize() {
    let store:ShareStore={version:1,links:[]}
    try {
      const parsed=JSON.parse(await readFile(this.filePath,'utf8'))
      if (parsed?.version===1&&Array.isArray(parsed.links)) store=parsed
    } catch {}
    for (const link of store.links) {
      if (!link||typeof link.id!=='string'||typeof link.tokenHash!=='string'||typeof link.hostId!=='string'||typeof link.sessionName!=='string'||typeof link.createdAt!=='string'||typeof link.expiresAt!=='string'||typeof link.authGeneration!=='number') continue
      this.links.set(link.id,link)
    }
  }
  private async save() {
    const directory=path.dirname(this.filePath)
    await mkdir(directory,{recursive:true,mode:0o700})
    await chmod(directory,0o700)
    const temporary=`${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const store:ShareStore={version:1,links:Array.from(this.links.values()).sort((left,right) => right.createdAt.localeCompare(left.createdAt))}
    await writeFile(temporary,`${JSON.stringify(store)}\n`,{encoding:'utf8',mode:0o600})
    await chmod(temporary,0o600)
    await rename(temporary,this.filePath)
    await chmod(this.filePath,0o600)
  }
  private isActive(link: StoredShareLink) {
    return !link.revokedAt&&Date.parse(link.expiresAt)>Date.now()&&link.authGeneration===getAuthGeneration()
  }
  async create(hostId: string, sessionName: string, expiresInMinutes: number) {
    await this.ensureReady()
    const timestamp=new Date()
    const token=randomBytes(32).toString('base64url')
    const link:StoredShareLink={id:randomUUID(),tokenHash:hash(token),hostId,sessionName,createdAt:timestamp.toISOString(),expiresAt:new Date(timestamp.getTime()+expiresInMinutes*60000).toISOString(),revokedAt:null,authGeneration:getAuthGeneration()}
    this.links.set(link.id,link)
    await this.save()
    return { ...publicLink(link), token }
  }
  async list() {
    await this.ensureReady()
    return Array.from(this.links.values()).sort((left,right) => right.createdAt.localeCompare(left.createdAt)).map(publicLink)
  }
  async revoke(id: string) {
    await this.ensureReady()
    const link=this.links.get(id)
    if (!link) return false
    if (!link.revokedAt) {
      link.revokedAt=new Date().toISOString()
      await this.save()
    }
    return true
  }
  async exchange(token: string) {
    await this.ensureReady()
    const tokenHash=hash(token)
    const link=Array.from(this.links.values()).find((item) => item.tokenHash.length===tokenHash.length&&timingSafeEqual(Buffer.from(item.tokenHash),Buffer.from(tokenHash)))
    if (!link||!this.isActive(link)) return null
    const ticket=randomBytes(32).toString('base64url')
    const ticketExpiresAt=Math.min(Date.now()+60000,Date.parse(link.expiresAt))
    this.tickets.set(ticket,{id:link.id,hostId:link.hostId,sessionName:link.sessionName,expiresAt:link.expiresAt,authGeneration:link.authGeneration,ticketExpiresAt})
    return { ticket, expiresIn:Math.max(1,Math.ceil((ticketExpiresAt-Date.now())/1000)), link:publicLink(link) }
  }
  consumeTicket(ticket: string): ShareTicket | null {
    const entry=this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!entry||entry.ticketExpiresAt<=Date.now()||!this.isTicketActive(entry)) return null
    const { ticketExpiresAt:_ticketExpiresAt, ...result }=entry
    return result
  }
  isTicketActive(ticket: ShareTicket) {
    const link=this.links.get(ticket.id)
    return !!link&&this.isActive(link)&&link.hostId===ticket.hostId&&link.sessionName===ticket.sessionName&&link.authGeneration===ticket.authGeneration
  }
}
export const shareLinkStore=new ShareLinkStore()
