# tmux 能力矩阵调研（四候选功能落地方案）

> 状态：**调研文档**（不含实现）
> 创建：2026-10-24（分支 `docs/tmux-capability`）
> 实测环境：tmux **3.4**，本机 Linux，隔离 socket `/tmp/rtx*-sock`（`env -u TMUX tmux -S …`，用完 `kill-server`）
> 结论速览：

| 候选功能 | 原生能不能直接用 | 数据量级 | 推荐路径 |
| --- | --- | --- | --- |
| 同步输入广播 | 否（`synchronize-panes` 只有 window 全量，且 zoom 时只打到 zoomed pane） | 每键 N 次 tmux 调用（N=选中 pane 数） | 网关 input 帧按 pane 扇出 + 前端多选，不走原生命令 |
| session 快照 | 部分（tmux 无快照概念，需组合 list-panes/capture-pane） | L0≈1–2 KB / L1≈16 KB / L2≈80 KB / L3≈1 MB+ | 复用 `session-layout` + `session-archives`，做 v1 JSON「lean 快照」 |
| display-panes 跳转 | 语义可用，形态不可用（client 侧覆盖层，2 s 自动消失） | 纯前端，零新后端调用 | 前端 overlay 编号 + click/数字键 → select-pane |
| 跨 pane 统一搜索 | 否（需逐 pane `capture-pane`） | 8 pane × 1000 行 ≈ 160 KB / ≈10–40 ms | 网关新增 pane-search 端点 + `history_size` 缓存令牌 |

## 0. 实测方法与两个环境坑

```bash
T="env -u TMUX tmux -S /tmp/rtx2-sock"
$T new-session -d -s exp -x 100 -y 24 -- sh
$T split-window -t exp -h -- sh && $T split-window -t exp -v -- sh
# …实验…
$T kill-server            # 只杀这个 socket 的 server
```

- **`history-limit` 不是我们设的**：本机 `show-options -g history-limit` = `50000`，来自用户 `~/.tmux.conf`；tmux **默认是 2000**。仓库里没有任何 `history-limit` 设置（`grep history-limit apps/` 为空），所以「我们的 session 能回看多少行」目前取决于目标机配置——做快照/搜索前应先由网关显式 `set-option -g history-limit`，否则不同主机行为不一致。
- 计数口径坑：pane 输出里有 shell prompt 前缀（`P> 42`），用 `^数字$` 之类锚定会误判“丢数据”。本文所有完整性结论都改成无锚点 token 匹配后复算过。

## 1. 同步输入广播（已拍板做）

### 原生语义（实测）

| 断言 | 实测结果 |
| --- | --- |
| 选项作用域 | 是 **window option**（`set-window-option`），默认未设置；`show-options -w` 在未设置时看不到，设置后出现 `synchronize-panes on` |
| 能否只同步子集 | **不能**。开启后即使 `send-keys -t %0`（明确指定单个 pane）向 3 个 pane 全部送达（`ONLY_P0` 命中 3/3） |
| 关闭时 `send-keys -t <window>` | 只进 active pane（另两个命中 0） |
| zoomed 态 | `resize-pane -Z` 后广播**只到 zoomed pane**（另两个命中 0） |
| copy-mode pane | 原生广播**跳过** mode pane（命中 0，仍留在 copy-mode）；若定向 `send-keys`，按键被 copy-mode 消费，pane 内进程收不到（实测 mode 被退出、shell 未见文本） |
| 并发安全 | 4 个进程并发 `send-keys` ×20 行、以及单进程一次传 20 对 `文本+Enter`，三个 pane 最终都是 **80/80** 唯一行，且无「单行两个 token」的交错 —— tmux 侧按命令原子写入 |

**判断得到确认**：`synchronize-panes` 是 window 级全量开关，无子集能力；做「选定子集广播」必须在网关扇出，另起 `setw synchronize-panes on` 反而会把同 window 的其它 pane 一并卷进去，且 zoom 时行为与直觉相反。

### 已有实现

- 会话快照已带 pane 拓扑：`apps/gateway/src/routes/sessions.ts:180` 的 `list-panes -F` 输出含 `window_zoomed_flag`、`pane_id`、`pane_title`、`pane_active`、`pane_width/height/left/top` —— 前端多选与 zoom 判定所需字段齐全。
- copy-mode 状态已暴露：`apps/gateway/src/routes/panes.ts:75` 读 `#{pane_in_mode}`。
- 输入通道：`apps/gateway/src/lib/stream/stream-session.ts` 目前单 pane 路由写入；`lib/stream/shared-terminal.ts` 按 host+session 复用单一 attach PTY 并扇出输出。

