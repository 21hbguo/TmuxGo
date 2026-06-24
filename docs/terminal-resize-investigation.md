# 终端工作区窗口大小变化后显示错乱 -- 调研报告

> 调研时间：2026-06-08
> 范围：前端终端组件在浏览器窗口 resize 后的显示异常（含文字不渲染、选区后可见等问题）

---

## 1. 架构概述

### 1.1 核心组件链

```
浏览器窗口 resize
  ↓
ConsoleLayout.scheduleViewportSync()  ← window.resize + visualViewport.resize
  → requestAnimationFrame → setAppHeight → CSS reflow
  → dispatchEvent('tmuxgo-layout-change', reason: 'viewport-sync')
                    ↓
DesktopWorkbench.ResizeObserver  ← 容器尺寸变化
  → setContainerSize → React re-render → 面板宽度/终端高度重算
  → useEffect → dispatchEvent('tmuxgo-layout-change', reason: 'desktop-workbench')
                    ↓
TerminalPane.ResizeObserver  ← 终端容器尺寸变化
  → doFit(true) / scheduleFit(0) / syncSharedLayout(false)

TerminalPane.handleWindowResize  ← window.resize (与上面同步触发)
  → scheduleFit(0) / syncSharedLayout(false)

TerminalPane.handleLayoutChange  ← tmuxgo-layout-change 事件
  → forceStableFit / scheduleFit / syncSharedLayout
```

### 1.2 两种 Fit 模式

| | Exclusive (独占) | Shared (共享) |
|---|---|---|
| cols/rows 来源 | 前端计算 (fitAddon + getFitDimensions) | 后端下发 (attach 事件) |
| 字体处理 | 固定 fontSize，微调 lineHeight | 动态缩放 fontSize 适配容器 |
| 核心函数 | `doFit()` | `syncSharedLayout()` |
| resize 消息 | 前端发给后端 | 后端决定 |

---

## 2. 发现的问题

### 问题 1：三路并发 resize -- 同一窗口 resize 事件触发最多 8+ 次 doFit [高危]

**现象**：窗口 resize 时，TerminalPane 同时收到三路独立的 resize 信号：

| 路径 | 触发源 | 时序 | 目标函数 |
|------|--------|------|----------|
| A | `window.resize` → `handleWindowResize` | 同步 | `scheduleFit(0)` → rAF → `doFit` |
| B | `ResizeObserver` 容器尺寸变化 | layout 后异步 | `scheduleFit(0)` → rAF → `doFit` |
| C | `tmuxgo-layout-change` (viewport-sync) | ConsoleLayout 的 rAF 内 | `forceStableFit(5, 34)` → 立即 + 4次延迟 |
| D | `tmuxgo-layout-change` (desktop-workbench) | DesktopWorkbench useEffect 内 | `forceStableFit(5, 34)` → 立即 + 4次延迟 |

**时序分析**（桌面端 exclusive 模式）：

```
T+0ms   window.resize 事件触发
        ├── TerminalPane.handleWindowResize → scheduleFit(0)
        │   → 清除旧 fitFrame，创建 rAF → doFit (约 T+16ms 执行)
        └── ConsoleLayout.scheduleViewportSync
            → 请求 rAF (约 T+8ms 执行)

T+8ms   ConsoleLayout rAF 执行
        ├── setAppHeight(newHeight) → React 调度 re-render
        └── dispatchEvent('tmuxgo-layout-change', viewport-sync)
            → TerminalPane.handleLayoutChange
                → forceStableFit(5, 34)
                    → 立即: scheduleFit(0, true)
                        → doFit(true) 立即执行 (同步!)
                            → 但此时容器 CSS 尚未更新 → 用旧尺寸计算
                        → 清除 T+0ms 的 fitFrame

T+16ms  React commit → CSS height 变更 → layout reflow
        → TerminalPane.ResizeObserver 触发
            → scheduleFit(0) → rAF → doFit

T+16ms  DesktopWorkbench.ResizeObserver 触发
        → setContainerSize → React re-render
        → useEffect → dispatchEvent('desktop-workbench')
            → forceStableFit(5, 34) 取消前一个 forceStableFit
            → 立即: scheduleFit(0, true) → doFit(true)

T+42ms  forceStableFit 第2次迭代 → doFit
T+76ms  forceStableFit 第3次迭代 → doFit
T+110ms forceStableFit 第4次迭代 → doFit
T+144ms forceStableFit 第5次迭代 → doFit
```

