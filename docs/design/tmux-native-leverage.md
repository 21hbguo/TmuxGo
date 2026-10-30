# tmux 原生能力盘点：把护城河放回 tmux 身上

> 状态：定界稿（未实施）
> 基线：master `fa119f3`，本机 tmux 3.4
> 结论先行：TmuxGo 的护城河不是「浏览器终端」，是 **tmux 服务端那台会话状态机**。
> 产品应该是它的投影面——每加一个功能，先问「这是 tmux 已有的语义，还是我在 JS 里重写了一遍？」

## 0. 为什么是 tmux，而不是终端或 agent

浏览器终端（ttyd/GoTTY/WeTTY）只投影字节流：关掉页面，进程就没了。
TmuxGo 投影的是 tmux server：会话、窗口、pane、布局、滚动缓冲、缓冲区、客户端连接，全都活在 server 里，
浏览器只是一个可丢弃的 client。**这一层别人要补，得先写一个 tmux**。

因此功能判断标准只有一条：**是否把 tmux 已有的状态/事件/原语暴露得更彻底**。
在 JS 里重新实现 tmux 的职责（会话表、布局树、剪贴板、注意力检测），做得再好也是二流模仿。

## 1. 已经吃到的（有代码为证）

| tmux 原语               | 项目里的用法                                         | 证据                                                 |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| user options `@...`     | 任务号 `@tmuxgo_task` 存在 pane 上，跨刷新/重启/交接 | `lib/pane-task.ts:16`；`lib/fleet.ts:22`             |
| hooks `set-hook -g -a`  | pane/agent 事件回写 gateway，不靠纯轮询              | `lib/tmux-hooks.ts:75`                               |
| `remain-on-exit failed` | pane 根进程异常退出后保留现场，可解释死因            | `lib/tmux-policy.ts:89`                              |
| formats `#{...}`        | 一次 `list-panes -F` 取全字段（cwd/命令/标题/task）  | `lib/agent-state.ts:543`                             |
| `capture-pane` 滚动缓冲 | 服务端历史搜索（前端 xterm 只有已挂载部分）          | `lib/pane-search.ts:5,159`                           |
| `select-layout` + 尺寸  | 模板/布局文档的近似恢复                              | `lib/session-layout-apply.ts`；`routes/templates.ts` |
| 会话快照                | 关停时保存拓扑，供恢复                               | `lib/session-snapshot.ts:457`                        |
| 多客户端尺寸仲裁        | `list-clients` + 虚拟视口，避免抢尺寸                | `lib/stream/shared-terminal.ts:40`                   |

这一列说明：底座不弱。但基本都是「读 + 少量写」，**tmux 的写入面（拓扑编辑、缓冲区、跨客户端视图、信号）几乎没动**。

## 2. 还没吃到的（按「别人抄不走」排序）

| 原语                                                             | 能变成什么                                                                                              | 为什么抄不走                                                        | 成本                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| **grouped sessions**（`new-session -t`）                         | 同一 workspace 的多端**独立视角**：手机盯 window 3 的日志，桌面留在 window 1 敲命令，互不抢「当前窗口」 | 需要真正的会话复用语义；单 PTY 方案要么共享焦点，要么自己写多路复用 | 大（改 attach 模型） |
| **buffers**（`set-buffer`/`paste-buffer`）                       | 跨设备剪贴板与片段库：桌面复制 → 手机粘贴；刷新/换设备仍在                                              | 缓冲区在 server 上，不依赖浏览器或 OS 剪贴板同步                    | 小                   |
| **`wait-for` 通道**                                              | 跨 pane/跨进程信号：脚本、agent、CI 都能 `wait-for -S` 互相同步，网关挂了也成立                         | 是 tmux 内建的同步原语，不需要额外 broker                           | 小                   |
| **`pipe-pane`**                                                  | 长跑会话的持久录制：按 pane 落盘、可下载、可离线 grep，不占浏览器带宽                                   | 录制发生在 server 侧，页面关掉也在记                                | 中                   |
| **拓扑编辑**（`break-pane`/`join-pane`/`swap-pane`/`move-pane`） | 拖拽把 pane 挪到另一个窗口/会话；布局像积木一样重组                                                     | UI 直接操作 tmux 拓扑，不是自己维护一棵树再对齐                     | 中                   |
| **原生 layout string**（`#{window_layout}` + `select-layout`）   | 精确克隆/迁移布局（含分割比例），跨 host 复制工作区                                                     | 布局字符串是 tmux 的规范表示，比按尺寸近似稳                        | 小                   |
| **`respawn-pane -k`**                                            | 失败 pane 原地重启：位置、任务号、滚动历史槽位都保留                                                    | 保住 pane 身份，和「杀掉再开一个」是两种心智                        | 小                   |
| **alert/monitor hooks**                                          | 注意力信号来自 tmux（activity/bell/silence），减少抓屏启发式                                            | 事件在 server 侧产生，不依赖轮询频率                                | 中                   |
| **受控命令面**                                                   | 命令面板直接执行 tmux 命令（argv 白名单 + 审计 + scope）                                                | 用户拿到的是 tmux 全部能力，而不是我们挑出来的子集                  | 中                   |

## 3. 建议切片（一次只切一刀）

**S1（先做，1–2 天量级）**：buffers 剪贴板 + `respawn-pane -k` 原地重启。
理由：一个解决「跨设备」，一个解决「救火」，都直接落在 tmux 状态上；且都不动 attach 模型。
剪贴板必须显式触发（用户点「存入 tmux 缓冲区」），不做自动上传——server 侧留存等于多一份敏感数据。

**S2（差异化最大，先做 spike）**：grouped sessions 多端视角。
先验证三件事：能否给每个 web client 建一个隐藏 grouped session、pane 输出如何按 client 订阅、
切窗口事件如何只影响本 client。spike 不通过就退回「同 session + 焦点租约」，不硬上。

**S3（可迁移性）**：原生 layout string 入 layout 文档 v2 + 拖拽拓扑编辑（break/join/swap）。
把「工作区」变成可复制、可迁移、可分享的东西。

**S4（自动化底座）**：`wait-for` 信号 + `pipe-pane` 录制。
前者给脚本/agent 一条不依赖网关的同步通道，后者给长跑任务留证据。

## 4. 红线

- 不重写 tmux 的职责：会话表、布局树、缓冲区、客户端列表都以 tmux 为唯一权威源，gateway 不落第二份。
- 不为了「原生」绕过鉴权：命令面必须 argv 白名单 + host/session scope + 审计，禁止 `run-shell`/`source-file` 之类逃逸口。
- 不做「兼容所有 tmux 版本」的分支：按 `detectTmuxVersion()` 做能力探测，低于基线明确降级并提示。
- 不把 UI 变成 tmux 配置编辑器：只做常用拓扑与缓冲区，`~/.tmux.conf` 的深水区留给终端。

## 5. 验收（每个切片共用）

1. 行为在真机 tmux 上可复现，且只动名为 `test` 的会话（测试约束）。
2. 关掉浏览器/重启 gateway 后，状态仍在（证明权威源是 tmux，不是内存）。
3. 老客户端不调用新能力时行为零变化；能力探测失败有明确降级路径。
4. 单测覆盖参数构造与边界，路线测试覆盖守卫与 scope；契约文档同步。
