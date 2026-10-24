# Herdr 竞品调研（v0.9.5 实测）

> 状态：**调研文档**（不含实现）
> 创建：2026-10-25
> 实测对象：herdr 0.9.5（protocol 22，单二进制，~/.local/bin 安装，自研 multiplexer 非 tmux）
> 实测方法：本机安装 → TUI 实际运行 → `herdr --skill` / `--default-config` / 全子命令 help / `api snapshot` / `agent explain` 逐项核对
> 结论速览：

| 领域 | herdr 做法 | 我们现状 | 差距 |
| --- | --- | --- | --- |
| agent 状态检测 | per-agent TOML manifest + 本地 override + **远程 manifest 热更** + `agent explain` 解释 | 同款 manifest/TOML（词面即借自 herdr，见 `agent-screen-rules.ts:6-8`） | 缺**解释工具**与**热更通道** |
| agent 编排原语 | `agent start/prompt --wait/wait --until/pane wait-output` + **用户命名 agent** | `panes/{split,read,snapshot,wait-output,run}` + `agent/{wait,start,prompt,cancel}` 全有（`routes/agent-control.ts:122-400`） | 缺**稳定命名**、prompt 的 **stalled 活动门**、`recent-unwrapped` 读屏档 |
| hook 上报 | `integration install <agent>` 一键注入官方 hook，agent 自报 session ref → `resume_agents_on_restore` | 手动配 hook（`docs/architecture/agent-push.md`），recovery 靠 argv 反推 | 缺**一键安装**通道 |
| workspace=repo | 侧栏自动显示 branch/git_status；`worktree create/open` 一等命令，1 worktree = 1 workspace | `GitWorktreeRecord` 已有 `sessionId/workspaceId` 绑定（`lib/git-worktree.ts:16-22`） | 数据模型已备，**产品化闭环**差一层 |
| 通知闭环 | `prefix+o` 跳通知源、attention 排序、提示音可按 agent 静音 | fleet/tasks/未读拆分已建（v2），跳 pane 已有 | 缺**通知音**；排序方向一致互相印证 |
| 远程/凭据 | machine profile 只存 label/target/session，**凭据归 OpenSSH** | `hosts.json` 存 password/passwordEnv | 边界声明不同，可借鉴文档姿态 |
| 端型 | 纯 TUI（手机只能 SSH） | Browser/PWA/mobile | 我方护城河，见 §8 |

## 0. 已吸收面（先记清，避免重复立项）

以下能力已存在，不要当成新需求：

- **检测 manifest 体系**：`lib/agent-screen-rules.ts:6` 注释明确「借鉴 herdr 的 per-agent detection manifest」，词面来自 `herdr distribution/agent-detection/*.toml`；本地 override 目录 `~/.tmuxgo/agent-detection/*.toml` 语义同 herdr（`:266-437`）。
- **控制面编排原语**：`/v1/control/panes/{split,read,snapshot,wait-output,run}`、`/v1/control/agent/{wait,start,prompt,cancel}`（`routes/agent-control.ts:122-400`）。`agent/wait` 是 occupant-pinned（`OCCUPANT_CHANGED`），语义比 herdr 的「名字跟 occupant」更严谨（互补）。
- **审计自律**：`agent.start/prompt` 审计只记 action/paneId/provider/结果码，prompt 正文不落盘（`routes/agent-control.ts:230-233`）。
- **MCP 面**：`apps/mcp` 暴露 `pane_snapshot/wait_output/run` + `browser_*` + `push_*`，但**未暴露 `agent_start/prompt/wait`**（见 §3 差距 4）。
- **worktree 绑定模型**：`lib/git-worktree.ts:16-22` 的 `GitWorktreeRecord` 已带 `sessionId/workspaceId`，`routes/git.ts:741-782` 建链接受两字段。
- **seen 语义**：herdr「Done badge per-client 独立」与我们 inbox `readBy deviceId` 同构，不需动。

## 1. agent explain —— 检测可解释性（最值得抄）

herdr 实测输出：

```text
$ herdr agent explain <pane>
agent: devin
state: idle
manifest: bundled 2026.06.15.1
rule: none
fallback_reason: default_known_agent_idle_fallback
```

一次回答「判定走了哪条规则、manifest 版本、为什么 fallback」。我们的 `detectAgentPaneState`（`lib/agent-state.ts:340`）命中过程不可见，调屏幕规则只能反复试。

**建议**：判定函数返回结构化 `reason`（manifest 版本 + 命中 rule id/priority + fallback 名），挂到 `agent_state` 冷字段（不进 stream 热路径，符合 observability-v2 §0 约束），CLI 加 `tmuxgo-ctl agent explain <pane>`，fleet 面板行展开时展示。改造成本低：判定链路本来就是顺序匹配，把命中点带出来即可。

