# TmuxGo 流畅性优化评议
## 结论
当前项目已经具备可用性，但离“长期高频使用时依然顺滑”的标准还有明显差距。问题不在单一点，而是前端状态扇出、全局事件广播、终端渲染职责过重、WebSocket 输出链路粗放、布局变化过于高频、文件面板递归查询偏重这几类问题叠加。现在的实现偏“功能闭环优先”，不是“流畅性闭环优先”。如果继续在现有结构上堆功能，卡顿、输入延迟、移动端掉帧、长输出场景下主线程阻塞会越来越明显。

按收益排序，最该先动的不是视觉层，而是数据流和事件流。

## 现状判断
### 1. 前端存在明显的全局状态写放大
`ConsoleLayout` 同时承担查询结果接收、全局状态同步、移动端视口同步、覆盖层历史管理、快捷键分发等职责，并且把 `hosts/sessions/windows/panes/activePaneId` 直接写入 zustand 全局 store，导致 layout 成为高频更新的汇聚点。[apps/frontend/src/components/ConsoleLayout.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/ConsoleLayout.tsx:27)

`sessionsData`、`snapshotData` 到 store 的同步是“双份状态源”模式，React Query 和 zustand 都在维护一份会话数据。只要快照对象变化，就会触发全局订阅者重算；后面如果把 snapshot 刷新频率拉高，这里会先成为瓶颈。[apps/frontend/src/components/ConsoleLayout.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/ConsoleLayout.tsx:208)

更糟的是，部分组件没有 selector 粒度控制，直接整包读取 store，例如 `SessionPanel` 直接 `useConsoleStore()`，这会让几乎所有状态变动都波及会话面板重渲染。[apps/frontend/src/components/SessionPanel.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/SessionPanel.tsx:9)

### 2. 全局事件总线使用过重，事件风暴风险高
现在大量交互通过 `window.dispatchEvent(new CustomEvent(...))` 串起来，包括终端输出、终端输入、附着完成、布局变化、移动端文件层级、打开设置、复制粘贴请求等。[apps/frontend/src/hooks/useWebSocket.ts](/home/guo/project/other/TmuxGo/apps/frontend/src/hooks/useWebSocket.ts:28)

这类做法在功能初期推进很快，但性能和可维护性都差：
- 事件是广播，不是定向订阅
- 调用链不可追踪，难做性能剖析
- 触发方不知道下游有多少监听器
- 高频事件会把无关模块也拖进调度队列

尤其是终端输出：WebSocket 收到 `output` 后先转成全局浏览器事件，再由 `TerminalPane` 监听处理，这中间多了一次全局派发和一次全局监听命中。[apps/frontend/src/components/TerminalPane.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/TerminalPane.tsx:775)

### 3. TerminalPane 过于臃肿，是典型的热点大组件
`TerminalPane` 把终端实例管理、fit、滚动、输出 flush、剪贴板、移动端键盘、拖拽上传、复制粘贴拦截、指针同步、布局变化监听、attach 状态处理全部塞在一个组件里，且核心逻辑集中在一个超长 `useEffect` 里。[apps/frontend/src/components/TerminalPane.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/TerminalPane.tsx:135)

这种结构的问题不是“代码不好看”，而是：
- 任意局部变更都容易影响终端主链路
- 很难做职责隔离和局部 profiling
- 一个 effect 里挂大量 listener 和 timer，主线程压力不可预测
- 终端场景本来就高频，一旦内部再有 DOM 查询、样式同步、复制逻辑、移动端修补逻辑叠加，掉帧会非常明显

当前组件内部自己也做了一层输出 buffer 和 timer，而上游 gateway 也做了输出 buffer 和 timer，属于双层缓冲、双层调度，吞吐未必更高，延迟反而更难控制。[apps/frontend/src/components/TerminalPane.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/TerminalPane.tsx:146)

### 4. WebSocket 链路可用，但仍然偏粗放
`useWebSocket` 目前是单例式全局状态机，承担连接、重连、ping/pong、页面前后台切换恢复、消息派发等职责。这个方向没错，但终端输出仍然走 `JSON.parse -> CustomEvent -> TerminalPane buffer -> xterm.write` 这条长链，消息路径过深。[apps/frontend/src/hooks/useWebSocket.ts](/home/guo/project/other/TmuxGo/apps/frontend/src/hooks/useWebSocket.ts:21)

