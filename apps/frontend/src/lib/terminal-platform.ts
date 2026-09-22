export function isApplePlatform() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /Mac|iPhone|iPad|iPod/.test(platform)
}
export function isPasteShortcut(e: KeyboardEvent) {
  if (e.altKey || e.key.toLowerCase() !== 'v') return false
  if (e.ctrlKey && !e.metaKey) return true
  if (e.metaKey && !e.ctrlKey && isApplePlatform()) return true
  return false
}
// isComposing 与 keyCode/which 229、key='Process' 需并列判定：各浏览器/输入法
// 上报不一致——有的只置 isComposing，Safari/旧 Chromium/部分安卓 IME 只在组字期
// 把 keyCode 打成 229 而不置 isComposing，漏判会把选词 Enter 当提交
export function isImeKeyEvent(e: KeyboardEvent) {
  return e.isComposing || e.key === 'Process' || e.keyCode === 229 || e.which === 229
}