## 2. detection manifest 远程热更（次值得抄）

herdr config：`[update] manifest_check = true` —— 后台检查 herdr.dev 的 detection manifest 更新，**规则表不进 release**。

背景：Claude Code/Codex 前端 UI 改版频繁，bundled 规则滞后是常态。我们现状 = bundled + 用户手写 TOML override（`agent-screen-rules.ts:266`），没有下发通道。

**建议（克制版）**：`~/.tmuxgo/agent-detection/` 已天然是 override 位——加一个可选的「同步远端 manifest 到该目录」的 pull（版本戳 + 签名校验 + 失败回落 bundled，复用 `update-checker.ts` 的通道骨架）。**不做 push、不做远程执行语义**，纯数据表。可配置默认关。

## 3. 编排原语差距对照

| herdr 能力 | 实测语义 | 我们现状 | 建议 |
| --- | --- | --- | --- |
| `agent start reviewer --kind codex` | 用户命名，名字跟 occupant；Ctrl+Z 保身份，被其他 agent 顶替才释放 | start/wait 用 `sessionName+agent` 定位（`skills/tmuxgo-control/SKILL.md:56`） | `@tmuxgo_agent` pane user-option 存名，复用 `@tmuxgo_task` 的读写通道（T-234 已建），wait/prompt 接受名字 |
| `agent prompt --wait` | 提交后 **5s 内必须观察到 working/blocked**，否则 `agent_prompt_stalled` | `agent/prompt` 有 `ackTimeoutMs` + opId ack（`routes/agent-control.ts:348`），无「提交后活动门」 | prompt 结果加 `activityObserved:bool` 或 stalled 错误码 |
| `agent read --source recent-unwrapped` | 软换行合并成逻辑行，适合日志转录 | `panes/read` 按行抓 | 加 `unwrap:bool`，join 连续行 |
| `agent send-keys esc ctrl+c` | 逻辑键名全量预校验再写字节 | `panes/run` 走 send-keys 直译 | ctl 层加键名表，复用 tmux key names |
| MCP 暴露面 | herdr CLI = 全原语 | `apps/mcp/index.mjs` 无 `agent_start/prompt/wait` | 补 3 个 tool，鉴权走已注入 env（同现有 pane_*） |

**skill 契约可抄的写法**（`herdr --skill` 原文，值得进 `skills/tmuxgo-control/SKILL.md`）：

- `timeout 不证明 prompt 未送达，不要盲重发`（我们有 OCCUPANT_CHANGED 但 skill 没写这条陷阱语义）
- `连接失败不证明 mutation 未应用：先查远端状态再重试`
- `agent_blocked = agent 停在审批/提问 UI，先读屏再决定发什么键，不要替用户答`

## 4. workspace = repo 感知 + worktree 一等公民

- herdr 侧栏 space 行自动显示 `branch + git_status`（实测 TUI 确认）；我们 workspace 是纯容器。
- `worktree create --focus` / `open` / `remove`，1 worktree = 1 workspace，`workspace close --group` 联动关闭。「每个 agent 一个 worktree」并行流是原生原语。
- 我们：`GitWorktreeRecord.sessionId/workspaceId` 绑定字段已落（`lib/git-worktree.ts:16-22`），`CreateSessionDialog`/`GitPanel` 已接 worktree——**缺口在反向**：session/workspace 侧栏展示 `branch/git_status` chip（数据源 `git status --porcelain` 已有 executor），以及「worktree 移除 → 关联 session 处理」的闭环策略。

## 5. 通知闭环细节

| 细节 | herdr | 我们 | 建议 |
| --- | --- | --- | --- |
| 跳通知源 | `prefix+o` open_notification_target | 通知点击跳 pane 已有 | 补全局快捷键项进 CommandPalette |
| 提示音 | `[ui.sound]` per-agent 可静音，done/request 不同音 | 无 | web 端 Notification/Audio，低成本高感知 |
| attention 排序 | `agent_panel_sort="priority"`：blocked 置顶 | fleet 默认排序同向（observability-v2 §3.4） | 已对齐，无需动 |
| toast 通道 | in-app / OSC 终端 / OS 三档 | web push + in-app | 已够 |

## 6. 边界/安全姿态（文档层面可借鉴）

