# 会话缩略图 → 应用分屏（Session Split View）— 设计文档

日期：2026-08-12
状态：已实施

## 目标

1. 会话缩略图 tab 升级为分屏组合管理中枢：长按拖拽两个 session 形成分屏组合
2. 点击组合在**主区域**以应用分屏方式展示：主 session 大占比 + 副 session 并排，实时终端
3. 分屏视图上方一行手机版快捷键栏（QuickActions dock），滚轮滚动 = 横向滚动

## 决策（用户确认）

- 仅桌面端（≥1024px），移动端保持现状
- 单个组合最多 2 个 session（两两分屏）
- 组合配置存 localStorage，不动后端存储
- 后端零改动：stream.ts 每连接 attach 单 session，`tmux attach -f ignore-size,active-pane` 共享模式天然支持多 client 并行

## 数据模型

```ts
interface SessionSplitGroup {
  id: string
  hostId: string
  primarySessionId: string
  secondarySessionId: string
  direction: 'horizontal' | 'vertical'   // 主在左/上
  primaryRatio: number                    // 主占比例 0.5~0.8，默认 0.65
  createdAt: string
  updatedAt: string
}
```

- 存储：localStorage `tmuxgo-split-groups`，hook `useSplitGroups`（list/create/update/remove）
- store：`activeSplitGroupId` + open/close actions

## 架构改动

### M1 useWebSocket 多连接（核心）

现状：`wsState` 模块级单例，全应用一个 WS、一个 attach。
改造：连接实例化，按 `hostId\u0000sessionId` 键控。

- `createSocketConnection(key)` 工厂：独立 `{ ws, reconnectTimer, attached, ping... }`
- 主连接（现有 useWebSocket）行为不变：跟随 activeSessionId
- 新增 `useSessionSocket(hostId, sessionId)`：分屏 slot 用，独立连接 attach 固定 session
- `outputListeners` 已按 key 分发，保持；`send` 按连接定向（input 只发往对应 session 连接）
- 复用现有心跳/重连/背景关闭逻辑，抽为实例级

### M2 数据层

- `useSplitGroups.ts`（localStorage CRUD）
- store：`activeSplitGroupId`、`openSplitGroup(id)`、`closeSplitGroup()`

### M3 SessionSplitView（主区域分屏视图）

桌面端主区域挂载（DesktopWorkbench，activeSplitGroupId 存在时替换 TerminalDock）：

```
┌─────────────────────────────────────┐
│ ShortcutBar mode="dock"（快捷键栏）    │ ← 滚轮横向滚动
├───────────────────┬─────────────────┤
│ 主 session         │ 副 session      │ ← PaneGrid 各一个，分隔条可拖
│ （PaneGrid）        │ （PaneGrid）    │    primaryRatio 调整
└───────────────────┴─────────────────┘
```

- 主 session 默认 65% 占比，分隔条拖动调整（复用 TerminalDock resize 模式）
- 点击副 session 头部 → 交换主副；点击副 session 的 × → 退出组合（回单 session 视图）
- 关闭组合 → 恢复原单 session 视图

### M4 快捷键栏滚轮横滚

QuickActions dock 容器加 `onWheel`：`deltaY → scrollLeft`（保留现有触摸拖拽横滑）。

### M5 缩略图面板拖拽

- 卡片长按 500ms 进入拖拽（pointer events + setPointerCapture），半透明卡片跟随指针
- 悬停目标卡片落点高亮：左/右半 → horizontal（主在左/右），上/下半 → vertical，中心 → 交换/替换
- 拖到空白区 → 新建组合
- 面板顶部新增"分屏组合"区：组合卡片（主↔副 + 方向图标），点击打开、× 删除
- 现有缩略图网格保留

## 风险

- 多连接资源：每组合 2 个 pty + 2 个 WS，可接受
- 输入焦点：键盘输入仅进聚焦的 TerminalPane（现有逻辑）
- 缩略图数据已轮询实时，拖拽无需新数据源

## 实施顺序

M1 → M2 → M3 → M4 → M5 → 测试与构建部署