问题主要有三类：
- 每条消息都做 JSON 解析，高输出场景主线程压力大
- `output` 作为最热消息类型，却没有最短路径处理
- 连接状态更新也会回写全局 store，和布局层状态写叠加

### 5. Gateway 输出聚合策略还不够精细
gateway 侧 `/stream` 路由在 4ms flush 周期内聚合输出，最大 65536 字符直接推送给前端。[apps/gateway/src/routes/stream.ts](/home/guo/project/other/TmuxGo/apps/gateway/src/routes/stream.ts:14)

这套策略的问题不是不能用，而是缺少“按场景退化”的机制：
- 长文本刷屏时，单包很大，前端一次 JSON parse 和一次 xterm write 的成本都高
- `sanitizeOutput` 每个 chunk 都走多次正则清洗，CPU 成本不低
- flush 间隔固定，没根据前端消费速度、Tab 可见性、移动端设备能力动态调整

这会导致一个典型现象：后端为了减少消息数而扩大包体，前端为了减少卡顿又二次缓冲，最后整体输入回显和滚动跟手性反而下降。

### 6. 布局链路对“连续变化”不够克制
多个区域 resize 时都直接写 store 或派发全局事件：
- `DesktopWorkbench` 在拖拽宽度时每次 mousemove 都 setState。[apps/frontend/src/components/DesktopWorkbench.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/DesktopWorkbench.tsx:62)
- `TerminalDock` 在拖拽高度时每次 mousemove 都 setState 并广播布局变化。[apps/frontend/src/components/TerminalDock.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/TerminalDock.tsx:10)
- `ConsoleLayout` 对 `resize/visualViewport/orientationchange/mobile-keyboard-change` 都有监听，还会更新 `appHeight` 和 `keyboardOpen`。[apps/frontend/src/components/ConsoleLayout.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/ConsoleLayout.tsx:161)

这些逻辑单看都合理，但合在一起会形成典型布局抖动链：视口变化 -> 容器尺寸变化 -> layout 事件 -> terminal fit -> xterm 重新测量 -> resize 回传。

### 7. 文件面板在重目录场景下会拖慢整体交互
`FilePanel` 的目录树通过递归 `TreeDirectoryNode` 展开，每个目录节点打开时都各自触发 `useFileList` 查询。[apps/frontend/src/components/FilePanel.tsx](/home/guo/project/other/TmuxGo/apps/frontend/src/components/FilePanel.tsx:176)

这对小目录没问题，但在大仓库里会出现：
- 多个节点并发请求
- 树递归层级深时渲染量快速上涨
- 文件面板和终端共处一个页面，容易争抢主线程

如果用户边看文件边跑高输出终端，这里会明显拖慢“整体顺滑感”。

### 8. 目前缺少系统化性能观测
仓库里已有一些功能测试，但几乎没有针对真正流畅性指标的自动化验证，例如：
- 终端首屏 attach 耗时
- 高频输出下主线程长任务数量
- 端到端输入回显延迟
- layout resize 时掉帧比例
- 大目录展开时的渲染耗时

没有指标就只能靠体感，靠体感推进优化，最后一定会回到“改了很多，但不知道哪项真有效”的低效状态。

## 优化应从哪些角度入手
### 一、先收缩状态面，再谈渲染优化
这是第一优先级。

当前最需要做的是把“服务端数据状态”和“本地 UI 状态”彻底分层：
- React Query 只管理服务端数据：hosts、sessions、snapshot、file list、preview
- zustand 只管理本地 UI：active ids、panel open/size、toasts、editor transient state
- 取消 `ConsoleLayout` 中对 `sessions/windows/panes` 的二次同步写入
- 组件直接消费 query 数据，只有“用户意图状态”才进 zustand

