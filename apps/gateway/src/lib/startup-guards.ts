import { isLoopbackHost } from './security.js'

export type ListenGuardInput = {
  host: string
  authEnabled: boolean
  passwordChangeRequired: boolean
  insecureModeAllowed: boolean
}

// 非 loopback + 默认密码/未开认证一律拒绝启动：宁可起不来，也不让默认密码或无认证的
// 控制面直连公网。两条检查的顺序有意义——默认密码优先，提示语要求先在 localhost 改密码，
// 否则用户按"配认证"的提示走会绕过改密这一步。
export function assertListenSafety({
  host,
  authEnabled,
  passwordChangeRequired,
  insecureModeAllowed,
}: ListenGuardInput) {
  if (isLoopbackHost(host)) return
  if (passwordChangeRequired)
    throw new Error(
      `Refusing to expose a Gateway with the default password on ${host}; change the password while listening on localhost first`,
    )
  if (!authEnabled && !insecureModeAllowed)
    throw new Error(
      `Refusing to expose an unauthenticated Gateway on ${host}; configure authentication or set TMUXGO_ALLOW_INSECURE=1 for an intentional insecure deployment`,
    )
}