- `machine` profile 只存 label/ssh-target/session/enabled：`SSH credentials and key material remain owned by OpenSSH`。我们 `hosts.json` 存 password/passwordEnv 是功能需要，但**文档应该写清这个边界声明**（哪些进文件、权限位、轮换路径）。
- `machine reconnect` 规则：SSH auth 由**用户在自己终端完成，agent 不得代输密码**——写进 skill 的权限条款，我们 skill 可补同款。
- `update --handoff`：升级时无缝接管运行中 server。对应我们 `restart-task.ts`/`shutdown-sequence`——snapshot-on-shutdown 已有，可补「重启后自动 re-attach 提示」的产品化。

## 7. TUI 工程细节 → web 端可选项

| herdr 项 | 语义 | 我们的映射 |
| --- | --- | --- |
| `headless_cols/rows` | 无 client 时虚拟终端尺寸 | detached attach 的窗口尺寸策略，核对 `terminal-attachment.ts` 是否一致处理 |
| `switch_ascii_input_source_in_prefix` / `reveal_hidden_cursor_for_cjk_ime` | IME 兼容工程 | web 端 xterm.js IME 组合事件已归浏览器管，**移动浏览器 CJK 输入仍值得实测一遍** |
| `pane input --right-click herdr|pane` | 右键归谁可配 | 右键菜单 vs 终端应用 mouse capture，同语义可配 |
| `scrollback_limit_bytes` 10MB/pane | 服务端 scrollback 预算 | 我们是 tmux `history-limit`（capability-matrix §4 建议显式 set-option），落实它 |

## 8. 我方护城河（调研后更清晰的差异化）

herdr 自研 multiplexer 意味着这些它永远要重造、我们天生有：

- **tmux 生态兼容**：接管既有 session、`.tmux.conf`、原生 tmux client 与浏览器共存同一现场
- **Browser/PWA/mobile**：它在手机上只能 SSH 进终端，我们是浏览器工作区
- **Files/Monaco/Git workbench**：它编辑靠 pane 里的 TUI editor
- **cell diff/snapshot 传输协议**：它本机渲染不需要，远端走 SSH 时它就是纯 SSH——我们的压缩/增量链路是真优势（仍需 §对比文档的 benchmark 背书）
- **Share link / multi-client 仲裁**：它 `terminal session observe/control --takeover` 有基础共享，无匿名只读链接形态

## 9. 建议落地顺序

| 序 | 项 | 依据 |
| --- | --- | --- |
| 1 | `agent explain`（判定 reason 透出 + ctl 命令 + fleet 展开行） | 成本最低、立刻提升检测可调试性；规则表是发版资产，解释器是它的放大镜 |
| 2 | `agent wait/prompt` 补 stalled 活动门 + MCP 补 `agent_*` 3 个 tool | 控制面已有，纯增量；MCP 暴露面对齐 CLI 是明显缺口 |
| 3 | `@tmuxgo_agent` 用户命名（复用 `@tmuxgo_task` 通道） | T-234 模式已验证，agent 名比 paneId 更适合编排脚本 |
| 4 | 通用 pane watcher（`monitor-silence`/`bell`/regex → push） | herdr 无此物（它的 wait 是会话内同步等待），是我们能做它不能做的差异化项 |
| 5 | `recent-unwrapped` 读屏档 | 一行 join 逻辑 |
| 6 | detection manifest 远端同步（可选、默认关） | 等有真实「规则滞后」事故再做不迟 |
| 7 | worktree↔workspace 反向闭环（branch chip + 移除策略） | 数据模型已备，补 UI |

不做：自研 multiplexer（放弃 tmux 底座等于放弃全部护城河）、TUI 端（浏览器已覆盖）、它的凭据边界照搬（我们 passwordEnv 是有意为之的多 host 场景）。

## 10. 实测证据索引

| 证据 | 来源 |
| --- | --- |
| 功能面 | `herdr --help`、`herdr {agent,pane,workspace,tab,worktree,notification,session,machine,integration,api,terminal}` 子命令 help |
| agent 检测/命名/skill 契约 | `herdr --skill`（214 行 agent 手册） |
| 配置面（manifest 热更、sound、sidebar tokens、IME、ssh 管理） | `herdr --default-config`（380 行注释配置） |
| 数据模型（agent_status 逐层聚合、scroll/revision/seq 令牌、agent_session 上报） | `herdr api snapshot` JSON |
| 检测解释 | `herdr agent explain <pane>` 实测输出（§1） |
| 23 种 kind | `herdr agent` help 的 kinds 列表 |
| TUI 实机 | tmux `test` session 内运行：侧栏 space 行自动带 `repo名/branch`；`prefix+?` keybinds overlay |

本文不含真实主机名/路径/凭据；示例统一 `devbox`、`/home/user`。
