# 流畅性优化分析
## 当前判断
当前项目已经具备较完整的移动端适配和 tmux 会话保持能力，核心链路是前端 xterm.js 渲染、WebSocket 传输、Gateway 通过 node-pty attach tmux。现有实现已经覆盖了输入队列、重连、移动端键盘高度、触摸滚动动量、独占 attach、resize 防抖等基础流畅性处理，但仍有几个会直接影响“跟手感”和“恢复速度”的优化空间。
## 高优先级
### 1. 终端输出批量写入
位置：`apps/frontend/src/components/TerminalPane.tsx`
现状：每次收到 `terminal-output` 事件后直接 `terminal.write(output)`，高频输出时会造成主线程频繁调度，表现为滚动、输入回显和页面响应变慢。
建议：增加基于 `requestAnimationFrame` 或 8-16ms 时间窗的输出缓冲，把多次 WebSocket chunk 合并成一次 `terminal.write`。同时限制单次写入体积，超大输出分片写入，避免长任务阻塞一帧。
预期收益：大量日志、编译输出、训练输出场景下明显降低卡顿，输入回显更稳定。
### 2. WebSocket 输出按帧聚合
位置：`apps/gateway/src/routes/stream.ts`
现状：`ptyProcess.onData` 每个 chunk 都立即 `socket.send(JSON.stringify(...))`，高吞吐时会放大消息数量和 JSON 序列化成本。
建议：Gateway 层增加短缓冲队列，按 8-16ms 合并输出后发送。低频输出保持即时，高频输出合并，避免过多小包。
预期收益：减少网络消息数和前端事件派发次数，提升远程访问和移动网络下的稳定性。
### 3. resize/fitting 状态收敛
位置：`apps/frontend/src/components/TerminalPane.tsx`、`apps/frontend/src/components/ConsoleLayout.tsx`
现状：窗口 resize、visualViewport resize、orientationchange、mobile-keyboard-change、ResizeObserver 都可能触发 fit 或布局同步。移动端键盘弹起、横竖屏切换时容易出现多轮 resize。
建议：抽出统一的 viewport scheduler，把 app height、keyboard inset、terminal fit 合并到同一帧或同一个防抖窗口内处理。对相同 cols/rows、相同 appHeight 的更新继续短路。
预期收益：移动端键盘弹出、收起、旋转屏幕时减少抖动和重复重绘。
### 4. tmux 元数据查询合并
位置：`apps/gateway/src/routes/windows.ts`、`apps/frontend/src/hooks/useApi.ts`
现状：窗口和 pane 信息分开查询，`/hosts/:hostId/sessions/:sessionId/panes` 会先查 windows，再逐个 window 串行查 panes。前端 sessions/windows/panes 也分别走 React Query。
建议：新增 session snapshot 接口，一次返回 session、windows、panes、active window、active pane。后端使用一次或少量 tmux 命令获取完整状态，前端切 session 时一次更新 store。
预期收益：切换会话、打开抽屉、刷新 pane 列表时减少等待和闪烁。
## 中优先级
### 5. attach 流程减少空窗期
位置：`apps/frontend/src/components/PaneGrid.tsx`、`apps/gateway/src/routes/stream.ts`
现状：前端等待 terminal ready 后 attach，attach 超时 5s 后重试；Gateway attach 前会 cleanup 并重新 spawn tmux。切换 session 时终端可能短暂空白。
建议：保留上一帧内容直到新 session 首个 output 或 attached 确认到达，再切换 loading 状态。对同一 session 的重复 attach 做幂等保护，避免不必要的 detach/spawn。
预期收益：切换和重连时体感更连续。
### 6. 输入路径低延迟兜底
位置：`apps/frontend/src/components/PaneGrid.tsx`、`apps/frontend/src/hooks/useWebSocket.ts`
现状：断线时输入会进入队列，连接恢复后 flush。队列按条发送，快速输入时可能产生大量小消息。
建议：对连续输入做微批处理，普通按键仍保持即时，粘贴或快速输入时合并发送。队列 flush 时按块发送，减少恢复瞬间的 WebSocket 发送压力。
预期收益：网络波动后输入恢复更平滑，粘贴大段文本更稳定。
### 7. 触摸滚动命令降噪
位置：`apps/frontend/src/components/TerminalPane.tsx`、`apps/gateway/src/routes/stream.ts`
现状：移动端滚动通过 `pane_scroll` 调 tmux copy-mode 和 send-keys，动量阶段可能持续触发后端命令。
建议：前端滚动事件继续合并，Gateway 对同一 session 的 pane_scroll 再做短窗口合并。进入 copy-mode 的命令只在需要时执行，避免每次向上滚动都调用。
预期收益：移动端滚动历史输出时更跟手，后端 tmux 命令压力更低。
### 8. React Query 缓存策略细化
位置：`apps/frontend/src/components/QueryProvider.tsx`、`apps/frontend/src/hooks/useApi.ts`
现状：全局 `staleTime` 为 5s，所有查询一致。会话元数据和系统信息的实时性要求不同。
建议：hosts 使用更长 staleTime，sessions/windows/panes 在创建、删除、split、kill、attach 事件后主动刷新。避免无意义 refetch，同时确保状态变化及时。
预期收益：减少后台请求，降低切换页面和焦点恢复时的瞬时负载。
## 低优先级
### 9. 移动端底部控件占位稳定
位置：`apps/frontend/src/components/ConsoleLayout.tsx`、`apps/frontend/src/components/ShortcutBar.tsx`、`apps/frontend/src/components/MobileNav.tsx`
现状：键盘打开时 `MobileNav` 和 `ShortcutBar` 切换，主区域 padding 也同步变化，可能造成终端高度二次变化。
建议：底部区域使用固定 dock 容器，内部切换 nav/shortcut 内容，主布局只感知一个稳定高度变量。
预期收益：键盘开关时终端尺寸变化更少。
### 10. 终端主题和偏好更新节流
位置：`apps/frontend/src/components/TerminalPane.tsx`、`apps/frontend/src/hooks/usePreferences.ts`
现状：字体、主题、padding 等偏好变化会触发 options 更新和 fit。设置面板拖动或连续调整时可能重复重绘。
建议：字体大小、padding 使用拖动结束提交或 80-120ms 节流；主题切换只更新必要 options。
预期收益：设置操作更顺滑，避免终端频繁清屏重绘。
### 11. 后端 tmux 命令安全和稳定性
位置：`apps/gateway/src/routes/sessions.ts`、`apps/gateway/src/routes/windows.ts`
现状：部分 tmux 命令使用字符串拼接的 `exec`，session/window 名称复杂时可能导致失败或额外 shell 成本。
建议：统一改为 `execFile` 参数数组，减少 shell 解析，并为 sessionName 做明确校验。
预期收益：降低异常输入导致的卡顿、失败和安全风险。
## 推荐落地顺序
1. 先做前端 `terminal.write` 批量写入和 Gateway 输出按帧聚合。
2. 再做 session snapshot 接口，减少切换会话和抽屉加载时的多请求。
3. 合并移动端 viewport/keyboard/fit 调度，处理键盘弹出和横竖屏场景。
4. 优化输入、滚动、attach 空窗期，补齐高频操作体验。
5. 最后细化 React Query 缓存和偏好设置节流。
## 验证指标
### 桌面端
- `yes`、`find /usr -maxdepth 3`、`npm run build` 等高频输出时输入回显不明显滞后。
- 切换 session 到终端可输入时间稳定低于 300ms。
- 快速调整窗口大小时终端不闪烁、不重复清屏。
### 移动端
- 键盘弹出和收起时终端只 resize 一次或视觉上无明显二次跳动。
- 触摸滚动历史输出时无明显断续，动量结束自然。
- 后台切回前台后 1s 内恢复连接并保持原 session。
### 网络波动
- 短断网后自动恢复，不丢最近输入队列。
- 高延迟网络下输出不会一段一段明显阻塞页面操作。
## 可拆分任务
1. `TerminalPane` 增加输出缓冲器，按帧 flush 到 xterm。
2. `stream.ts` 增加 PTY output 聚合发送。
3. 新增 `/hosts/:hostId/sessions/:sessionId/snapshot`，一次返回 windows 和 panes。
4. 前端用 snapshot 更新 store，减少独立 windows/panes 查询。
5. 抽出移动端 viewport scheduler，统一处理 visualViewport、keyboard、orientation、fit。
6. `pane_scroll` 前后端双层合并，减少 tmux 命令频率。
7. 输入队列支持粘贴和恢复时批量发送。
8. Query staleTime 按资源类型拆分，写操作后精准 invalidate。