**关键问题**：
1. T+8ms 的 `doFit(true)` 在 CSS reflow 之前执行，使用**旧的容器尺寸**计算 cols/rows
2. T+16ms 的 ResizeObserver `doFit` 在 CSS reflow 之后执行，使用**新的容器尺寸**
3. T+16ms 的 `desktop-workbench` `forceStableFit` 又取消前一个，重新开始 5 次迭代
4. 最终在 ~150ms 内执行 **8+ 次 doFit**，每次调用 `fitAddon.fit()` + `terminal.resize()`

**后果**：
- xterm.js WebGL 渲染器被反复 resize，纹理缓存频繁失效
- tmux 后端收到多次 resize 消息（cols/rows 可能不同步），触发多次 redraw
- 终端内容在不同尺寸间闪烁

---

### 问题 2：doFit() 的三步 resize 流程存在内部不一致 [高危]

`doFit()` 函数（第 1203-1243 行）的执行流程：

```
1. fitAddon.fit()                          ← xterm 内部 resize (基于 FitAddon 的计算)
2. getFitDimensions()                      ← 基于 _renderService.dimensions.css.cell 重新计算
3. terminal.resize(cols, rows)             ← 如果与步骤1的结果不同，再次 resize
```

**问题**：已确认 `fitAddon.fit()` 内部**确实调用了** `terminal.resize()`（FitAddon 源码第 44-47 行）：

```typescript
// FitAddon.fit() 内部:
if (this._terminal.rows !== dims.rows || this._terminal.cols !== dims.cols) {
  core._renderService.clear();
  this._terminal.resize(dims.cols, dims.rows);  // ← 第一次 resize
}
```

然后 `doFit()` 继续调用 `getFitDimensions()` + `terminal.resize()`（第二次 resize）。两个函数的尺寸计算方式不同：

| | `fitAddon.proposeDimensions()` | `getFitDimensions()` |
|---|---|---|
| cellWidth/cellHeight 来源 | `core._renderService.dimensions.css.cell` | `terminal._core._renderService.dimensions.css.cell` |
| 可用宽度计算 | `parentElementWidth - elementPadding - scrollbarWidth` | `parentElement.clientWidth - terminalPadding` |
| padding 来源 | `getComputedStyle(terminal.element)` | `getComputedStyle(container)` 即 `[data-terminal]` |
| 滚动条处理 | 扣除 `scrollBarWidth` | 不扣除 |

两个函数使用**不同的 padding 来源**和**不同的滚动条处理**，在以下情况会产生不同结果：
1. `[data-terminal]` 容器的 padding 与 `.xterm` 元素的 padding 不同
2. 终端有滚动条时，`proposeDimensions()` 扣除了滚动条宽度，`getFitDimensions()` 没有
3. WebGL 渲染器 dimensions 尚未更新时，两者可能使用不同时间点的 cellWidth/cellHeight

结果：`fitAddon.fit()` resize 到 `(cols_A, rows_A)`，`getFitDimensions()` 计算出 `(cols_B, rows_B)`，`terminal.resize(cols_B, rows_B)` 再次 resize。tmux 后端收到两次不同尺寸的 resize 消息。

---

### 问题 3：adjustExclusiveLineHeight() 递归触发 scheduleFit [中危]

在 `doFit()` 的 `requestAnimationFrame` 回调中（第 1230-1236 行）：

```typescript
requestAnimationFrame(() => {
  scheduleRendererStyleCorrection()
  syncExclusiveViewport()
  repaintTerminalRenderer(force && isMobileDevice, stickToBottom)
  if (adjustExclusiveLineHeight()) scheduleFit(0, true)  // ← 递归!
})
```

`adjustExclusiveLineHeight()` 微调 lineHeight（桌面端 0.98-1.04，移动端 1.0-1.08）使终端行填满容器。当它返回 `true` 时，递归调用 `scheduleFit(0, true)`，这会触发新的 `doFit`，新的 `doFit` 又会触发新的 rAF，其中 `adjustExclusiveLineHeight()` 可能再次返回 `true`。

**缺少递归深度保护**。理论上 lineHeight 收敛很快（阈值 0.001），但在 resize 过程中容器尺寸不断变化，lineHeight 可能永远无法收敛，形成无限递归。

