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
      setState(status.authenticated ? (status.passwordChangeRequired ? 'password' : 'ready') : 'login')
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
  useEffect(() => {
    if (state !== 'error') return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const status = await getAuthStatus()
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
        } catch {}
      })()
    }, 5000)
    return () => clearInterval(timer)
  }, [state])
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
      setError(
        code === 'INVALID_CREDENTIALS'
          ? t('auth.invalidCredentials')
          : cause instanceof Error
            ? cause.message
            : t('auth.unavailable'),
      )
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

  /**
   * 认证页外壳：≥1024px 双栏（左品牌 / 右表单），窄屏单列。
   * 只做版式与装饰，鉴权状态机仍在 AuthGate 内，避免把安全逻辑搬进展示组件。
   */
  function AuthShell({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'danger' }) {
    const { t } = useTranslation()
    return (
      <main className="tmuxgo-auth text-text-1">
        <section className="tmuxgo-auth__brand" aria-hidden="true">
          <div className="tmuxgo-auth__brand-top">
            <img src="/app-icon.svg" alt="" className="h-8 w-8" />
            <span className="tmuxgo-auth__brand-name">TmuxGo</span>
            <span className={`tmuxgo-micro ${tone === 'danger' ? 'text-danger' : 'text-accent-text'}`}>
              {tone === 'danger' ? 'SECURITY' : 'GATEWAY'}
            </span>
          </div>
          <div className="tmuxgo-auth__brand-body">
            <h2 className="tmuxgo-auth__headline">
              {t('auth.brandHeadline1')}
              <br />
              {t('auth.brandHeadline2')}
            </h2>
            <p className="tmuxgo-auth__sub">{t('auth.brandSub')}</p>
            <div className="tmuxgo-auth__points">
              <span className="tmuxgo-auth__point">{t('auth.brandPoint1')}</span>
              <span className="tmuxgo-auth__point">{t('auth.brandPoint2')}</span>
              <span className="tmuxgo-auth__point">{t('auth.brandPoint3')}</span>
            </div>
          </div>
          <div className="tmuxgo-auth__brand-foot">
            <span>Terminal · Files · Editor · Git</span>
            <span className="text-text-3/40">/</span>
            <span>PWA</span>
          </div>
        </section>
        <div className="tmuxgo-auth__panel">
          <div className="tmuxgo-auth__form">{children}</div>
        </div>
      </main>
    )
  }

  if (state === 'ready') return <>{children}</>
  if (state === 'error') {
    return (
      <AuthShell>
        <div className="tmuxgo-micro text-accent-text">TMUXGO / GATEWAY</div>
        <h1 className="mt-3">{t('auth.title')}</h1>
        <p className="mt-3 text-meta leading-relaxed text-text-2">{error || t('auth.unavailable')}</p>
        <Button
          variant="primary"
          size="lg"
          className="mt-7 w-full"
          onClick={() => {
            setState('loading')
            setError('')
            window.location.reload()
          }}
        >
          {t('auth.retry')}
        </Button>
      </AuthShell>
    )
  }
  if (state === 'loading') {
    return (
      <AuthShell>
        <div className="tmuxgo-micro">TMUXGO / GATEWAY</div>
        <p className="mt-3 text-meta text-text-3">{t('auth.checking')}</p>
      </AuthShell>
    )
  }
  if (state === 'password')
    return (
      <AuthShell tone="danger">
        <div className="tmuxgo-micro text-danger">TMUXGO / SECURITY</div>
        <h1 className="mt-3">{t('auth.passwordChangeTitle')}</h1>
        <p className="mt-2 text-meta leading-relaxed text-text-3">{t('auth.passwordChangeRequired')}</p>
        <form className="mt-7 space-y-4" onSubmit={submitPasswordChange}>
          <label className="block">
            <span className="mb-1.5 block text-caption uppercase tracking-[0.12em] text-text-3">
              {t('auth.currentPassword')}
            </span>
            <input
              autoFocus
              autoComplete="current-password"
              type="password"
              className="tmuxgo-control w-full px-3 text-sm"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-caption uppercase tracking-[0.12em] text-text-3">
              {t('auth.newPassword')}
            </span>
            <input
              autoComplete="new-password"
              type="password"
              minLength={8}
              className="tmuxgo-control w-full px-3 text-sm"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={submitting}>
            {submitting ? t('auth.passwordChanging') : t('auth.passwordChange')}
          </Button>
        </form>
      </AuthShell>
    )
  return (
    <AuthShell>
      <div className="tmuxgo-micro text-accent-text">TMUXGO / GATEWAY</div>
      <h1 className="mt-3">{t('auth.title')}</h1>
      <p className="mt-2 text-meta leading-relaxed text-text-3">{t('auth.subtitle')}</p>
      <form className="mt-7 space-y-4" onSubmit={submit}>
        <label className="block">
          <span className="mb-1.5 block text-caption uppercase tracking-[0.12em] text-text-3">
            {t('auth.username')}
          </span>
          <input
            autoFocus
            autoComplete="username"
            className="tmuxgo-control w-full px-3 text-sm"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-caption uppercase tracking-[0.12em] text-text-3">
            {t('auth.password')}
          </span>
          <input
            autoComplete="current-password"
            type="password"
            className="tmuxgo-control w-full px-3 text-sm"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="text-meta text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" disabled={submitting}>
          {submitting ? t('auth.signingIn') : t('auth.submit')}
        </Button>
      </form>
      <div className="tmuxgo-auth__rule">{t('auth.secure')}</div>
      <p className="text-[11px] leading-relaxed text-text-3">{t('auth.required')}</p>
    </AuthShell>
  )
}