### 缺口与推荐方案

缺口：input 帧无多目标；无多选 UI；copy-mode / zoom 的边界未定义。

推荐（网关扇出，不调原生同步）：

1. WS input 帧扩展 `{ targetPaneIds?: string[] }`；缺省保持单 pane 行为。
2. 网关对每个目标 pane **按序** `send-keys -t %id`（多 pane 顺序写即可，实测无交错）；粘贴走 `set-buffer` + `paste-buffer -t %id` 而不是逐字符。
3. `pane_in_mode=1` 的 pane **默认跳过**并在 UI 标注（原生也跳过，行为一致且不吞键）；提供「退出 copy-mode 后加入」操作。
4. zoomed 态：只广播 zoomed pane，或提示「先退出 zoom 再广播」——不要静默只打一个 pane。
5. UI：pane 头多选 chip + 全选/反选；局限：移动端只需单 pane 时不显示多选。

量级：单键 = N 次 tmux 调用（N≤8 常见，每次 ~1–2 ms）；10 KB 粘贴 = N 次 `paste-buffer`。

## 2. session 快照（拍板条件：量小）

### tmux 侧机制

tmux 本身没有「快照」，社区方案（tmux-resurrect / tmux-continuum）存的是：window/pane 布局字符串、每个 pane 的 cwd、pane title、正在跑的命令，以及**可选的 pane 文本内容**；continuum 额外做定时自动保存。这些是二手资料（官方文档为主，未逐行核验其实现）。

我们能用的原语：

```bash
list-panes -s -t <session> -F '#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_width}x#{pane_height}'
list-windows -t <session> -F '#{window_index}\t#{window_name}\t#{window_layout}'
capture-pane -p -t %id                 # 可见屏
capture-pane -p -S -<N> -t %id         # 末尾 N 行历史（-S - 为全量）
capture-pane -pe -S -<N> -t %id        # 带 SGR 颜色
display -p '#{history_size}'           # 廉价变更令牌
```

### 数据量实测（80 列 pane，21 字节/行）

| 抓取档位 | 行数 | 字节 | 耗时 |
| --- | ---: | ---: | ---: |
| `-S -200` | 214 | 4.5 KB | 3 ms |
| `-S -2000` | 2014 | 42 KB | 4 ms |
| `-S -`（全量 6657 行） | 6657 | 134 KB | 5 ms |
| `-pe` 彩色文本 | 200 行 | 8.3 KB | —（相比无颜色 **2.24×**） |

元信息：3 pane 的 `list-panes` 行合计 84 B，`window_layout` 串约 70 B。

### 已有底子（复用面很大）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 版式文档 v1 | `apps/gateway/src/lib/session-layout.ts` | `kind: tmuxgo.session-layout`、`version: 1`，windows/panes 带 `cwd`、`command`；上限 8 window × 8 pane；明确**不导出** env/argv/pane 输出 |
| 应用版式 | `apps/gateway/src/routes/sessions.ts:677` `POST /hosts/:hostId/session-layouts/apply` | 按文档重建 window/pane |
| 建会话带 cwd/layout | `apps/gateway/src/routes/sessions.ts:480` | `{ name, layout, cwd }` |
| 内容归档 | `apps/gateway/src/routes/session-archives.ts` | `captureMode: 'visible' \| 'history'`、`maxBytes` 32 MB 上限、按 pane 均分预算 + 尾部截断 `trimOutput`、TTL、落盘 `TMUXGO_CONFIG_DIR/session-archives/<host b64url>/`、条数上限 100 |
| resume 命令 | `apps/gateway/src/lib/agent-recovery.ts` | provider allowlist 拼 `claude --resume <id>` 等，只往空闲 shell pane 打字 |

### 缺口

没有「一次点击 = 结构 + 元信息 + 可选内容」的聚合 API；layout 文档与 archives 两条链路互不相通；archive 只存内容不存结构。

### 推荐方案：lean 快照 v1

新增 `lib/session-snapshot.ts` + 两个端点（save / restore-preview），JSON 形如：

