# Herdr 生命周期与远程模型工程细节（v0.9.5 实测）

> 状态：**调研文档**（不含实现）
> 创建：2026-10-25
> 实测对象：herdr 0.9.5，protocol 22（`herdr --version`、`herdr status --json`）
> 实测方法：`--help` / `--skill` / `--default-config` / `api schema --json` 静态面 + `herdr --session probe-p4` 独立 session 实机（创建 workspace → `session stop` → 重启 → 观察 restore）
> 与 `herdr-competitive-analysis.md` 的分工：那份给全局面，这份只挖**关停/重启/升级/远程**的工程机制；§6/§8 的凭据与护城河结论不重复，只在需要时引用。
> 本文不含真实主机名/凭据；示例统一 `devbox`、`/home/user`。

## 0. 结论速览

| 机制 | herdr 做法（证据） | TmuxGo 现状 | 结论 |
| --- | --- | --- | --- |
| 升级接管 | `update --handoff` → `server.live_handoff{expected_version,expected_protocol,import_exe}`，fd 继承把活 pane 交给新二进制 | `restart-task.ts` 重跑 `start.sh --restart --rebuild --preserve-tmux`，靠 tmux 兜住 pane | **不抄**（底座不同，收益≈0） |
| 状态落盘 | `session.json`（`"version": 3`）+ 覆盖前 `session-snapshots/` 恢复副本；restore 时逐 workspace 重建 + 可选 resume agent | 关停 L1 快照（`session-snapshot.ts:18-33`），restore 是用户显式动作 | 抄**「覆盖前留恢复副本」**与**schema version 校验** |
| agent 恢复 | 官方 integration 在 SessionStart 上报 `pane.report_agent_session{agent_session_id, resume_argv}`；server 端 `resume_agents_on_restore` + `startup_per_agent_delay_ms` 自动续 | `agent-recovery.ts` 从原生 session id + **代码内 provider 白名单**拼 argv，人工点 resume | 抄**「一次性恢复节流」**；argv 由 agent 自报**不抄**（注入面） |
| 远程 SSH | 生成 ssh config（先 Include 用户 config，keepalive 仅兜底）+ 私有 per-attach control socket（0700、拒绝 symlink）+ 凭据完全归 OpenSSH | `ssh-options.ts:44-56` ControlMaster=auto/ControlPersist=600；`tmux-executor.ts:186-206` 命令行硬设 keepalive | 抄**「用户配置优先」**姿态与 socket 目录校验；凭据边界**不抄** |
| 版本协商 | 整数 `protocol` + `capabilities` map + `compatible`/`restart_needed`/`server_binary_stale` 三类**分离**信号 | 控制面 `CONTROL_PROTOCOL_VERSION='v1'` 握手已完备；REST/binary 各有版本 | 抄**`restart_needed` / `server_binary_stale` 分离**（我们只有 git 侧 behindBy） |

## 1. update --handoff：fd 继承式接管

静态面：

- `herdr update --handoff`：`Try live handoff after installing`（`herdr update --help`）
- API：`server.live_handoff` 参数 `{expected_protocol?: uint32, expected_version?: string, import_exe?: string}`（`herdr api schema --json` → `request.$defs.ServerLiveHandoffParams`）
- server capability：`herdr status --json` → `server.capabilities.live_handoff: true`

行为面（二进制内字符串，`strings $(which herdr)`）：

- 交接走**继承 fd**：`herdr-handoff-`、`handoff fd message carried …`、`handoff import did not consume …`、`failed to spawn handoff import server at …`
- 版本门是**双向校验**：`handoff expected herdr v…`、`handoff expected protocol …`、`unsupported handoff version …`
- **失败可回滚**：`endpoint handoff was rolled back`、`live handoff failed, but … is still running with your panes.`、`handoff replacement server did not become ready:`
- 非交互更新**不擅自停旧 server**：`not stopping the old server from a non-interactive update; run … when you are ready.`
- `herdr --skill:211`：`Client and server versions can differ after an update. Check herdr status before relying on new server features. A missing method is not permission to stop or upgrade a server.`