---

### 问题 4：fitAddon.fit() 与 WebGL 渲染器的时序问题 [中危]

桌面端使用 WebGL addon（第 1401-1408 行）。`fitAddon.fit()` 依赖 xterm 内部渲染服务的 dimensions，但 WebGL 渲染器的纹理更新是异步的。

在快速 resize 时：
1. `fitAddon.fit()` 基于旧的渲染 dimensions 计算 cols/rows
2. `terminal.resize()` 触发 WebGL 渲染器重新布局
3. 但在 rAF 中 `getFitDimensions()` 读取的 dimensions 可能仍是旧值
4. 导致计算出的 cols/rows 与实际渲染不匹配

---

### 问题 5：TerminalDock 拖拽结束时双重 layout-change 事件 [中危]

TerminalDock 鼠标松开时（第 35-47 行）：

```typescript
// TerminalDock.handleUp:
setTerminalPanelHeight(pendingHeightRef.current)  // 更新 store
window.dispatchEvent('tmuxgo-layout-change', 'terminal-panel-resize-end')

// DesktopWorkbench useEffect (因 terminalPanelHeight 变化触发):
window.dispatchEvent('tmuxgo-layout-change', 'desktop-workbench')
```

**两次 `forceStableFit` 在同一帧内执行**。第二次取消第一次的 stableFitToken，但第一次已执行了第 1 次迭代。结果是浪费了一次 doFit 调用。

---

### 问题 6：共享模式下 syncSharedLayout 的字体缩放竞态 [中危]

`syncSharedLayout()`（第 1307-1348 行）的字体缩放逻辑：

```typescript
sharedLayoutFrame = requestAnimationFrame(() => {
  const canvas = getCanvasSize()      // xterm 渲染后的 canvas 实际像素尺寸
  const available = getAvailableSize() // 容器可用像素尺寸
  const scale = Math.min(widthScale, heightScale)
  const nextFontSize = Math.round(currentFontSize * scale * 10) / 10
  if (attempt < 2 && Math.abs(scale - 1) > 0.03) {
    terminal.options.fontSize = nextFontSize
    syncSharedLayout(false, attempt + 1)  // ← 递归，但会取消前一个 sharedLayoutFrame
    return
  }
})
```

**问题**：
1. `getCanvasSize()` 读取 `_renderService.dimensions.css.canvas`，这在 `terminal.resize()` 后可能尚未更新
2. 如果 canvas 尺寸是旧的，scale 计算错误，fontSize 被设置为错误值
3. 递归最多 2 次，但如果每次 canvas 都未更新，2 次都不够
4. 窗口快速 resize 时，`syncSharedLayout` 被多次调用，每次取消前一个 rAF，但 fontSize 已经被修改，导致字体在错误值和正确值之间跳动

---

### 问题 7：recoverTerminalScreen() 与 resize 的竞态 [低危]

DPR 变化时（如拖拽窗口到不同 DPI 的显示器），`syncRenderEnvironment` 调用 `recoverTerminalScreen()`：

```typescript
const recoverTerminalScreen = () => {
  clearTerminalRendererCache()  // 清除纹理缓存
  terminal.clear()              // 清屏
  terminal.reset()              // 重置终端状态
  applyTerminalOptions()        // 重新应用选项
  scheduleTerminalRepaint(...)  // 调度多阶段重绘
}
```

如果此时 `doFit` 也在执行中：
1. `recoverTerminalScreen` 清除渲染缓存 + reset
2. `doFit` 读取 `_renderService.dimensions.css.cell` → **已被清除，返回 undefined**
3. `getFitDimensions()` 返回 null → `doFit` 返回 false
4. `scheduleFit` 的 force 重试逻辑触发 → 再次 doFit → 可能成功

这导致 DPR 变化后的第一次 fit 几乎必然失败，需要重试。

---

### 问题 8：lastFitSize / lastContainerSize 初始值为 {0,0} [低危]

```typescript
let lastContainerSize = { width: 0, height: 0 }
let lastFitSize = { width: 0, height: 0 }
```

`doFit` 的尺寸容差检查（第 1211 行）：
```typescript
if (!force && Math.abs(currentWidth - lastFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && ...) return true
```

