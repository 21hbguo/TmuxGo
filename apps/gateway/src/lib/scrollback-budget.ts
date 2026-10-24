// 回看（scrollback）预算：gateway 侧两处口径的唯一真值源，改数字只能改这里。
//
//   层        常量                          行数/大小  粗估（80 列，1 字节/字符）
//   tmux      TMUX_HISTORY_LIMIT_LINES     20000 行   ≈ 1.6 MB/pane（服务端，pane 创建时固化）
//   gateway   MIRROR_SCROLLBACK_LINES      1000 行    ≈ 80 KB（headless 镜像，会话级一份）
//   gateway   MIRROR_RING_BYTES            256 KB     增量环，覆盖「断线几秒」的重连补发
//   浏览器    TERMINAL_SCROLLBACK_LINES    600 行     ≈ 1.4 MB/终端（xterm cell 含属性位，与上面不同单位）
//
// 三档递减是有意的：tmux 保留最久（跨 pane 搜索 / 会话归档要用），镜像只负责 attach 首屏，
// 浏览器只负责用户往上滚。镜像比 tmux 浅没关系（缺的历史走 capture-pane 回填），
// 但浏览器超过镜像就没意义——超出镜像的那段 attach 后补不回来，所以前后端有
// `TERMINAL_SCROLLBACK_LINES <= MIRROR_SCROLLBACK_LINES` 的断言（见 scrollback-budget.test.ts）。
//
// 前端那份常量在 apps/frontend/src/lib/scrollback-budget.ts：两个 app 构建目标不同，
// 没有可共享的包，数字与注释必须手动同步（一致性由上面的断言兜住）。
export const TMUX_HISTORY_LIMIT_LINES = 20000
export const MIRROR_SCROLLBACK_LINES = 1000
export const MIRROR_RING_BYTES = 256 * 1024
// 环的下限：再小就存不住一屏（80x24 的满屏重绘约 2KB，留一倍余量），环境变量调低时兜住
export const MIRROR_RING_MIN_BYTES = 4096

// 换算只用来说明量级（1 字符按 1 字节、十进制 MB 估），不参与任何运行时计算
export function estimateScrollbackMb(lines: number, cols = 80): number {
  return (lines * cols) / 1_000_000
}