**为什么我们不抄**：herdr 的 pane 进程是它自己 fork 的，换 server 二进制就必须搬进程树，才有 fd 继承这套复杂度。TmuxGo 的 pane 归 tmux server，gateway 重启时 pane 一个都不动（`shutdown-sequence.ts:20-22` 的关停序列完全不碰 tmux；`start.sh:239` `--preserve-tmux`）。前端断线重连 + resync 已有（`ConnectionBadge.tsx:21`、`STREAM_EVENT.reconnected`）。抄 handoff 等于为一个不存在的故障做工程。

**值得抄的只有它的失败语义**（见 §5 建议 1）。

## 2. 持久化与 restore 语义

实测（`--session probe-p4`）：

1. `workspace create --label p4-probe` → `~/.config/herdr/sessions/probe-p4/` 出现 `session.json`
2. `herdr session stop probe-p4`：进程退、`session.json` 保留
3. 重启 server 后 `api snapshot` 直接返回 `workspaces=[p4-probe]`、`panes=[{cwd:/tmp}]` — **布局 + cwd 自动恢复，pane 进程是新起的**
4. server log：`event="persist.restore" outcome="ok" workspaces=1`；覆盖写之前先落 `persist.backup outcome="ok" backup_path=…/session-snapshots/session-<seq>-<pid>-<n>.json`（`preserved session recovery copy`）

数据结构（`session.json` 实拉）：

```json
{ "version": 3,
  "workspaces": [ { "id": "w1", "custom_name": "p4-probe", "identity_cwd": "/tmp",
    "public_pane_numbers": {"1": 1}, "next_public_pane_number": 2,
    "tabs": [ { "layout": {"Pane": 1},
      "panes": {"1": {"cwd": "/tmp",
        "agent_session": {"source":"herdr:devin","agent":"devin","kind":"id","value":"…"}}} }] } ] }
```

要点：

- **顶层 `version: 3`**：反序列化按版本走，不是靠字段嗅探
- **`agent_session` 与布局同文件**：恢复布局时天然知道哪个 pane 该 resume 哪个会话
- **覆盖前留恢复副本**：写坏了还能从 `session-snapshots/` 捞
- **`public_pane_numbers` / `next_public_pane_number`**：对外编号与内部 id 解耦，恢复后 `w1:p1` 仍是 `w1:p1`
- `[experimental] pane_history = false`（`--default-config`）：**屏幕历史跨重启默认不保**，只保结构。官方注释也写明它是 experimental
- `[session] resume_agents_on_restore = true` / `startup_per_agent_delay_ms = 100`：恢复时逐个 agent 间隔启动，避免 N 个 CLI 同时抢 CPU/网络

TmuxGo 对照：

- `session-snapshot.ts:53-67` 的 `SessionSnapshot`：`kind` 白名单常量 + `version: 1` + `expiresAt` + `degraded[]`，比 herdr 多 **TTL 与降级标注**，`isSnapshot()`（`:82-94`）做结构校验，`readSnapshots()`（`:96-124`）过期即删 + 上限修剪。这一层我们**更严**，不用动。
- `restoreSnapshot()`（`:338-380`）语义写明「进程不会复活，只重放结构 + cwd/命令」，且有半成品清理（`:364-370`）和「同名 session 必须显式 replace」（`:357-359`）。
- 差距：①我们没有「覆盖前备份上一份快照」；②`version` 字段存在但读取侧只查 `kind`（`:86-87`），没按 `version` 分支 —— 未来 v2 会静默按 v1 解读。

## 3. agent 恢复机制对比（最实质的差异）

herdr 是**上报式**，我们是**反推式**。

上报面证据：

- `pane.report_agent_session` 参数：`agent_session_id`、`agent_session_path`、`source`、`seq`，以及
  `resume_argv` —— schema description 原文：`Command that resumes this agent's session after a Herdr restart. The first element must be a plain command name.`
- 官方 hook 实装（`~/.claude/hooks/herdr-agent-state.sh`，herdr 安装、`HERDR_INTEGRATION_VERSION=11`）：只在 `hook_event_name == "SessionStart"` 时把 `session_id` / `transcript_path` 通过 unix socket 发给 `pane.report_agent_session`，**worker/子 agent 直接退出**（`agent_id` 存在则跳过）。上报是「agent 自己知道自己是谁」，零屏幕猜测。
- `herdr integration status` 逐 agent 打 `current (v11)` / `not installed (path)`：integration 本身是可版本化的资产，server 能报出「你的 hook 过时了」。

