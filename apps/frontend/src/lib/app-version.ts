export interface AppVersionInfo {
  name: string
  version: string
  buildId: string
}
export const APP_NAME = 'TmuxGo'
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
export const APP_BUILD_ID = import.meta.env.VITE_APP_BUILD_ID || APP_VERSION || 'dev'
export const APP_VERSION_URL = '/version.json'
export async function fetchAppVersion() {
  const response = await fetch(APP_VERSION_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<AppVersionInfo>
}
