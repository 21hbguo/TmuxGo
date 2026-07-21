import type { SessionTemplate } from '@/types'

export function getTemplateSessionName(template: SessionTemplate) {
  return template.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
}