初始值 {0,0} 意味着第一次 fit 必定通过（任何容器尺寸与 0 的差异都 > 2px）。这本身不是 bug，但意味着：
- 如果 `doFit` 从未成功执行（例如一直是 shared 模式），`lastFitSize` 始终为 {0,0}
- 切换到 exclusive 模式后，第一次 `doFit(false)` 必定执行，即使容器尺寸未变

---

### 问题 9：CSS 层级冲突 -- xterm-screen 的 position:absolute 与 flex 布局 [低危]

globals.css 中（第 364-368 行）：
```css
[data-terminal] .xterm-screen {
  position: absolute !important;
  inset: 0 !important;
  height: 100% !important;
  width: 100% !important;
}
```

`xterm-screen` 被设为 `position: absolute`，脱离文档流。这与 `xterm` 容器的 `position: relative` 配合工作，但当父容器的 flex 布局尺寸变化时：

1. `.xterm` 容器尺寸通过 flex 更新
2. `xterm-screen` 通过 `inset: 0` + `width/height: 100%` 跟随
3. 但 xterm.js 内部的 `_renderService.dimensions` 可能缓存了旧的 canvas 尺寸
4. 直到下一次 `fitAddon.fit()` 或 `terminal.resize()` 才更新

---

## 3. 根因分析

综合以上问题，终端在窗口 resize 后显示错乱的**最可能根因**是：

### 根因 A：resize 事件的多路并发导致 doFit 使用过时的容器尺寸

窗口 resize 时，`handleWindowResize`（同步）和 `handleLayoutChange`（ConsoleLayout 的 rAF 内）几乎同时触发 `doFit`。但 `handleLayoutChange` 中的 `forceStableFit` 会**立即同步执行** `doFit(true)`（通过 `scheduleFit(0, true)` → `doFit(true)`），此时 React 尚未 commit CSS 变更，`container.clientWidth/Height` 仍是旧值。

```
T+0ms   window.resize
T+0ms   handleWindowResize → scheduleFit(0) → 排队 rAF
T+8ms   ConsoleLayout rAF → setAppHeight → dispatchEvent(viewport-sync)
T+8ms   handleLayoutChange → forceStableFit → scheduleFit(0, true) → doFit(true) 立即执行
        → container.clientWidth/Height 仍是旧值! → 计算出错误的 cols/rows
T+16ms  React commit → CSS 变更 → ResizeObserver → doFit → 使用新尺寸 → 正确
T+16ms  但此时 tmux 已经收到了 T+8ms 的错误 resize 消息
```

### 根因 B：fitAddon.fit() 与 getFitDimensions() 的双重 resize 不一致

`doFit()` 中 `fitAddon.fit()` 和后续的 `getFitDimensions()` + `terminal.resize()` 可能计算出不同的 cols/rows，导致 tmux 收到不一致的尺寸。

### 根因 C：shared 模式下字体缩放基于过时的 canvas 尺寸

`syncSharedLayout` 在 `terminal.resize()` 后立即读取 canvas 尺寸，但 WebGL 渲染器可能尚未完成重绘，导致 scale 计算基于旧的 canvas 尺寸，fontSize 被设置为错误值。

---

## 4. 涉及的关键文件

| 文件 | 关键行号 | 作用 |
|------|----------|------|
| `TerminalPane.tsx` | 1203-1243 | `doFit()` 核心 fit 函数 |
| `TerminalPane.tsx` | 1244-1275 | `scheduleFit()` 调度函数 |
| `TerminalPane.tsx` | 1285-1303 | `forceStableFit()` 多次重试 |
| `TerminalPane.tsx` | 1307-1348 | `syncSharedLayout()` 共享模式布局 |
| `TerminalPane.tsx` | 1035-1054 | `getFitDimensions()` 尺寸计算 |
| `TerminalPane.tsx` | 1085-1108 | `applyRendererStyleCorrection()` 渲染修正 |
| `TerminalPane.tsx` | 1118-1146 | `recoverTerminalScreen()` / `softRecoverTerminalScreen()` |
| `TerminalPane.tsx` | 1185-1199 | `adjustExclusiveLineHeight()` 行高微调 |
| `TerminalPane.tsx` | 1531-1538 | `handleWindowResize()` |
| `TerminalPane.tsx` | 1590-1632 | `handleLayoutChange()` |
| `TerminalPane.tsx` | 1819-1832 | ResizeObserver 回调 |
| `ConsoleLayout.tsx` | 132-194 | `scheduleViewportSync()` |
| `DesktopWorkbench.tsx` | 53-91 | ResizeObserver + window resize |
| `DesktopWorkbench.tsx` | 145-155 | layout-change 派发 |
| `TerminalDock.tsx` | 24-68 | 面板拖拽 + layout-change 派发 |
| `PaneGrid.tsx` | 95-101 | `sendResizeNow()` WebSocket resize |
| `globals.css` | 322-372 | xterm.js CSS 覆盖 |

