# TmuxGo UI 美化 PR 清单 · 7.0 → 9.0

> 目标分：**9.0 / 10**
> 当前分：**7.0 / 10**
> 起点：动效/插画/空状态/大屏布局短板集中暴露
> 范围：仅前端（`apps/frontend`），不动后端、不动设计 token

## 总览

| # | 标题 | 提升 | 工时 | 类型 | 风险 |
|---|------|------|------|------|------|
| PR-1 | 全局微动效（transition + duration） | **+0.4** | 0.5h | 工程 | 无 |
| PR-2 | 自定义 app-icon + 启动图标家族 | +0.6 | 2h | 设计 | 无 |
| PR-3 | 移动底栏 spring 进入动效 | +0.3 | 1h | 工程 | 中 |
| PR-4 | 主题切换 UI（深浅/Catppuccin 一键换） | +0.2 | 1h | 工程 | 无 |
| PR-5 | Skeleton loading（会话/文件/Git） | +0.4 | 3h | 工程 | 低 |
| PR-6 | 大屏专属布局（≥1440） | +0.3 | 2h | 设计 | 低 |
| PR-7 | 空状态 SVG 插画包（5 场景） | +0.6 | 4h | 设计 | 无 |
| PR-8 | EditorWorkbench 拆分 + 分屏微动效 | +0.4 | 4h | 工程 | 中 |

**累计 +3.2 → 落地 7.0 → 10.2**，按 80% 折算 = **9.0** ✓

---

## PR 排序依据（ROI）

- **PR-1 > PR-4 > PR-3**：单点改动、零设计风险，先收工
- **PR-2 + PR-7**：设计资产，复用率高，是品牌感的核心
- **PR-5**：用户视觉停留最久的位置（列表），做好收益大
- **PR-6 + PR-8**：影响最低，影响面最窄，放最后

---

## PR-1 · 全局微动效

**目标**：所有交互元素（按钮、面板、抽屉、toast）有 150–200ms 颜色/位移过渡

**实现**：

```tsx
// tsconfig 引入常量
const TRANSITION = 'transition-all duration-150 ease-out'
const TRANSITION_SLOW = 'transition-all duration-200 ease-out'
```

- `components/ActivityBar.tsx`：图标按钮加 `transition-colors`
- `components/ConsoleLayout.tsx`：drawer/mobile sheet 加 `transition-transform duration-300`
- `components/ToastViewport.tsx`：toast 弹入用 spring 缓动
- `globals.css`：定义 `--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)`

**验收**：
- [ ] 点击 ActivityBar 图标无闪烁
- [ ] Toast 弹出/消失有 200ms 淡入淡出
- [ ] `prefers-reduced-motion` 下禁用所有动画

**风险**：无；纯 CSS 变更

**回滚**：移除 utility class 即可

---

## PR-2 · 自定义 app-icon + 启动图标家族

**目标**：建立品牌资产，提升品牌感 +0.6

**现状**：仅有 `public/app-icon.svg`，无 favicon、splash、apple-touch 多尺寸

**新增**：

```
public/
├── app-icon.svg          （主图标，重设计：终端窗口 + 抽象"G"）
├── favicon.ico
├── favicon-32x32.png
├── apple-touch-icon.png  （已有，180x180）
├── splash-dark.png       （iOS PWA 启动）
├── splash-light.png
└── og-image.png          （1200×630 社交分享）
```

**设计要点**：
- 主形：圆角矩形（radius 22%）模仿 macOS app 图标
- 图标元素：tmux 三窗格 + G 字母隐喻 Go
- 色：默认用主题 accent `rgb(10, 132, 255)`，随主题切换

**验收**：
- [ ] iOS PWA 添加到桌面显示新图标
- [ ] 浏览器 tab 正确显示 32×32 favicon
- [ ] 暗/亮主题下色彩对比均通过 WCAG AA

**风险**：无；不影响功能

---

## PR-3 · 移动底栏 spring 进入动效

**目标**：提升移动端交互质感 +0.3

**实现**（`components/ConsoleLayout.tsx` 移动 dock）：

```tsx
// 用 framer-motion 或自实现 spring
const dockVariants = {
  hidden: { y: 60, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 280, damping: 24 } }
}
<motion.div variants={dockVariants} initial="hidden" animate="visible">
  <MobileNav />
</motion.div>
```

**注意**：
- 不引入 framer-motion 依赖时，手写 RAF 实现 spring
- 会话条切换也加 200ms slide
- 键盘弹出/关闭时 dock 有 150ms 平滑切换

**验收**：
- [ ] 页面进入时 dock 从下方 60px 滑入
- [ ] 切会话时 session strip 有滑动高亮
- [ ] 键盘弹出无抖动

**风险**：中；引入新依赖或自实现需测试低端机性能

---

## PR-4 · 主题切换 UI（深浅/Catppuccin 一键换）

**目标**：暴露已有的 5 套主题，让用户能用上 +0.2

**实现**：

1. `stores/useConsoleStore.ts` 新增 `theme: string`、`setTheme()`
2. `components/Settings.tsx` 新增「主题」分组，6 个色块（深/亮/高对比/Dracula/Nord/Catppuccin）
3. `app/globals.css` 已有 `[data-theme]` 选择器，只需 root 上挂 `document.documentElement.dataset.theme`

```tsx
<button onClick={() => {
  document.documentElement.dataset.theme = 'catppuccin'
  useConsoleStore.getState().setTheme('catppuccin')
}} />
```

**验收**：
- [ ] 6 套主题全部可切换且无闪烁
- [ ] 切换平滑过渡（PR-1 的 transition 配合）
- [ ] 偏好持久化到 localStorage

**风险**：无；主题 token 已就位

---

## PR-5 · Skeleton loading（会话/文件/Git）

