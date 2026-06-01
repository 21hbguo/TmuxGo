import { useState, useCallback } from 'react'
import { useTranslation } from '@/i18n'
import { PromptDialog } from '@/components/PromptDialog'

interface PromptState {
  title: string
  defaultValue: string
  resolve: (value: string | null) => void
}

export function usePrompt() {
  const [state, setState] = useState<PromptState | null>(null)
  const { t } = useTranslation()

  const prompt = useCallback((title: string, defaultValue = '') => {
    return new Promise<string | null>((resolve) => {
      setState({ title, defaultValue, resolve })
    })
  }, [])

  const handleConfirm = useCallback((value: string) => {
    state?.resolve(value)
    setState(null)
  }, [state])

  const handleCancel = useCallback(() => {
    state?.resolve(null)
    setState(null)
  }, [state])

  const PromptElement = state ? (
    <PromptDialog
      open
      title={state.title}
      defaultValue={state.defaultValue}
      confirmLabel={t('common.confirm')}
      cancelLabel={t('common.cancel')}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null

  return { prompt, PromptElement }
}
