# Dinotty 吸收报告

## 结论

Dinotty 最值得吸收的不是 Rust、Vue 或完整 VTE 实现，而是把终端当作可恢复、可授权、可观测服务的边界设计。TmuxGo 已以 tmux 作为会话真源，适合吸收其协议、权限和验证方法；不应替换为第二套 PTY/VTE 会话系统。

## 调研依据

- 来源：<https://github.com/xichan96/dinotty>
- 分支与提交：`dev` / `bd65a2a635d4dbaaf33ba41ac2cdf3f2b2f4ece3`，2026-07-19
- 关键材料：`src/ws/mod.rs`、`src/session/mod.rs`、`src/pty.rs`、`src/token.rs`、`src/openapi.rs`、`src/event_bus.rs`、`src/audit.rs`、`tests/terminal_exit_regression.rs`、`bench/freeze_detect.py`
- 当前 TmuxGo 对照：`src/routes/stream.ts` 已有输出合并、背压与 `capture-pane` 回退；`src/routes/windows.ts` 已提供 session snapshot；`src/index.ts` 已注册全部管理与文件写入路由，但未注册鉴权中间件。

## 优先级

| 优先级 | 吸收项 | 价值 | 最小落地范围 | 验收条件 |
|---|---|---|---|---|
| P0 | 统一鉴权与能力范围 | 网关暴露 tmux、文件、Git 与重启操作，必须先明确调用者和可操作资源 | HTTP 与 WebSocket 统一验证；区分 `terminal:read`、`terminal:write`、`session:manage`、`file:read`、`file:write`、`git:write`、`system:restart`；token 可限定 host/session/pane | 未认证 HTTP/WS 返回 401；只读 token 不能写文件或发送按键；限定 pane 的 token 不能操作其他 pane |
| P0 | 可恢复的流协议 | 断线、切换设备和 resize 时不能把旧输出写到新屏幕状态，避免“已连上但画面错位/冻结” | 在现有 tmux snapshot 上定义 `reconnected`、`snapshot_request`、`replay_begin`、`replay_end`；snapshot 前暂停该客户端实时输出，完成回放后再放行 | 网络中断后重连可恢复相同 pane；反复 resize 后无残留旧字符；回放边界内不出现实时输出穿插 |
| P1 | 面向 Agent 的结构化 API | 将当前“模拟键盘输入”升级为可审计、可自动化的终端能力，供 Codex、CI 和外部工具稳定调用 | `read`、`send`、`run` 三个接口；`read` 复用 tmux capture；`run` 先只支持明确 target 与超时；并发上限按 token 统计 | 请求获得统一 JSON 错误；超时可区分；同 token 超过并发上限返回 429；输出与目标 pane 可追溯 |
| P1 | 事件总线、审计与 Webhook | 去除各路由各自记录状态的耦合，让通知、监控与外部自动化订阅同一事实 | 发布 `session_created`、`session_closed`、`pane_changed`、`command_finished`、`file_changed`；审计采用追加 JSONL；Webhook 只消费事件并使用 HMAC 签名 | 终端写入、文件写入、Git 写操作均产生审计记录；慢 webhook 不阻塞主请求；签名可被接收端验证 |
| P2 | 输出链路的有界背压和同步恢复 | 现有 `stream.ts` 已有 socket watermark，是正确起点；还需定义积压、UTF-8 分片和同步输出的确定行为 | 每客户端有界队列；高水位触发降频或请求重同步；保留 UTF-8 尾字节；对同步输出设超时 watchdog | 慢客户端不拖慢其他客户端；极端积压后收到 resync 而非永久停屏；多字节字符不产生乱码 |
| P2 | 长连接回归与压测基线 | 终端问题常由时序触发，手工验证不能覆盖退出、静默、重连和多客户端 | 增加服务启动 smoke、pane 退出通知、断线重连回放、慢客户端背压四类测试；提供长连接 freeze detector | CI 覆盖四类场景；压测输出包含最大静默时间、消息数、字节数、重连数与失败数 |
| P3 | 插件与命令面板扩展点 | 可为工作流、命令收藏、Agent 控制提供可演进的 UI 扩展，但会引入第三方代码执行边界 | 仅在前端需求稳定后设计受限 manifest、显式 permission 与按插件隔离的存储 | 插件默认无终端写权限；权限提升有确认；卸载后事件监听和命令注册被清理 |
| P3 | 工作区预览与 SSH/SFTP 产品能力 | Dinotty 的文件浏览、预览、反向代理和 SSH/SFTP 完整，但 TmuxGo 已有文件/Git/host 基础，不宜整体搬运 | 按用户需求单点补齐，不把它作为网关稳定性改造的前置依赖 | 每个功能独立授权、路径限制和端到端测试 |

## P0: 统一鉴权与能力范围

