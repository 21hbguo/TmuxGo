# 桌面视图工具栏移动端修复

目标文件：`apps/frontend/src/components/DesktopView.tsx`（必要时少量碰 `globals.css`、`DesktopWindow.tsx`、i18n en/zh）。只 stage 本次文件，用户 WIP 不许卷入。

## 问题根因（已确认）

- header `flex h-11 gap-2 px-3`，移动端 picker(~64px)+最多12个 icon-sm(28px) ≈ 570px > 375px 屏宽，section `overflow-hidden` → 右侧 全屏/最小化/窗口化/关闭 被裁掉点不到
- 移动端 overlay 本就 `fixed inset-0`，`view='full'` 无视觉变化 = 死按钮；`'window'` 触发 `DesktopWindow` MIN_W=420 > 屏宽，浮窗溢出
- display 下拉行内 play/stop 按钮 `opacity-0 group-hover:opacity-100`，触屏无 hover
- 全部 `title=` 原生 tooltip OS 延迟 ~1.5s（PC 上也嫌慢）；picker 弹层只有 `onMouseLeave` 关闭，触屏点外部不收起

## 要求

### 1. 移动端工具栏收敛
`isMobileLayout` 时把低频按钮收进溢出菜单（FiMoreHorizontal / FiMoreVertical 图标，复用现有 picker 的 `tmuxgo-glass absolute` 弹层模式）：
- 移动端保留可见：display picker、connect/disconnect、mobileKeyboard、paste、全屏、close
- 进菜单：viewOnly、sendCad、setupCheck（仅未连接时出现）、tuning、stats、minimize
- 菜单项渲染为 `icon + label` 的行（label 用对应 i18n 文案），点击执行原动作并关菜单
- PC 端（非 isMobileLayout）布局完全不变

### 2. 全屏按钮语义修正（用户实测：PC 端也用不了）
根因：桌面初始即 `view:'full'`，FiMaximize2→`onViewChange('full')` 是 no-op，且该按钮语义是 app 内铺满而非浏览器全屏。

改为真·全屏切换：
- `document.fullscreenElement` 状态驱动：未全屏→`requestFullscreen`，已全屏→`exitFullscreen`；监听 `fullscreenchange` 更新图标/高亮态
- 目标元素：DesktopView 根 section（ref 挂上去）——windowed 模式下也只全屏桌面本体，不拖外层 overlay
- 移动端同按钮走 `enterLandscapeFullscreen`（全屏+landscape 锁定，iOS 静默失败可接受）
- 窗口化（FiMinimize2）保留 full↔window 切换职责：view==='window' 时点击回 'full'，否则进 'window'；移动端隐藏（MIN_W=420>屏宽，修好前不给入口）
- 全屏中进入/退出不 reset RFB 连接

### 3. hover 门槛消除
- display 下拉行 play/stop：`opacity-0 group-hover:opacity-100` 追加 `[@media(hover:none)]:opacity-100`（tailwind 任意媒体查询变体），触屏常显
- picker 弹层补 click-outside 关闭：包一层 fixed inset-0 backdrop（`z-10`，弹层 `z-20`）onClick 关弹层，或复用仓内现有 popover 外部点击模式（自己找，没有就用 backdrop div）

### 4. 快速 tooltip
header 内所有 `title=` 按钮改自定义快速提示：给按钮加 `data-tip={t(...)}`，globals.css 加一段 `.tmuxgo-tip` 纯 CSS 实现（`::after` 读 `attr(data-tip)`，`@media (hover:hover)` 内 :hover 显示，delay ~200ms，样式贴合现有 glass 风格，z-index 足够）。`title=` 属性删掉防双 tooltip，`aria-label` 保留。
- 范围：仅 DesktopView header/弹层内按钮，别全仓替换
- 若实现太脏可退而求其次：只删 title（保留 aria-label）并在 PR 描述里说明

## 约束

- i18n 走 key，新增菜单/tooltip 文案 en+zh 都补
- 注释照旧给非显而易见逻辑（如 touch hover 媒体查询）
- 验证：vitest 相关用例（DesktopView.test.tsx 若断言了按钮 title 需同步改）、tsc、eslint、prettier、`pnpm --filter frontend build`
- 完成后回 DONE，列出改动文件与验证结果
