function safeText(value, fallback, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback
}
function safeStatus(value) {
  return ['blocked', 'done', 'permission_required', 'needs_input', 'failed', 'ended', 'disconnected'].includes(value) ? value : 'blocked'
}
function safeUrl(value) {
  try {
    const parsed = new URL(typeof value === 'string' ? value : '/', self.location.origin)
    if (parsed.origin !== self.location.origin) return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}
self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch {}
  const safe = {
    type: 'agent_notification',
    id: safeText(payload.id, `agent-notification-${Date.now()}`, 256),
    hostId: safeText(payload.hostId, 'local', 128),
    sessionName: safeText(payload.sessionName, '', 128),
    paneId: safeText(payload.paneId, '', 256),
    agent: safeText(payload.agent, 'agent', 64),
    status: safeStatus(payload.status),
    message: safeText(payload.message, 'Agent notification', 240),
    timestamp: safeText(payload.timestamp, new Date().toISOString(), 64),
    url: safeUrl(payload.url),
  }
  event.waitUntil(self.registration.showNotification(safe.agent, { body: safe.message, tag: safe.id, data: safe, renotify: true }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const payload = event.notification.data || {}
  const url = typeof payload.url === 'string' ? payload.url : '/'
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const target = clients.find((client) => 'focus' in client)
    if (target) {
      target.postMessage({ type: 'tmuxgo-agent-notification-click', ...payload })
      await target.focus()
      return
    }
    await self.clients.openWindow(url)
  })())
})
