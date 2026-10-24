// 浏览器侧回看行数。与 gateway 的两处口径对照见 apps/gateway/src/lib/scrollback-budget.ts
// （两个 app 没有可共享的包，数字与注释手动同步，一致性由 gateway 侧单测断言兜住）。
//
//   层        常量                          行数   粗估
//   tmux      TMUX_HISTORY_LIMIT_LINES     20000  ≈ 1.6 MB/pane（80 列，服务端）
//   gateway   MIRROR_SCROLLBACK_LINES      1000   ≈ 80 KB（会话级镜像）
//   浏览器    TERMINAL_SCROLLBACK_LINES    600    ≈ 1.4 MB/终端（142 列 × 600 × 16 字节/cell）
//
// 为什么浏览器比镜像浅还要单独留一档：xterm 的 scrollback 是每个打开的终端各一份，
// 每 cell 带属性位（约 16 字节），移动端多窗格场景内存按终端数线性增长；镜像是服务端
// 一会话一份。抬到 1000 行约 +0.9 MB/终端——没有真机内存数据前保持 600（可逆：改这里的
// 数字即可，无其他引用点）。
export const TERMINAL_SCROLLBACK_LINES = 600

// cell 内存估算：仅用于文档与断言量级，不参与运行时
export function estimateTerminalScrollbackMb(lines: number, cols: number, bytesPerCell = 16): number {
  return (lines * cols * bytesPerCell) / 1_000_000
}