Dinotty 的可迁移模式是“全局管理 token + 可撤销的细粒度 token”：原始 token 只在创建时返回，持久化仅保存哈希、前缀、能力、作用域、过期时间和最后使用时间。验证按 Bearer token、常量时间比较、哈希查找、撤销和过期检查依次进行。实现见 `src/token.rs`，接口说明见 `docs/token-system.md`。

TmuxGo 的风险更直接：`src/index.ts` 中 CORS 为 `origin: true`，且 HTTP 路由和 `/stream` WebSocket 均未挂鉴权；同时项目已依赖 `@fastify/jwt`。应先把鉴权定义为所有 API 与 WS 的共同前置条件，再增加 scope，而不是让每个路由自行判断。

建议的 scope 以现有资源模型为界：host、session、window、pane、工作区根目录。不要照搬 Dinotty 的 token 存储格式或 Rust 实现，保持 Fastify 的插件/`preHandler` 风格即可。

## P0: 可恢复的流协议

Dinotty 的关键协议是“先适配尺寸，后发快照”。重连后服务端只发送连接状态；客户端以最终 cols/rows 发送 snapshot 请求；服务端在一个事务中 resize、取得 scrollback/snapshot，并严格发送 `ReplayBegin -> 回放数据 -> ReplayEnd -> 新实时输出`。回放期间该客户端不接收实时输出，因为其效果已经包含在快照中。实现见 `src/ws/mod.rs` 与 `src/session/mod.rs`。

TmuxGo 不需要引入服务端 VTE：tmux 已保存会话，`src/routes/windows.ts` 的 snapshot 与 `src/routes/stream.ts` 的 `capture-pane` 足以作为权威屏幕来源。需要吸收的是状态边界和顺序保证，尤其是 attach、resize、刷新、网络重连并发时的序列号或 generation 校验。

## P1: 面向 Agent 的结构化 API

Dinotty 将终端分为同步 `run`、异步 `send`、屏幕 `read` 与事件 WebSocket 四种交互，并规定错误格式、权限和每 token 并发上限。`run` 优先利用 OSC 133 的命令开始/结束标记，缺失时才按 prompt 兜底，详见 `docs/agent-api.md`、`src/openapi.rs`、`src/vt_screen.rs`。

TmuxGo 已有 tmux 目标解析和 `capture-pane`，因此应先提供稳定的 `read` 与 `send`。`run` 只有在能可靠取得命令边界、退出码和超时语义后才加入；不能把“向 pane 输入一行”伪装成已完成的同步执行。

## P1: 事件、审计与 Webhook

Dinotty 用有界广播事件总线让会话、Agent API、Webhook 和插件从同一事件流消费；审计用异步追加 JSONL，Webhook 使用事件过滤与 HMAC 签名。参考 `src/event_bus.rs`、`src/audit.rs`、`src/webhook.rs` 与 `docs/audit-webhook.md`。

TmuxGo 应保持事件载荷小且稳定：`event`、`at`、`actor`、`resource`、`requestId`、`result`。审计记录必须避免写入 token、密码、完整文件内容和大段终端输出。Webhook 必须异步投递、限时、重试有上限，且失败不得影响终端请求。

## P2: 输出正确性与测试

Dinotty 对终端输出采用批量读取、UTF-8 尾字节保留、每客户端非阻塞投递、同步输出 watchdog 和失速重同步。`src/pty.rs` 中的 silent-PTY watchdog 说明：只在“有新输出”时检查超时，会导致半截重绘永久卡住；超时检查必须独立触发。

其测试方法比具体代码更值得吸收：`tests/terminal_exit_regression.rs` 启动真实服务、创建真实 WebSocket、验证 PTY 退出消息和资源清理；`bench/freeze_detect.py` 按客户端统计字节量、消息量、最大静默时间和 freeze 次数。TmuxGo 应为每个已修复的时序问题保留可复现回归测试，而非仅加日志。

## 明确不吸收

- 不引入 Dinotty 的 `portable-pty`、服务端 VTE、Tab/Pane 生命周期管理。Tmux 已经是 TmuxGo 的会话真源，双状态机会制造恢复与尺寸竞争。
- 不引入完整插件市场、动态执行任意 JS、插件 CLI 桥接。鉴权与事件模型未稳定前，这会扩大远程代码执行面。
- 不复制 Rust/Axum、Vue/Tauri 或跨平台打包层。它们与当前 Node/Fastify 网关架构无关。
- 不把 SSH/SFTP、Office 预览、网页代理等产品功能插入 P0/P1；它们不能解决现有终端服务的安全和一致性问题。

## 推荐实施顺序

1. P0 鉴权与 scope，覆盖 HTTP、WebSocket、文件、Git、系统操作。
2. P0 回放协议，先为本地 tmux attach/resize/reconnect 建立确定性测试。
3. P1 Agent `read`/`send` API、审计和事件总线，再评估 `run` 的命令完成检测。
4. P2 背压、失速恢复和压测，使用实际移动网络与多客户端场景验证。
5. P3 只按明确产品需求进入，且复用已完成的 scope、审计和事件机制。
