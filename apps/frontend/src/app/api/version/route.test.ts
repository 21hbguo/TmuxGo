import { afterEach, describe, expect, it } from 'vitest'
import { GET } from './route'
const originalVersion=process.env.NEXT_PUBLIC_APP_VERSION
const originalBuildId=process.env.NEXT_PUBLIC_APP_BUILD_ID
describe('app/api/version', () => {
  afterEach(() => {
    if (originalVersion===undefined) delete process.env.NEXT_PUBLIC_APP_VERSION
    else process.env.NEXT_PUBLIC_APP_VERSION=originalVersion
    if (originalBuildId===undefined) delete process.env.NEXT_PUBLIC_APP_BUILD_ID
    else process.env.NEXT_PUBLIC_APP_BUILD_ID=originalBuildId
  })
  it('returns configured version metadata with no-store caching', async () => {
    process.env.NEXT_PUBLIC_APP_VERSION='1.2.3'
    process.env.NEXT_PUBLIC_APP_BUILD_ID='build-abc'
    const response=await GET()
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    await expect(response.json()).resolves.toEqual({
      name: 'TmuxGo',
      version: '1.2.3',
      buildId: 'build-abc',
    })
  })
  it('falls back to dev metadata when env is missing', async () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION
    delete process.env.NEXT_PUBLIC_APP_BUILD_ID
    const response=await GET()
    await expect(response.json()).resolves.toEqual({
      name: 'TmuxGo',
      version: 'dev',
      buildId: 'dev',
    })
  })
})