TmuxGo 对照（`agent-recovery.ts`）：

- `:70-78` `resumeProviders` 表把 `claude --resume <id>` / `codex resume <id>` / `opencode --session <id>` 等**写进代码**；`:181-187` 拼命令时 `agentSessionId` 过 `resumeArgPattern`（`:69`）白名单字符集。加一个新 agent = 改代码 + 发版。
- `:60-62` 候选 TTL 24h / 上限 100 / 文件 `version: 1`；`:103-123` 走 `JsonStore`（0600、原子 rename、`.bak` 回退）—— 持久化纪律比 herdr 更严。
- `:255-300` resume 是**人工触发**，且要过 `pane_occupied` / `pane_in_mode` / `pane_dead` 逐级校验，最后 `send-keys -l` + 单独 Enter（`:288-292` 注释解释了 tmux 3.4 的 `%0` 解析 bug）。**只往空闲 shell 打字**，这个约束比 herdr 强。

判断：

- herdr 的 `resume_argv` 由 agent 上报，等于把「执行什么命令」的决定权交给外部 hook 脚本。herdr 只校验首元素是 plain command name —— 对我们这种「gateway 拿到就能 send-keys 进用户 pane」的形态，这是**不可接受**的注入面。**明确不抄**。
- 可抄的是 `startup_per_agent_delay_ms`：我们要做批量恢复时按 100ms 错开，避免同时拉起 N 个 CLI。
- 可抄的是「integration 版本可见」：`agent-recovery` 目前无法回答「这台机器的 hook 是不是旧版」。若要产品化，给 push hook 加 `hookVersion` 字段并在健康检查里比对。

## 4. 远程 / 凭据边界

herdr 的边界声明（`--default-config` `[remote]` 段原文）：

> `When true (default), herdr runs remote ssh through a generated config that includes your ~/.ssh/config first and adds ServerAliveInterval/ServerAliveCountMax as fallbacks (so any keepalive values you set yourself still win) … Herdr also uses a private per-attach OpenSSH control socket to reuse the first authenticated connection.`

配套实现细节（二进制字符串）：

- `SSH control directory must be owned by the current user, mode 0700, and not be a symlink`
- `SSH control socket path exceeds the Unix socket length limit` / `SSH control socket staging path exceeds the Unix socket length limit` —— 有超长路径的**降级分支**，不是直接失败
- `interactive SSH recovery requires Unix OpenSSH multiplexing; authenticate outside Herdr on this platform` 与 `… requires remote.manage_ssh_config=true` —— 报错直接点出**需要改哪个开关**
- `herdr --skill:105`：`machine reconnect needs the user to complete SSH authentication in their terminal; do not run it for them.`
- machine profile 只存 label/target/session/enabled（`herdr machine add --help` + `--skill:105`），profile id 必须是 32 位小写 hex（二进制字符串 `endpoint profile id must be 32 lowercase hexadecimal characters`）
- `server.ssh_agent.register{socket_path}`：把**远端** agent socket 注册进来，`Registration lasts until this API connection closes`；本机实测 `~/.config/herdr/herdr.sock.agent -> /run/user/<uid>/gnupg/S.gpg-agent.ssh` —— 即「key 用你自己的 ssh-agent，herdr 只借转发通道，不落盘」

TmuxGo 对照：