```jsonc
{
  "kind": "tmuxgo.session-snapshot", "version": 1,
  "createdAt": "…", "hostId": "local", "sessionName": "work",
  "layout": { /* 直接内嵌 session-layout 文档 v1 */ },
  "panes": [{
    "tmuxPaneId": "%3", "windowIndex": 0, "paneIndex": 2,
    "title": "claude", "cwd": "/home/user/proj", "command": "node",
    "inMode": false,
    "scrollbackTail": "…最后 N 行纯文本…"   // 可选档位
  }],
  "stats": { "paneCount": 4, "tailLines": 200, "bytes": 18234 }
}
```

分档与恢复体验：

| 档 | 内容 | 4 pane 体积 | 恢复后体验 |
| --- | --- | --- | --- |
| L0 | layout + cwd + command + title | ≈ 1–2 KB | 结构与目录完全还原，历史为空（≈「刚 cd 到现场」） |
| L1 | L0 + 每 pane 尾部 100 行纯文本 | ≈ 10–16 KB | 能看清上次在干什么，颜色/光标丢失 |
| L2 | L0 + 每 pane 尾部 500 行 | ≈ 60–80 KB | 大多数场景可辨认，仍无 ANSI 颜色 |
| L3 | 全 history（`-S -`） | 134 KB/pane → 8 pane ≈ 1 MB+ | 基本等同恢复现场，但触碰 32 MB 归档上限时需截断 |

**结论：KB 级完全可行。** 推荐默认 L1（每 pane 尾部 200 行 + 每 pane 32 KB 字节上限，复用 `trimOutput`），L2/L3 作为显式选项；颜色用 `-pe` 会让体积 ×2.2，默认关。

落盘与治理：`TMUXGO_CONFIG_DIR/session-snapshots/<host b64url>/<id>.json`，TTL 7 天、总数 100（与 archives 对齐）；恢复只重放**结构 + cwd + command**，`scrollbackTail` 仅作预览展示（写回 pane 会造成提示符重复，与 `agent-recovery` 只打字不重放的既定语义一致）。

## 3. display-panes 跳转（已拍板做）

### 原生语义（实测 + man）

- `display-panes [-bN] [-d duration] [-t target-client] [template]`：在 **client** 上画出每个 pane 的可见指示（编号），不是 pane 内容 —— `capture-pane` 看不到它。
- 编号 = `pane_index`（1 起）映射到数字键 `0`–`9`（即 10 个 pane 以上无法用数字选中）。
- 时限：未给 `-d` 用会话选项 `display-panes-time`（本机实测 2000 ms）；`-d 0` 表示等到按键；`-N` 表示按键不关闭；`-b` 表示不阻塞其他命令。
- 模板：默认 `select-pane -t '%%'`，`%%` 替换为 pane id。
- 必须有 client：分离会话执行会报 `can't find client`（实测）。

### 我们的映射

- **单层编号**（当前 window 内 `pane_index`）更贴近 tmux 语义，也够用：跨 window 跳转已有 CommandPalette 的 window/session 切换，不必在覆盖层里做二维。
- zoomed 态：window 里只有一个可见 pane，覆盖层只画 1 个徽标；要跳别的 pane 必须先退出 zoom —— UI 上给「退出 zoom 并显示全部」的提示。
- 触发键：现有全局占用为 `Cmd/Ctrl+K`（palette）、`+B`（会话面板）、`+E`（文件面板）、`+Shift+I`（元素选择），终端内 `Alt+←/→` 只用于编辑器。建议 **`Alt+P`** 作为主键（不与现有冲突、不触发浏览器默认），并在 palette 提供「跳转 pane…」命令项、移动端用 pane 头长按。

### 实现路径对比

| 路径 | 可行性 | 判断 |
| --- | --- | --- |
| 前端 overlay（推荐） | 读会话快照的 pane 位置/尺寸（`sessions.ts:180` 已含 left/top/width/height），画编号徽标，click 或数字键 → 现有 select-pane 端点 | 零 tmux 依赖、支持鼠标与移动端、可跨 WebGL 渲染器、无 2 s 时限 |
| 驱动原生 `display-panes` | 需要网关的 attach PTY 是「当前 client」；覆盖层数字会随 PTY 输出流回浏览器，但按键必须由 tmux client 截获、2 s 后自动消失（未在网关实测，属推断） | 不推荐：时序脆、移动端无数字键、覆盖层会污染 cell 流 |

