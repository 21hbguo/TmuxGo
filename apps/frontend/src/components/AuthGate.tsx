'use client'

import { FormEvent, ReactNode, useEffect, useState } from 'react'
import { Button } from './Button'
import { changePassword, getAuthStatus, login, onAuthChange, refreshAuth } from '@/lib/auth'
import { useTranslation } from '@/i18n'

type GateState = 'loading' | 'login' | 'password' | 'error' | 'ready'
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [state, setState] = useState<GateState>('loading')
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    let active = true
    const unsubscribe = onAuthChange((status) => {
      if (!active || !status.enabled) return
      setState(status.authenticated ? status.passwordChangeRequired ? 'password' : 'ready' : 'login')
    })
    const initialize = async () => {
      try {
        const status = await getAuthStatus()
        if (!active) return
        if (!status.enabled) {
          setState('ready')
          return
        }
        if (status.authenticated) {
          setState(status.passwordChangeRequired ? 'password' : 'ready')
          return
        }
        if (await refreshAuth()) return
        setState('login')
      } catch (cause) {
        if (!active) return
        setError(cause instanceof Error ? cause.message : t('auth.unavailable'))
        setState('error')
      }
    }
    void initialize()
    return () => {
      active = false
      unsubscribe()
    }
  }, [t])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await login(username.trim(), password)
      setPassword('')
      setState(result.passwordChangeRequired ? 'password' : 'ready')
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : ''
      setError(code === 'INVALID_CREDENTIALS' ? t('auth.invalidCredentials') : cause instanceof Error ? cause.message : t('auth.unavailable'))
    } finally {
      setSubmitting(false)
    }
  }
  const submitPasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await changePassword(password, newPassword)
      setPassword('')
      setNewPassword('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('auth.unavailable'))
    } finally {
      setSubmitting(false)
    }
  }
  if (state === 'ready') return <>{children}</>
  if (state === 'error') {
    return <main className="flex min-h-screen items-center justify-center bg-bg-0 px-5 py-8 text-text-1"><div className="tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-7 sm:p-9"><div className="mb-8"><div className="font-mono text-xs uppercase tracking-[0.18em] text-accent">TMUXGO / GATEWAY</div><h1 className="mt-3 text-2xl font-semibold">{t('auth.title')}</h1></div><p className="text-sm text-text-2">{error || t('auth.unavailable')}</p><Button variant="primary" size="lg" className="mt-7 w-full" onClick={() => { setState('loading'); setError(''); window.location.reload() }}>{t('auth.retry')}</Button></div></main>
  }
  if (state === 'loading') return <main className="flex min-h-screen items-center justify-center bg-bg-0 px-5 text-text-2"><div className="font-mono text-xs uppercase tracking-[0.18em]">TMUXGO / GATEWAY</div></main>
  if (state === 'password') return <main className="flex min-h-screen items-center justify-center bg-bg-0 px-5 py-8 text-text-1"><div className="tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-7 sm:p-9"><div className="mb-8"><div className="font-mono text-xs uppercase tracking-[0.18em] text-danger">TMUXGO / SECURITY</div><h1 className="mt-3 text-2xl font-semibold">{t('auth.passwordChangeTitle')}</h1><p className="mt-2 text-sm text-text-2">{t('auth.passwordChangeRequired')}</p></div><form className="space-y-5" onSubmit={submitPasswordChange}><label className="block"><span className="mb-2 block text-sm text-text-2">{t('auth.currentPassword')}</span><input autoFocus autoComplete="current-password" type="password" className="tmuxgo-control h-11 w-full rounded-apple px-3 text-sm" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="block"><span className="mb-2 block text-sm text-text-2">{t('auth.newPassword')}</span><input autoComplete="new-password" type="password" minLength={8} className="tmuxgo-control h-11 w-full rounded-apple px-3 text-sm" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<Button type="submit" variant="primary" size="lg" className="w-full" disabled={submitting}>{submitting ? t('auth.passwordChanging') : t('auth.passwordChange')}</Button></form></div></main>
  return <main className="flex min-h-screen items-center justify-center bg-bg-0 px-5 py-8 text-text-1"><div className="tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-7 sm:p-9"><div className="mb-8"><div className="font-mono text-xs uppercase tracking-[0.18em] text-accent">TMUXGO / GATEWAY</div><h1 className="mt-3 text-2xl font-semibold">{t('auth.title')}</h1><p className="mt-2 text-sm text-text-2">{t('auth.subtitle')}</p></div><form className="space-y-5" onSubmit={submit}><label className="block"><span className="mb-2 block text-sm text-text-2">{t('auth.username')}</span><input autoFocus autoComplete="username" className="tmuxgo-control h-11 w-full rounded-apple px-3 text-sm" value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label className="block"><span className="mb-2 block text-sm text-text-2">{t('auth.password')}</span><input autoComplete="current-password" type="password" className="tmuxgo-control h-11 w-full rounded-apple px-3 text-sm" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<Button type="submit" variant="primary" size="lg" className="w-full" disabled={submitting}>{submitting ? t('auth.signingIn') : t('auth.submit')}</Button></form><p className="mt-6 border-t border-text-1/10 pt-4 text-xs text-text-3">{t('auth.required')}</p></div></main>
}