- `hosts.ts:31-41`：凭据已从 `hosts.json` 拆到 `host-credentials.json`（`:96-98`），且 `HostStoreFile.version: 2` + `needsMigration`（`:249-272`）做了老字段迁移；`:127-169` 对 password/passwordEnv/privateKeyPath 逐个 sanitize（长度、控制字符、env 名正则）。**这一层我们是有意设计的，不改成「凭据归 OpenSSH」**（多 host 密码场景是真实需求，见 competitive-analysis §6）。
- 但有一处**实质可改**：`tmux-executor.ts:190-196` 用命令行 `-o ServerAliveInterval=30` 硬设，`-o` 优先级高于 `~/.ssh/config`，等于**静默覆盖用户自己的 keepalive**。herdr 的「用户值优先，我们只兜底」才是不越权的姿态。同理 `ControlPath` 固定在 `os.tmpdir()/tmuxgo-ssh`（`ssh-options.ts:45`），没有 herdr 那种超长路径降级分支 —— 用户的 `TMPDIR` 若很长，`ControlPath` 会撞 unix socket 107 字节上限，而我们没有 fallback。
- `ssh-options.ts:12-29` 对 `source === 'sshconfig'` 的主机已经「参数交给 ssh 原生解析」，只叠加 host key 策略 —— 方向与 herdr 一致，差距在**非 sshconfig 主机的 `-o` 硬设**。

## 5. 协议版本化

herdr 是三段式，且**把三类信号分开报**：

| 信号 | 出处 | 含义 |
| --- | --- | --- |
| `protocol: 22` | `herdr status --json`、`api snapshot.result.snapshot.protocol`、`api schema` 顶层 | 私有大版本号 |
| `capabilities: {live_handoff, detached_server_daemon, endpoint_protocol_generation, surface_interest, health_check, ssh_agent_registration}` | `status --json server.capabilities` | **能力可增不减**，客户端按 key 探测而非按版本号猜 |
| `endpoint_compatible` / `compatible` / `private_protocol_compatible` | `status` 文本 + `--json` | 兼容性单独判定，不与版本号等号 |
| `restart_needed` / `server_binary_stale` | `status --json update.*` | **「装了新版本」与「跑的是新版本」分开** |

实机验证到 capability 随启动方式变化：默认 session 的 server 报 `detached_server_daemon: true`，我用 `herdr --session probe-p4 server` 前台起的报 `false` —— 同一二进制、同一 protocol，capability 不同。这正是「能力探测优于版本比较」的现场证据。

另有 `herdr server reload-config` 实测返回 `{"diagnostics":[],"status":"applied"}` —— **配置热重载带诊断列表**，失败项逐条返回而不是整块拒绝。

TmuxGo 对照：

- 控制面：`control-protocol.ts:7-12` `CONTROL_PROTOCOL_VERSION='v1'` + `SUPPORTED_CONTROL_PROTOCOL_VERSIONS`；`routes/agent-control.ts:89-108` initialize 握手，未知版本回 `UNSUPPORTED_PROTOCOL_VERSION` 并把 `supportedVersions` 带回去。**这一套已经等价于 herdr 的 protocol 段**，且错误码更明确。
- stream 面：`PROTOCOL.md:1-20` 二进制 v1 header 冻结，`:35` 「未知 type 忽略该帧（不可断连）」，`:142-149` 兼容矩阵 —— 这就是 herdr `capabilities` 的等价物（`stream_caps` 交集协商）。
- 真正缺的是 `update.*` 那两格：`update-checker.ts:41-66` 的 `current.buildId` 是**从磁盘 git 现读**，不是运行中进程的身份；进程什么时候启动的不进任何状态。于是「已装新版本、需重启」这个状态只能由用户在 UI 上被 `restart-task` 的 running/success 间接暗示，机器读不到。这正是 herdr 用 `restart_needed`/`server_binary_stale` 两个布尔解决的事。

## 6. 落地建议

**做（按性价比排序）**

