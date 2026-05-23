'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { usePreferences, type Language } from '@/hooks/usePreferences'
import { zh } from './zh'
import { en } from './en'

type TranslationKey = keyof typeof zh

const translations: Record<Language, Record<string, string>> = { zh, en }

interface I18nContextValue {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
  language: Language
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const { preferences } = usePreferences()
  const lang = preferences.language

  const value = useMemo<I18nContextValue>(() => ({
    t: (key, params) => {
      let text = translations[lang]?.[key] ?? translations.zh[key] ?? key
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          text = text.replace(`{${k}}`, String(v))
        })
      }
      return text
    },
    language: lang,
  }), [lang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useTranslation() {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    return { t: (key: string) => key, language: 'zh' as Language }
  }
  return ctx
}