---

## 5. 数据流全景图

```
┌─────────────────────────────────────────────────────────────┐
│                    浏览器窗口 resize                          │
└───────────┬─────────────────┬───────────────┬───────────────┘
            │                 │               │
            ▼                 ▼               ▼
   handleWindowResize   scheduleViewportSync  ResizeObserver
   (TerminalPane)       (ConsoleLayout)       (DesktopWorkbench + TerminalPane)
            │                 │               │
            │                 ▼               ▼
            │         setAppHeight()    setContainerSize()
            │         (React state)     (React state)
            │                 │               │
            │                 ▼               ▼
            │         tmuxgo-layout-change   tmuxgo-layout-change
            │         (viewport-sync)        (desktop-workbench)
            │                 │               │
            ▼                 ▼               ▼
      scheduleFit(0)    forceStableFit    forceStableFit
            │           (5次, 34ms间隔)   (5次, 34ms间隔)
            │                 │               │
            ▼                 ▼               ▼
         doFit()          doFit()          doFit()
            │                 │               │
            ├── fitAddon.fit()                │
            ├── getFitDimensions()            │
            ├── terminal.resize(cols,rows)    │
            ├── onResize → sendResizeNow      │
            │       → WebSocket resize msg    │
            └── rAF → styleCorrection        │
                   + lineHeight adjust        │
                   + repaint                  │
                                              ▼
                                    tmux 收到多次 resize
                                    → scheduleClientRedraw
                                    → tmux refresh-client
                                    → 输出重绘
```

---

## 6. 复现条件推测

基于以上分析，以下场景最容易触发显示错乱：

1. **快速拖拽窗口边缘**：连续 resize 事件 + CSS reflow 延迟 → 多次 doFit 使用不同时刻的尺寸
2. **窗口从大变小**：flex 布局收缩 → 终端容器尺寸变化 → fitAddon.fit() 与 getFitDimensions() 不一致
3. **拖拽到不同 DPI 显示器**：DPR 变化 → recoverTerminalScreen 清除缓存 → doFit 的 dimensions 为 null → fit 失败 → 重试期间显示错乱
4. **TerminalDock 面板拖拽结束后松手**：双重 layout-change 事件 → 两次 forceStableFit 竞争
5. **共享模式下窗口 resize**：syncSharedLayout 基于过时 canvas 尺寸缩放字体 → 字体大小跳动

---

## 7. 修复建议（仅方向，不改代码）

| 优先级 | 方向 | 预期效果 |
|--------|------|----------|
| P0 | **合并 resize 路径**：在 handleWindowResize 中不直接调用 scheduleFit，而是仅通过 tmuxgo-layout-change 事件统一处理 | 消除同一 resize 事件触发多条独立 fit 链的问题 |
| P0 | **延迟 doFit 直到 CSS reflow 完成**：forceStableFit 的第一次迭代应延迟到下一帧（而非立即同步执行），确保 React 已 commit CSS 变更 | 确保 doFit 使用最新的容器尺寸 |
| P1 | **消除 doFit 中的双重 resize**：fitAddon.fit() 后不再调用 getFitDimensions() + terminal.resize()，或跳过 fitAddon.fit() 直接用 getFitDimensions()。已确认 FitAddon.fit() 内部确实调用 terminal.resize()（源码第 46 行），与 doFit 的手动 resize 构成双重 resize | 避免 cols/rows 不一致 |
| P1 | **syncSharedLayout 延迟读取 canvas**：在 terminal.resize() 后至少等一帧再读取 canvas 尺寸 | 确保 scale 计算基于正确的 canvas 尺寸 |
| P2 | **adjustExclusiveLineHeight 添加递归保护**：限制 lineHeight 调整的递归次数（如最多 2 次） | 防止潜在的无限递归 |
| P2 | **TerminalDock mouseup 合并事件**：在 dispatchEvent('terminal-panel-resize-end') 后标记一个标志位，让 DesktopWorkbench 的 useEffect 检测到并跳过 | 消除双重 forceStableFit |
| P1 | **applyRendererStyleCorrection 不移除 WebGL 设置的尺寸**：当 WebGL 渲染器活跃时，不移除 `.xterm-screen` 的 width/height | 防止 WebGL canvas 与容器尺寸不匹配 |
| P1 | **clearTerminalRendererCache 后强制刷新**：在 `clearTextureAtlas()` 后立即调用 `terminal.refresh(0, rows-1, true)` | 确保纹理缓存清除后立即重建 |