**目标**：消灭加载态空白时段 +0.4

**新增组件**：

```
components/
├── Skeleton.tsx           （基础组件，shimmer 动画）
├── SessionSkeleton.tsx    （列表行占位）
├── FileSkeleton.tsx       （文件树占位）
└── GitSkeleton.tsx        （git 状态行占位）
```

**样式**：渐变扫光 `bg-gradient-to-r from-bg-2 via-bg-1 to-bg-2` + `bg-[length:200%_100%]` + `animate-shimmer`

**接入点**：
- `Sidebar.tsx` / `SessionPanel.tsx`：`isPending` 时显示
- `FilePanel.tsx`：`isPending` 时显示
- `GitPanel.tsx`：`isPending` 时显示

**验收**：
- [ ] 三个面板初次加载均有骨架屏，不出现空白
- [ ] 真实数据到位后无闪烁切换（用 `opacity` 而非 `display`）

**风险**：低；纯展示组件

---

## PR-6 · 大屏专属布局（≥1440）

**目标**：消除大屏留白空洞 +0.3

**现状**：`minWorkspaceWidth = 560`，2K/4K 屏两侧大量浪费

**改动**（`components/DesktopWorkbench.tsx`）：

```tsx
// xl breakpoint
const minWorkspaceWidth = viewportWidth >= 1440 ? 720 : viewportWidth >= 1180 ? 560 : 420
```

**新增 xl 区（≥1440）**：
- 右侧 280px "快速创建"面板（与左 SessionPanel 镜像对称）
- 顶部 TopBar 加状态指示（连接数 / CPU 占用）

**验收**：
- [ ] 1920×1080 屏中间工作区 ≥ 720px
- [ ] xl 屏右侧面板可隐藏
- [ ] 平板横屏（1180–1440）保持原有布局

**风险**：低；纯布局调整

---

## PR-7 · 空状态 SVG 插画包

**目标**：告别 `⊞` 字 + 两行文案 +0.6

**新增**：

```
assets/
├── empty-sessions.svg     （会话为空：终端窗格 + "新建会话" 引导）
├── empty-files.svg        （文件为空：文件夹轮廓）
├── empty-git.svg          （git 无变更：分支剪影）
├── empty-agent.svg        （agent 未连接：波纹信号）
└── empty-offline.svg      （离线：虚线连接）
```

**每个插画**：
- 220×160 viewBox，单色 + accent 高亮
- CSS variable 控制颜色，自动适配主题
- 配 6 行文案：「操作动词 + 1 句引导 + 1 个 action button」

**接入**：
- `components/Sidebar.tsx`、`FilePanel.tsx`、`GitPanel.tsx`、`AgentStatusBadge.tsx` 的空状态分支

**验收**：
- [ ] 5 个空状态全部有插画
- [ ] 切换深/亮/3 套主题，插画颜色自动适配
- [ ] 移动端 sheet 内插画比例正确

**风险**：无；静态资源

**依赖**：可选，把图片用 [svgr](https://react-svgr.com/) 转 React 组件便于着色

---

## PR-8 · EditorWorkbench 拆分 + 分屏微动效

**目标**：降组件复杂度 + 加分屏动效 +0.4

**现状**：单一文件 673 行，`<EditorWorkbench>` 内部拖拽逻辑臃肿

**拆分**：

```
components/editor/
├── EditorTabs.tsx          （tab 栏）
├── EditorSplit.tsx         （split 容器）
├── EditorPane.tsx          （单窗格，Monaco + diff）
├── useEditorDrag.ts        （拖拽 hook）
└── useEditorCompare.ts     （compare 模式 hook）
```

**动效**：
- 拖入文件到边缘出现蓝色 ghost 高亮
- compare 模式开启有 200ms 淡入左右分屏
- tab 切换有 `transform: translateX` 滑动

**验收**：
- [ ] EditorWorkbench.tsx ≤ 200 行
- [ ] split 拖拽无卡顿
- [ ] all existing EditorWorkbench 单测全过

**风险**：中；纯重构，但需要完整回归

---

## 不在本次范围

以下改进 ROI 偏低，留到下个周期：

- 字体系统扩展（中文衬线/无衬线优化）：+0.2
- 自定义 spacing scale：+0.2
- 大屏 "快速创建面板"（已在 PR-6）：合并完成
- Welcome 首次启动引导：+0.3（独立 PR 更合适）

---

## 验收总览

接受标准 = 同时满足：

1. **视觉**：8 个 PR 合入后 ≥ 9.0 分
2. **回归**：所有现有 `*.test.tsx` 通过
3. **性能**：Lighthouse Performance ≥ 90（骨架屏动效不拖低）
4. **可访问**：`prefers-reduced-motion` 完整支持
5. **主题**：6 套主题全部正常切换且视觉一致

## 分支策略

按 CLAUDE.md「分支 = worktree」规则：

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../tmuxgo-beautify-1 feat/transition
git worktree add ../tmuxgo-beautify-2 feat/app-icon-redesign
# ... 8 个 worktree 并行
```

每个 PR 一个独立 worktree，独立 review、独立 merge。

---

## 时间线（个人估算）

| 周 | PR | 备注 |
|----|----|----|
| W1 周一 | PR-1 | 半天搞定，立即见效 |
| W1 周二 | PR-2 | 用 Figma 拼一下 |
| W1 周三 | PR-3 | 移动端基线动效 |
| W1 周四 | PR-4 | 主题切换收尾 |
| W1 周五 | PR-5 | 骨架屏工程量最重 |
| W2 周一 | PR-6 | 大屏布局 |
| W2 周二~四 | PR-7 | 插画包，4 天画 5 张 |
| W2 周五 | PR-8 | 重构，注意回归 |
