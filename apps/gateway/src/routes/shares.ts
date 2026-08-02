import type { FastifyInstance, FastifyReply } from 'fastify'
import { agentManager } from '../agent-manager.js'
import { appendAuditEvent } from '../lib/audit-log.js'
import { getHostById } from '../lib/hosts.js'
import { shareLinkStore } from '../lib/share-links.js'
import { assertSessionAllowed } from '../lib/tmux-policy.js'
import { parseSessionRef } from '../lib/tmux-target.js'

function sendError(reply: FastifyReply, message: string, code='INVALID_REQUEST', status=400) {
  return reply.code(status).send({ message,code })
}
async function resolveScope(hostIdValue: unknown, sessionNameValue: unknown) {
  const hostId=typeof hostIdValue==='string'&&hostIdValue.trim()?hostIdValue.trim():'local'
  const raw=typeof sessionNameValue==='string'?sessionNameValue.trim():''
  if (!raw) throw new Error('sessionName is required')
  if (hostId==='local'&&!raw.startsWith('session-')) {
    assertSessionAllowed(raw)
    return { hostId,sessionName:raw }
  }
  if (hostId!=='local'&&!await getHostById(hostId)&&!agentManager.getAgent(hostId)) throw new Error('Host not found')
  const parsed=parseSessionRef(hostId,raw)
  return { hostId:parsed.hostId,sessionName:parsed.sessionName }
}
export async function shareRoutes(fastify: FastifyInstance) {
  fastify.get('/shares', async () => ({ links:await shareLinkStore.list() }))
  fastify.post('/shares', async (request, reply) => {
    try {
      const body=request.body as { hostId?: unknown; sessionName?: unknown; expiresInMinutes?: unknown } | undefined
      const scope=await resolveScope(body?.hostId,body?.sessionName)
      const expiresInMinutes=Number(body?.expiresInMinutes)
      if (!Number.isInteger(expiresInMinutes)||expiresInMinutes<5||expiresInMinutes>10080) return sendError(reply,'expiresInMinutes must be between 5 and 10080','INVALID_EXPIRY')
      return await shareLinkStore.create(scope.hostId,scope.sessionName,expiresInMinutes)
    } catch (error) {
      return sendError(reply,error instanceof Error?error.message:String(error),error instanceof Error&&error.message==='Host not found'?'HOST_NOT_FOUND':'INVALID_REQUEST',error instanceof Error&&error.message==='Host not found'?404:400)
    }
  })
  fastify.delete('/shares/:shareId', async (request, reply) => {
    const { shareId }=request.params as { shareId?:string }
    if (!shareId||!await shareLinkStore.revoke(shareId)) return sendError(reply,'Share link not found','SHARE_NOT_FOUND',404)
    return { ok:true }
  })
  fastify.post('/shares/exchange', async (request, reply) => {
    const token=(request.body as { token?:unknown } | undefined)?.token
    if (typeof token!=='string'||token.length<32) return sendError(reply,'Invalid share token','INVALID_SHARE_TOKEN',401)
    const result=await shareLinkStore.exchange(token)
    if (!result) return sendError(reply,'Share link is unavailable','SHARE_UNAVAILABLE',401)
    await appendAuditEvent({ id:`share-${Date.now().toString(36)}`,timestamp:new Date().toISOString(),user:'share',action:'share.use',target:result.link.id,result:'success',method:'POST',statusCode:200,hostId:result.link.hostId })
    return { ticket:result.ticket,expiresIn:result.expiresIn,hostId:result.link.hostId,sessionName:result.link.sessionName,expiresAt:result.link.expiresAt }
  })
}