---

## 8. 文字不渲染但选区后可见 -- 专项分析

### 8.1 症状描述

窗口 resize 后，终端内容有时完全不可见（空白），但用户用鼠标选区后文字又显示出来。这不是布局错乱，而是**渲染层**的问题。

### 8.2 根因：WebGL 纹理图集失效竞态

**核心机制**：桌面端使用 WebGL addon 渲染终端。WebGL 渲染器维护一个**纹理图集（Texture Atlas）**，将所有字符光栅化后存储在 GPU 纹理中。渲染时通过引用纹理中的 glyph 来绘制字符。

**导致文字不可见的完整流程**：

```
1. 窗口 resize
   ↓
2. doFit() → fitAddon.fit()
   → _renderService.clear()        ← 清除 WebGL glyph 模型（GPU 顶点数据清零）
   → terminal.resize(cols, rows)   ← 触发 _fullRefresh() 重新渲染
   ↓
3. 同时：handleLayoutChange → forceStableFit → scheduleTerminalRepaint
   → [0, 16, 48, 120, 260]ms 各执行一次 repaintTerminalRenderer
   ↓
4. repaintTerminalRenderer → refreshTerminalRows → terminal.refresh(0, rows-1)
   → RenderDebouncer → requestAnimationFrame → renderRows()
   ↓
5. WebGL renderRows 执行：
   beginFrame() 检查 _requestClearModel
   → 如果 true：_clearModel(true) + _updateModel(0, rows-1)  ← 全量重建
   → 如果 false：_updateModel(e, t)                          ← 增量更新
   ↓
6. _updateModel 调用 getRasterizedGlyph(char) 从纹理图集获取 glyph
   → 如果图集已被 clearTexture() 清除，需要重新光栅化
   → 重新光栅化需要 canvas 2D 操作，可能失败或返回空 glyph
   → GPU 顶点数据为零 → 字符不可见
```

**关键发现**：`clearTextureAtlas()` 清除纹理图集后，设置了 `_requestClearModel = true`。下一次 `beginFrame()` 会检测到这个标志并执行全量重建。但问题是：

1. **`clearTexture()` 清除了所有 atlas 页面的缓存**，`getRasterizedGlyph()` 需要重新光栅化每个字符
2. **重新光栅化是按需的（lazy）**，只有当 `_updateModel` 遍历到某个字符时才会触发
3. **如果 `_updateModel` 在 atlas 尚未完全重建时执行**，部分 glyph 可能返回空数据（零尺寸/零透明度顶点）
4. **`warmUp()` 未被重新调用** — 纹理图集的预热队列（`IdleTaskQueue`）在 `clearTexture()` 后不会自动重启

### 8.3 为什么选区后文字可见

xterm.js 的选区变更处理：

```javascript
// xterm.js 内部
handleSelectionChanged() {
  this._requestRedrawViewport()  // ← 触发全视口重绘
}
```

选区操作触发 `_requestRedrawViewport()`，这会：
1. 请求 `refreshRows(0, rows-1, true)` — 全量重绘
2. 此时距离 resize 已经过了一段时间，纹理图集通过按需光栅化已基本重建完成
3. 全量重绘时所有 glyph 都能正确获取 → 文字显示

### 8.4 加重因素

#### 因素 A：`applyRendererStyleCorrection` 移除 WebGL 设置的尺寸

```typescript
// applyRendererStyleCorrection (第 1085-1103 行)
renderer.screen.style.removeProperty('width')   // 第 1091 行
renderer.screen.style.removeProperty('height')  // 第 1100 行（桌面非 exclusive）
```

