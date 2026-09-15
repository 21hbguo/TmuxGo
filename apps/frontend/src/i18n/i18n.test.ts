import { describe, expect, it } from 'vitest'
import { zh } from './zh'
import { en } from './en'
describe('i18n key consistency', () => {
  it('zh and en expose the same key set', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    const missingInEn = zhKeys.filter((key) => !(key in en))
    const missingInZh = enKeys.filter((key) => !(key in zh))
    expect(missingInEn).toEqual([])
    expect(missingInZh).toEqual([])
  })
  it('all values are non-empty strings', () => {
    for (const [key, value] of Object.entries(zh)) expect(value, `zh.${key}`).toBeTruthy()
    for (const [key, value] of Object.entries(en)) expect(value, `en.${key}`).toBeTruthy()
  })
  it('interpolation placeholders match between locales', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(zh)) {
      expect(placeholders(en[key as keyof typeof en] ?? ''), `en.${key}`).toEqual(
        placeholders(zh[key as keyof typeof zh] ?? ''),
      )
    }
  })
})