## 4. 跨 pane 统一搜索

### 三条内容通道对比

| 通道 | 覆盖范围 | 成本 | 用于搜索的可行性 |
| --- | --- | --- | --- |
| 网关 stream 输出 | 仅「连接期间」实时帧；`lib/stream/stream-cell.ts` 的 `TerminalGrid` 是 **视口大小**（cols×rows），不留 scrollback | 零额外调用 | 不可行：历史不在网关 |
| 前端 xterm buffer | 每个已挂载终端自己的 scrollback | 纯前端 | 只覆盖已挂载/可见终端，后台 window 拿不到 |
| `capture-pane -p -S -N` | 任意 pane 的任意历史 | 2000 行 42 KB / 4 ms（实测） | **推荐** |

补充：`lib/agent-state.ts:605` 用的是 `capture-pane -e -p -S -80`（只看 80 行），`lib/agent-control.ts` 用 `-S -<count>` 取有界 tail；都证明通道可用，但都不是「全量搜索」。

`history-limit` 决定可搜索深度：tmux 默认 2000 行（≈42 KB/pane），本机因用户配置为 50000 行（≈1 MB/pane 上限）。建议网关在会话创建/attach 策略里显式 `set-option -g history-limit 20000`（≈ 8 pane × 0.4 MB 上限，可控），不要依赖宿主配置。

### 推荐端点

```
POST /hosts/:hostId/sessions/:sessionId/pane-search
{ query, mode: 'literal'|'regex', maxLines: 1000, windows?: number[], includeAnsi: false }
→ [{ paneId, windowIndex, paneIndex, historySize, hits: [{ line, text }] }]
```

实现要点：

1. `list-panes -s` 一次拿全 pane + `history_size`（廉价变更令牌），命中缓存 `(host, session, pane, historySize)` 直接复用上次结果，TTL 2–5 s。
2. 逐 pane `capture-pane -p -S -<maxLines>`（默认 1000，硬上限 5000），过 `stripTerminalControlSequences`（`lib/terminal-output.ts:9`）再去匹配；并发上限 4–8。
3. 命中项跳转：`select-pane -t %id` + 前端 `terminal.scrollToLine(line)`（xterm buffer 保留 scrollback；WebGL 渲染器同样可用），不依赖 tmux 的 copy-mode 定位。
4. 返回体加每 pane 的 `historySize` 与耗时，便于前端提示「仅搜索最近 N 行」。

量级：8 pane × 1000 行 ≈ 8 × 20 KB = 160 KB 抓取、串行 ~32 ms / 并发 ~10 ms；缓存命中后只剩一次 `list-panes`。

### 前端落点

- 默认入口放在 **CommandPalette**（`Cmd/Ctrl+K`）新增「搜索所有 pane」结果源：输入即跨 pane 搜索，命中项显示 `window:pane · 行号 · 文本`，回车跳转。
- `TerminalSearch`（当前 pane 内查找）保留，加 scope 开关「本 pane / 所有 pane」，内部改调同一端点；避免继续穿 xterm 私有 `_addonManager`（现 `TerminalSearch.tsx:35` 的做法）。

## 5. 未验证项与风险

1. **原生 overlay 进流**：`display-panes` 的指示层由 client 绘制，理论上会出现在网关 attach PTY 的输出里；未在网关侧实测，本文不把它作为方案依据。
2. **远端主机一致性**：以上实验全部在本机 tmux 3.4。远端（agent / ssh 通道）的 tmux 版本、`history-limit`、`pane_in_mode` 字段支持未验证，需要一次远端 smoke。
3. **copy-mode 下的定向注入**：实测按键被 mode 消费、pane 内进程收不到；网关默认跳过的策略与原生一致，但「自动退出 copy-mode 后加入广播」需要额外 `send-keys -X cancel`，其副作用（丢失用户选择状态）需产品确认。
4. **大 history 抓取的内存峰值**：`capture-pane -S -` 在 50k 行 × 8 pane 下是 4 MB/pane 级别，端点必须强制 `maxLines` 上限并流式截断。
5. **zoom + 多选广播**：zoom 态原生只打 zoomed pane，我们若绕过（逐 pane send-keys）会打到隐藏 pane，需明确产品语义后再实现。