大概做法：
1. 把 `windows/panes/sessions/hosts` 从全局 store 中逐步迁出
2. 先改 `SessionPanel/WindowTabs/PaneGrid`，让它们直接从 query 或由 query 派生的数据读
3. 对必须保留在 store 的字段，使用 selector + shallow，禁止整包订阅
4. 把 `activePaneId` 这种局部交互状态独立保留，避免和快照列表绑定更新

预期收益：
- 降低全局重渲染扇出
- 降低快照刷新带来的无关组件抖动
- 为更高频 snapshot 或后续 websocket snapshot 铺路

### 二、把全局事件总线改成“热路径直连，冷路径事件化”
这是第二优先级。

不要把所有东西都继续堆在 `window` 事件上。尤其终端输出和输入属于最热路径，必须缩短。

大概做法：
- `output` 不再走 `window.dispatchEvent`
- `useWebSocket` 提供按消息类型订阅的轻量 emitter，或者直接把 `output` 回调传给 `PaneGrid/TerminalPane`
- `layout-change` 不再全局广播，改成局部 prop 或 context 驱动
- 只有跨模块、低频、无强依赖顺序的事件才继续保留 CustomEvent

建议原则：
- 高频数据流：函数回调、局部 store、订阅器
- 中频状态流：query/store
- 低频跨边界通知：CustomEvent

这一步的意义很大。因为它不仅提升性能，还能把问题定位能力拉起来。

### 三、拆 TerminalPane，建立终端核心层和附加能力层
这是第三优先级，也是收益很高的一步。

`TerminalPane` 现在像个万能桶，必须拆。否则每次优化都在和巨型副作用对抗。

推荐拆分：
- `useTerminalCore`
  负责 xterm 实例、write、fit、resize、attach 生命周期
- `useTerminalClipboard`
  负责复制、粘贴、系统剪贴板同步
- `useTerminalMobileInput`
  负责移动端键盘和输入桥接
- `useTerminalDrop`
  负责拖拽路径/上传
- `useTerminalSelection`
  负责选区同步和复制请求

实现重点：
- 终端 write 路径保持最短，不掺杂非核心逻辑
- 所有非必要 DOM 查询从热路径移出
- fit/resize 用统一调度器，不要每个能力模块都能触发
- 能用 ref 存的过程态，不用 React state

这一步做完后，后续再优化输入延迟、移动端键盘、复制体验，成本会下降很多。

### 四、重做终端输出链路，目标是“低延迟且可退化”
这是第四优先级。

现在的链路更偏“先合并再发”。接下来应该改成“按设备和负载自适应”。

大概做法：
- gateway 侧把 `output` flush 调度改成自适应
- 可见前台桌面端：小包高频，优先跟手
- 移动端或后台页：大包低频，优先省资源
- 给前端增加“消费背压”信号，例如终端 write 积压时通知后端放缓
- `sanitizeOutput` 只处理真正需要过滤的序列，避免每 chunk 走重正则
- 评估把 `output` 改成更轻的消息格式，至少让最热路径少一次对象层包装

前端也要配套：
- `TerminalPane` 内的输出缓冲按 `requestAnimationFrame` 驱动，而不是 timer + timer 叠加
- 限制单帧 write 预算，例如每帧最多写固定字符量，超出的排队到下一帧
- 用可见性状态控制 flush 策略

验收指标应明确：
- 连续 10 秒高输出时，输入回显延迟 p95 < 80ms
- 可见终端场景下，帧率明显高于现状
- 长任务数明显下降

### 五、限制布局变化的传播范围和频率
这是第五优先级。

当前 resize 相关逻辑最大的问题不是“有监听器”，而是“监听后直接改全局状态”。

大概做法：
- 拖拽过程中的宽高只写 ref 或局部 state
- 拖拽结束后再提交到全局 store 做持久化
- `tmuxgo-layout-change` 改为合并触发，不在 mousemove 每帧广播
- `TerminalDock/DesktopWorkbench` 的尺寸变化统一走 `requestAnimationFrame`
- 终端 fit 加最小变化阈值，例如尺寸不变或变化极小则不重新 fit

移动端额外建议：
- `ConsoleLayout` 的 viewport 同步做单入口收敛
- `resize`、`visualViewport.resize`、`focus/pageshow` 不要各自直接触发完整同步
- 把“键盘打开”和“视口变化”逻辑分离，不要互相套娃

