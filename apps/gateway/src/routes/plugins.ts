import { createReadStream } from 'fs'
import path from 'path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { pluginManager } from '../lib/plugin-manager.js'
import { pluginInstallBodySchema, pluginLinkBodySchema } from '../lib/request-validation.js'

function sendError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const status = message.includes('not found') || message.includes('Not found') ? 404 : message.includes('already') || message.includes('linked from') ? 409 : 400
  return reply.code(status).send({ message })
}
function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.html') return 'text/html; charset=utf-8'
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.woff2') return 'font/woff2'
  return 'application/octet-stream'
}

export async function pluginRoutes(fastify: FastifyInstance) {
  fastify.get('/plugins/runtime.js', async (_request, reply) => {
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=300').send(`(()=>{const parts=location.pathname.split('/');const pluginId=decodeURIComponent(parts[parts.indexOf('plugins')+1]||'');const viewId=new URLSearchParams(location.search).get('viewId')||'';let seq=0;const pending=new Map();function request(method,params){const id=String(++seq);parent.postMessage({source:'tmuxgo-plugin',type:'request',id,pluginId,viewId,method,params:params||{}},'*');return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}addEventListener('message',event=>{const message=event.data;if(event.source!==parent||!message||message.source!=='tmuxgo-host'||message.pluginId!==pluginId)return;if(message.type==='response'){const task=pending.get(message.id);if(!task)return;pending.delete(message.id);if(message.ok)task.resolve(message.result);else task.reject(new Error(message.error||'Plugin request failed'))}if(message.type==='context')dispatchEvent(new CustomEvent('tmuxgo:context',{detail:message.context}))});window.tmuxgo={context:{get:()=>request('context.get')},storage:{get:key=>request('storage.get',{key}),set:(key,value)=>request('storage.set',{key,value}),delete:key=>request('storage.delete',{key}),list:()=>request('storage.list')},actions:{invoke:(actionId,context)=>request('action.invoke',{actionId,context})},ui:{notify:(message,level)=>request('ui.notify',{message,level})}};parent.postMessage({source:'tmuxgo-plugin',type:'ready',pluginId,viewId},'*')})()`)
  })
  fastify.get('/plugins', async () => ({ plugins: await pluginManager.listPlugins() }))
  fastify.post('/plugins/link', async (request, reply) => {
    try {
      const body = pluginLinkBodySchema.parse(request.body)
      return await pluginManager.link(body.path)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.patch('/plugins/:pluginId/enabled', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      const body = request.body as { enabled?: boolean }
      if (typeof body?.enabled !== 'boolean') throw new Error('enabled must be boolean')
      return await pluginManager.setEnabled(pluginId, body.enabled)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.delete('/plugins/:pluginId', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      const { keepData } = request.query as { keepData?: string }
      return await pluginManager.uninstall(pluginId, keepData === 'true')
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/plugins/:pluginId/actions/:actionId/invoke', async (request, reply) => {
    try {
      const { pluginId, actionId } = request.params as { pluginId: string; actionId: string }
      const body = request.body as { context?: unknown } | undefined
      return await pluginManager.invokeAction(pluginId, actionId, body?.context)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.get('/plugins/logs', async (request) => {
    const { pluginId } = request.query as { pluginId?: string }
    return { logs: await pluginManager.listLogs(pluginId) }
  })
  fastify.get('/plugins/:pluginId/storage', async (request, reply) => {
    try {
      const { pluginId } = request.params as { pluginId: string }
      return { keys: await pluginManager.listStorage(pluginId) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.get('/plugins/:pluginId/storage/:key', async (request, reply) => {
    try {
      const { pluginId, key } = request.params as { pluginId: string; key: string }
      const value = await pluginManager.getStorage(pluginId, key)
      if (value === undefined) return reply.code(404).send({ message: 'Plugin storage key not found' })
      return { value }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.put('/plugins/:pluginId/storage/:key', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    try {
      const { pluginId, key } = request.params as { pluginId: string; key: string }
      const body = request.body as { value?: unknown }
      return await pluginManager.setStorage(pluginId, key, body?.value)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.delete('/plugins/:pluginId/storage/:key', async (request, reply) => {
    try {
      const { pluginId, key } = request.params as { pluginId: string; key: string }
      return await pluginManager.deleteStorage(pluginId, key)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.get('/plugins/:pluginId/assets/*', async (request, reply) => {
    try {
      const params = request.params as { pluginId: string; '*': string }
      const asset = await pluginManager.resolveAsset(params.pluginId, params['*'])
      reply.header('cache-control', 'no-store')
      reply.header('x-content-type-options', 'nosniff')
      reply.type(contentType(asset.path))
      if (path.extname(asset.path).toLowerCase() === '.html') reply.header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
      return reply.send(createReadStream(asset.path))
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/plugins/github/preview', async (request, reply) => {
    try {
      const body = request.body as { source?: string; ref?: string }
      if (!body?.source) throw new Error('GitHub source is required')
      return await pluginManager.previewGit(body.source, body.ref)
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/plugins/github/install', async (request, reply) => {
    try {
      const body = pluginInstallBodySchema.parse(request.body)
      return await pluginManager.installGit(body.source, body.resolvedCommit, body.ref)
    } catch (error) {
      return sendError(reply, error)
    }
  })
}