1. **`update.restartNeeded` / `sourceStale` 两布尔**：gateway 启动时把自身 `buildId`（git commit + version）记进内存；`/v1/app/update` 响应里对比「磁盘 buildId vs 进程 buildId」→ `restartNeeded`；对比「远端 buildId vs 磁盘」→ `available`。改动限于 `update-checker.ts` + 一个启动期常量，前端只加一个徽标。收益：把「重启才生效」从话术变成可核验状态。
2. **快照读取按 `version` 分支 + 覆盖前留恢复副本**：`isSnapshot()`（`session-snapshot.ts:82-94`）加 `version` 校验，未知版本视为过期（删）而不是误读；`writeSnapshot()`（`:132-141`）在 rename 前把旧文件留一份 `<id>.prev.json`（或 `session-snapshots/` 同级目录），保留 1 份、随 TTL 清理。理由：herdr 的 `persist.backup` 证明「写坏时要能捞回来」是刚需，而我们的关停快照正好在**最容易写坏的时刻**（进程被 SIGTERM）执行。
3. **SSH keepalive 改成「用户优先」**：`buildHostSshOptions` 或 `buildSshArgs` 里先用 `ssh -G <target>` 读出生效值，用户已设则不追加 `-o ServerAlive*`。实现可缓存 `-G` 结果（每 host 一次）。同时给 `getSshControlPath()` 加长度检查 + 短路径降级（`/tmp/ts-<hash8>`），对齐 herdr 的 staging path 分支。
4. **批量 agent 恢复节流**：若做批量恢复，按 100ms 间隔；`startup_per_agent_delay_ms` 的默认值可直接借用。
5. **控制面 capability map**：把已有布尔能力（`stream_cell`、`binary_output`、`live_pane_attach`…）收进 initialize 响应的 `capabilities` 对象（`control-schema.ts:75-79` 已有该字段位置），后续新增能力只需加 key，不必 bump `SUPPORTED_CONTROL_PROTOCOL_VERSIONS`。零破坏。

**不做（附理由）**

- **`update --handoff` / fd 继承**：pane 归 tmux，gateway 重启不涉及进程树搬迁；前端已有重连 + resync。抄它得到的只是复杂度。
- **`resume_argv` 由 agent 自报**：把「往用户 pane 里 send-keys 什么」的决定权交给外部脚本，是明确注入面。我们的 provider 白名单（`agent-recovery.ts:70-78`）宁可发版慢一点。
- **`pane_history` 跨重启保屏**：官方自己标 experimental、默认关；我们 L1 快照已明确「tail 只做预览不回填」（`session-snapshot.ts:15-17`），语义已经写死，回头改会把「不重放」的既定契约推翻。
- **凭据完全交给 OpenSSH**：多 host 密码 / passwordEnv 是产品能力，competitive-analysis §6 已定调；只抄「文档写清边界」这一层。
- **生成 ssh config 注入**：我们已经有 `-F` 锚定 + `source==='sshconfig'` 直通（`ssh-options.ts:34-42`），再叠一层生成文件会引入「哪份 config 生效」的新歧义。

## 7. 证据索引

| 结论 | 证据来源 |
| --- | --- |
| handoff 参数/双向版本门/可回滚 | `herdr api schema --json`（`ServerLiveHandoffParams`）、`herdr update --help`、二进制字符串 `handoff expected protocol …`、`endpoint handoff was rolled back` |
| capability 随启动方式变化 | `herdr status --json`（default session `detached_server_daemon:true` vs probe-p4 `false`） |
| 三类版本信号分离 | `herdr status` 文本 `update: restart_needed … server_binary_stale` |
| restore 自动重建布局 + 覆盖前备份 | `--session probe-p4` 实测：`workspace create` → `session stop` → 重启 → `api snapshot`；server log `persist.restore` / `persist.backup` |
| 持久化 schema | `~/.config/herdr/session.json` 与 `session-snapshots/*.json` 实拉（`"version": 3`） |
| agent resume 上报 | `pane.report_agent_session` schema description（`resume_argv`）、`~/.claude/hooks/herdr-agent-state.sh:54-84`、`herdr integration status` |
| 远程 ssh 管理姿态 | `herdr --default-config` `[remote] manage_ssh_config` 注释原文 |
| ssh control socket 安全校验/超长降级 | 二进制字符串 `SSH control directory must be owned by the current user …`、`SSH control socket path exceeds the Unix socket length limit` |
| ssh-agent 只借通道 | `herdr.sock.agent -> …/S.gpg-agent.ssh` 实测、`server.ssh_agent.register` schema |
| 配置热重载带诊断 | `herdr server reload-config` 返回 `{"diagnostics":[],"status":"applied"}` |
| TmuxGo 侧全部 file:line | 见正文；均为 worktree `research/herdr-lifecycle` @ `766f7ce` |

清理：实机只用 `--session probe-p4`，结束已 `herdr session stop probe-p4`；未触碰 default / eval / 其它 session，未执行 `herdr server stop`。