### 六、压缩文件面板对主线程和网络的占用
这是第六优先级。

文件系统能力不是主卖点，但它和终端共享同一页面，必须防止它拖慢终端。

大概做法：
- 目录树改成懒加载 + 节点级缓存，不让同一目录反复请求
- 大目录列表做虚拟化或至少分片渲染
- 搜索输入做更强的 debounce 和 cancel
- 预览和树展开分优先级，终端活跃时降低文件面板刷新优先级
- 大仓库下增加“只显示前 N 项并提示继续筛选”的降级策略

### 七、建立真实的性能观测和回归基线
这是必须做，不是可选项。

大概做法：
- 在前端埋点：
  - attach 开始到首屏可输入耗时
  - 输入到首个 echo 回显耗时
  - 每分钟长任务数量
  - output backlog 长度
  - layout fit 次数
- 在 gateway 埋点：
  - 输出 chunk 平均大小
  - flush 次数
  - sanitize 耗时
  - attach/resize/input 消息频率
- 增加自动化脚本：
  - 模拟高输出 tmux pane
  - 统计浏览器 Performance Timeline
  - 记录优化前后对比

没有这层，后面所有“感觉快了”都不可信。

## 推荐实施顺序
### P0
1. 清理 zustand 双写，缩小全局 store 职责边界
2. 修正整包订阅，所有组件改 selector 化
3. 终端 `output` 路径去掉全局 CustomEvent 广播
4. resize 拖拽过程不再每步提交全局状态

### P1
1. 拆分 `TerminalPane`
2. 重写输出 flush 策略，建立前后端协同缓冲
3. 收敛 `ConsoleLayout` 的移动端视口同步逻辑
4. 文件面板增加目录缓存和分段渲染

### P2
1. 加入性能埋点和基线脚本
2. 对大输出、大目录、移动端键盘场景做专项压测
3. 视情况把 session snapshot 从 HTTP query 进一步收敛到 websocket 增量事件

## 可以直接开工的改造清单
### 第一阶段
- 把 `SessionPanel` 从 `useConsoleStore()` 改成 selector 订阅
- 把 `ConsoleLayout` 中 `sessions/windows/panes` 的 store 同步剥离
- 为 `PaneGrid` 和 `TerminalPane` 建立局部 output subscriber
- 把 `TerminalDock/DesktopWorkbench` 的拖拽尺寸更新改为 rAF + end commit

### 第二阶段
- 把 `TerminalPane` 拆成 4 到 5 个 hook
- 把复制粘贴、拖拽、移动端输入从终端 write 热路径中移出
- gateway 侧增加输出 chunk 指标和 flush 指标

### 第三阶段
- 文件树做缓存和虚拟化
- 建立性能压测页面或 e2e 基准脚本
- 根据指标再决定是否继续做协议层优化

## 风险判断
### 最大风险
最大风险不是“优化难”，而是继续在现有结构上直接堆功能。那样会让每个新功能都默认接入全局 store 或全局事件，最终把流畅性问题固化成架构问题。

### 改造风险
最大的改造风险在 `TerminalPane` 拆分和消息链路收敛，因为这会影响 attach、copy/paste、mobile keyboard、drop/upload 等边缘交互。这里必须分阶段做，并配套回归测试。

### 回报判断
如果只允许做一轮优化，最值的是：
- 状态边界收缩
- 终端 output 直连
- resize/fit 降噪

这三项做完，整体顺滑感通常就会有最明显提升。

## 最终判断
这个项目要提升流畅性，核心不是“再加几个 debounce”或者“调一调 xterm 参数”，而是要把数据流、事件流、终端热路径、布局传播链这四条主线重新收紧。现在项目已经过了“能不能做出来”的阶段，下一步必须进入“能不能长期稳定顺滑地跑”的阶段。再停留在现有结构上加补丁，就是典型的 3.25 做法，短期省事，长期一定反噬。

真正该做的是先砍掉无效传播，再缩短热路径，再建立指标闭环。这个顺序不能反。
