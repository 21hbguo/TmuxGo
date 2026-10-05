# 网页元素选择（Web Element Picker）— PR 提案

日期：2026-08-13
状态：待评审

## 目标

在 TmuxGo 前端提供"元素选择"能力：用户开启选择模式后，鼠标悬停即高亮页面元素，点击即可查看该元素的 CSS 选择器、组件名与关键属性，复制后可直接用于改前端代码或写测试。

## 现状调研（2026-08-13 扫描）

- 前端为 Vite + React 18 SPA（apps/frontend），纯浏览器页面 + PWA，无 Tauri/Electron
- 无任何浏览器扩展 / content script 代码，仓库内无元素选择、取色器、inspect 相关实现
- 前后端通信：REST HTTP（lib/api.ts）+ WebSocket（hooks/useWebSocket.ts），本功能纯前端，后端零改动

## 方案

### 形态选择

- 首选：应用内 Inspector（本页自选），纯前端，几十~几百行，无新依赖
- 暂不做：浏览器扩展（需打包/发布/权限，工作量大，与自托管定位不符）

### 交互设计

1. 入口：全局快捷键（如 `Cmd/Ctrl+Shift+I`）+ TopBar 按钮 + CommandPalette 命令"元素选择"
2. 开启后进入选择模式：
   - 悬停：元素描边高亮 + 浮层显示 `tagName#id.class` 简写
   - 点击：选中并弹出面板，展示完整 CSS 选择器（含 `>` 链）、组件信息、属性摘要
   - `Esc` / 再次点击按钮：退出选择模式
3. 复制：面板内一键复制选择器 / 复制组件路径

### 技术要点

- 用 `elementFromPoint` + 事件委托（mousemove/mouseover）实现命中检测，不做 shadow DOM 穿透（TmuxGo 无 shadow DOM）
- 高亮用独立 overlay 层（fixed + pointer-events:none），不污染原 DOM
- CSS 选择器生成：自实现 `getCssPath(el)`（优先 id / data-testid，其次 class 链，回退 nth-child）
- 组件名：React DevTools 全局 hook（`__REACT_DEVTOOLS_GLOBAL_HOOK__`）不可用时降级为从 DOM 属性推断；先做纯 DOM 版，组件名作增强项
- 浮层面板为普通 React 组件，`zustand` store 管理选择模式状态

## 文件规划

- `apps/frontend/src/lib/element-picker.ts` — getCssPath、命中检测、状态机
- `apps/frontend/src/components/ElementPickerOverlay.tsx` — 高亮 overlay + 浮层面板
- `apps/frontend/src/components/ElementPickerPanel.tsx` — 选择结果面板（选择器/组件/复制）
- `apps/frontend/src/stores/` — picker 模式 store
- `apps/frontend/src/components/TopBar.tsx`、`CommandPalette.tsx` — 入口
- 快捷键注册跟随现有全局键盘处理（hooks/）

## 增强项（后续）

- sourcemap 保留时：选择器 → 源码文件:行号映射，点击直达对应 .tsx
- 选中元素实时样式预览（临时改 inline style + diff 导出）
- 移动端长按选择

## 风险

- React 18 事件委托下 `mouseover` 冒泡正常，无已知冲突
- overlay 与既有 DragDrop（@dnd-kit）无交集（选择模式期间禁拖拽）
- 与 TerminalPane 的 xterm 捕获事件无冲突：xterm 区域可选择但浮层不渲染内部 DOM

## 实施顺序

1. element-picker.ts（选择器生成 + 命中检测）+ 单测
2. overlay 高亮 + store
3. 面板 + 复制 + 入口（快捷键/按钮/命令）
4. 测试与构建部署