WebGL addon 在 `handleResize` 中**主动设置** `.xterm-screen` 的 width/height：
```javascript
// WebGL addon handleResize
this._core.screenElement.style.width = `${this.dimensions.css.canvas.width}px`
this._core.screenElement.style.height = `${this.dimensions.css.canvas.height}px`
```

但 `applyRendererStyleCorrection`（在 `doFit` 的 rAF 中调用）**立即移除**这些尺寸。这导致：
- WebGL canvas 有明确的像素尺寸（如 1920x1080）
- 但 `.xterm-screen` 容器没有明确尺寸，回退到 CSS 的 `width: 100%; height: 100%`
- 如果容器的实际尺寸与 canvas 尺寸不匹配，canvas 可能被裁剪或错位

#### 因素 B：`FitAddon.fit()` 在 resize 前调用 `clear()`

```javascript
// FitAddon.fit() 源码
fit() {
  const dims = this.proposeDimensions()
  // ...
  core._renderService.clear()      // ← 先清除所有已渲染内容
  this._terminal.resize(dims.cols, dims.rows)  // ← 再 resize
}
```

`clear()` 在 DOM 渲染器下清除所有行元素（`replaceChildren()`），在 WebGL 渲染器下清除 glyph 模型。在 `clear()` 和 `resize()` 之间的短暂窗口内，终端是完全空白的。如果此时有其他渲染操作（如 `scheduleTerminalRepaint` 的 rAF 回调），可能看到空白状态。

#### 因素 C：`refreshTerminalRows` 的移动端 120ms 节流

```typescript
// 第 960 行
if (!force && isMobileDevice && now - lastRefreshAt < 120) return
```

移动端的 recovery repaint 延迟为 `[48, 160]`。如果 48ms 的 refresh 执行了，160ms 的 refresh 也在 120ms 窗口内（160-48=112 < 120），会被**静默跳过**。这意味着移动端的 recovery 可能只执行了一次 refresh。

#### 因素 D：`doFit` 中 style correction 在 repaint 之前执行

```typescript
// doFit 的 rAF 回调 (第 1230-1236 行)
requestAnimationFrame(() => {
  scheduleRendererStyleCorrection()  // ← 先移除 WebGL 设置的尺寸
  syncExclusiveViewport()
  repaintTerminalRenderer(...)       // ← 再尝试重绘（但尺寸已被移除）
})
```

`scheduleRendererStyleCorrection` 请求下一帧执行 `applyRendererStyleCorrection`，而 `repaintTerminalRenderer` 在当前帧执行。但两者都在同一个 rAF 回调中，所以实际上：
1. `applyRendererStyleCorrection` 在**下一个** rAF 执行
2. `repaintTerminalRenderer` 在**当前** rAF 执行

这意味着 repaint 先执行，style correction 后执行。repaint 时尺寸还是正确的，但 style correction 后尺寸被移除，导致下一次渲染时 WebGL canvas 与容器不匹配。

### 8.5 修复建议

| 优先级 | 方向 | 位置 |
|--------|------|------|
| P0 | **`applyRendererStyleCorrection` 不移除 WebGL 设置的 `.xterm-screen` 尺寸** — 当 WebGL 渲染器活跃时，保留 width/height，或改为设置为 canvas 的实际像素尺寸 | `TerminalPane.tsx:1085-1103` |
| P0 | **`clearTerminalRendererCache` 后立即触发全量刷新** — 在 `clearTextureAtlas()` 后调用 `terminal.refresh(0, rows-1)` 并设置 `force=true` | `TerminalPane.tsx:1109-1117` |
| P1 | **`doFit` 中 style correction 应在 repaint 之前同步执行** — 将 `scheduleRendererStyleCorrection()` 改为 `applyRendererStyleCorrection()`（同步调用），确保 repaint 时尺寸已修正 | `TerminalPane.tsx:1230-1236` |
| P1 | **`recoverTerminalScreen` 传入 `forceRefresh=true`** — 当前桌面端 recovery 的 `scheduleTerminalRepaint` 未传 `forceRefresh`，导致移动端节流可能跳过刷新 | `TerminalPane.tsx:1133` |
| P2 | **纹理图集预热** — `clearTexture()` 后重新调用 `warmUp()` 或使用 `IdleTaskQueue` 预热常用字符 | 需修改 xterm.js 或在 clearTextureAtlas 后手动触发 |
