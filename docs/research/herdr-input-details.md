# Herdr 输入层工程细节（v0.9.5 实测）→ TmuxGo 映射

> 状态：**调研文档**（不含实现）
> 创建：2026-10-25
> 实测对象：herdr 0.9.5（protocol 22）
> 实测方法：`herdr --default-config` / `herdr --skill` / `herdr api schema --json`（102 个 request method）逐项核对；实机用隔离 session `probe-p2`（已 `session stop`）验证键名校验与右键路由，未触碰 default session
> 结论速览：

| 输入域 | herdr 做法 | 我们现状（file:line） | 判断 |
| --- | --- | --- | --- |
| 键位体系 | **prefix 模式 + navigate 模式 + 直接 chord + indexed binding** 四层，全部服务端解析 | 无 prefix；应用级 chord 在终端内直接放行（`ConsoleLayout.tsx:645`），终端键位全归 pane 应用 | **不抄 prefix**，但可抄「动作与字节分离」 |
| 逻辑键名 | `pane.send_keys` 白名单键名，**全量校验通过才写字节**（`invalid_key`） | 控制面只有 `text + enter`（`agent-control.ts:497`）；WebSocket 原样写 pty（`stream-session.ts:1571-1575`） | 值得抄，落控制面 |
| IME/CJK | `switch_ascii_input_source_in_prefix`（宿主输入源）+ `reveal_hidden_cursor_for_cjk_ime`（游标暴露给 IME） | 助手 textarea 跟 buffer 光标定位（`terminal-focus.ts:34-61`） | 前者不抄，后者思路已有、缺 allowlist |
| 右键路由 | 两层：`pane.input.set --right-click herdr\|pane` + 全局 `right_click_passthrough_modifier` | 桌面**完全不拦**右键（`TerminalPane.tsx:588` 仅移动端 preventDefault） | 值得抄，成本最低 |
| copy-on-select | `copy_on_select` 开关 + 服务端选区模型（anchor/cursor/content_revision） | 松手即复制、**无开关**（`terminal-runtime.ts:798`） | 加分项 |
| mouse 捕获 | `mouse_capture` 全局开关，关掉后点击交还外层终端，pane 应用仍可自行请求 | tmux `-g mouse on` 恒开（`tmux-policy.ts:55`），无关闭档 | 值得抄语义，实现靠 tmux 选项 |
| 滚动语义 | `mouse_scroll_lines=3`（配置）+ `pane.scroll` 语义 op | 触屏 `pane_scroll(lines)` → copy-mode（`TerminalPane.tsx:280`） | 已同构 |

## 0. 已对齐面（先记清，避免重复立项）

- **语义滚动而非按键滚动**：herdr 的滚动是 `pane.scroll` API（`request` 里 `pane.scroll`，不是 `send_keys`）；我们触屏滚动同样发 `pane_scroll{lines}` 上行、网关 `applyScroll` 拼 `copy-mode -e ; send-keys -X -N <n> scroll-up`（`stream-tmux.ts:89-113`），并做了 80ms 窗口合并（`TerminalPane.tsx:270-300`）。**结论：这条路已经对，不要再加「滚轮模拟 PageUp 键」的旁路。**
- **IME 组合期不吃键**：`isImeKeyEvent()`（`terminal-platform.ts:15-17`，`isComposing || key==='Process' || keyCode===229`）在自定义键处理器首行直接放行（`terminal-key-handler.ts:30`），与 herdr「前缀期间切换输入源以保证命令送达」解决的是同一类"输入法抢键"问题的两端。
- **pane 内应用自己开 mouse 时不被抢**：tmux `mouse on` 下，pane 应用发 `\x1b[?1000h` 等后，拖拽事件由 tmux 转发给应用而非进入 copy-mode；我们额外用 SGR 按下上报做了「tmux 已实时选中 fake 焦点」的时序规避（`terminal-pane-interactions.ts:35-43` + `terminal-runtime.ts:503-508`），这是 herdr 不存在的坑（它自己就是 multiplexer）。

## 1. 键位体系：prefix / navigate / 直接 chord / indexed

herdr 的四层（`--default-config` 原文）：

```toml
[keys]
prefix = "ctrl+b"            # 进入 prefix 模式；prefix+n 才需要前缀
help = "prefix+?"            # prefix 模式动作
focus_pane_left = "prefix+h"
switch_tab = "prefix+1..9"   # indexed binding，范围语法
focus_agent = "prefix+alt+1..9"
# Navigate-mode movement. These local shortcuts win while navigate mode is open.
# They are independent from focus_pane_*. Do not include prefix+, esc, enter, tab, or 1..9 here.
navigate_pane_left = "h"
[[keys.command]]             # 自定义命令三型：shell(后台) / pane(临时 pane) / popup(模态终端)
key = "prefix+alt+g"
type = "popup"
command = "lazygit"
```

要点：
1. **prefix 的唯一价值是「不占用 pane 应用键位」**。注释里写得很直白：直接 chord（`ctrl+alt+n`）「Most reliable direct bindings are ctrl+letter, function keys, and explicit modified chords」，而 `alt+...`/`cmd`/标点带修饰「may depend on your terminal/tmux setup」——即她的键位解析发生在**自己进程的 stdin**，天然会与外层终端、tmux 抢。
2. **navigate 模式是独立键盘域**，h/j/k/l 只在模式内生效，且明确禁止把 `prefix+/esc/enter/tab/1..9` 绑进去（这些在模式内有语义）。方向键在模式内恒生效（"left arrow always focuses the pane to the left"），这是为「不认 hjkl 的用户」留的后路。
3. **indexed binding 已经从配置表退化为范围语法**：`[keys.indexed]`（tabs/workspaces/agents 三段修饰键）仍在解析但标了 legacy，统一进 `switch_tab = "prefix+1..9"`。
4. `[[keys.command]]` 三型的差别是**生命周期**：`shell` 后台 detached、`pane` 占一个临时 pane 退出即关、`popup` 模态覆盖不改 tab 布局（`width/height` 支持 `80%`）。

**TmuxGo 现状**：没有 prefix 概念，也没有 navigate 模式。应用级 chord 走 window 监听，且**焦点在终端内就直接退出**：

```ts
// apps/frontend/src/components/ConsoleLayout.tsx:645
if (target?.closest('[data-terminal],.xterm,.xterm-screen')) return
```

即终端里的 `Cmd/Ctrl+K`（调色板）、`Cmd/Ctrl+Shift+F`（跨 pane 搜索）、`Cmd/Ctrl+B`（session 面板）全部让给 pane 应用。这个选择对我们是对的（浏览器用户不存在"没有前缀就抢不到键"的问题，反而 prefix 会引入二次学习成本），但代价是**终端全屏时应用动作不可达**——只能靠 QuickActions 鼠标点。

**建议（做）**：不引入 prefix 解析，改为把「应用动作」提升为一等可路由对象，供三条入口共用：QuickActions 按钮、`useCustomShortcuts`、未来的快捷键面板。现状 `CustomShortcut` 只有 `keys`/`text` 两种步骤（`useCustomShortcuts.ts:71-81`），只能"往 pane 里塞字节"，无法表达"切 pane/开面板/关窗"——这正是 herdr `[[keys.command]]` 的 `type` 字段在做的事。加 `{ type: 'action', action: 'pane.focus_left' | 'palette.open' | ... }` 步骤类型即可，不需要动输入通路。

**建议（借 navigate 的思路，不借实现）**：navigate 模式的本质是「一次性键盘域」。移动端虚拟键已经有 Esc/Tab/方向键，缺的是**修饰键闩锁**（latch）：点一下 `Ctrl` 变高亮，再点 `C` 发 `\x03`。这比现在的固定 `Ctrl+C`/`Ctrl+D`/`Ctrl+Z` 三键（`QuickActions.tsx:508-514`）覆盖面大一个数量级，且完全不需要 prefix。

## 2. 逻辑键名 + 全量预校验（最值得抄）

herdr API 里键和文本是**两个不同原语**：

```jsonc
// herdr api schema → request.$defs
"PaneSendKeysParams": { "pane_id": "string", "keys": ["string"] },
"PaneSendTextParams": { "pane_id": "string", "text": "string" },
"PaneSendInputParams": { "pane_id": "string", "text": "string?", "keys": ["string"]? }  // 混合
```

`--skill` 的契约（原文）：*"Herdr validates all keys before writing any bytes."* 实测（`probe-p2`，`pane send-keys w1:p1 esc ctrl+nope`）：

```json
{"error":{"code":"invalid_key","message":"unsupported key ctrl+nope"},"id":"cli:request"}
```

并且**前一个合法键（esc）没有落字节**——`pane read --source visible` 仍是空提示符。这是"全量校验后才写"而非"边校边写"，对 agent 驱动场景很关键（半截转义序列会把 pane 应用喂成乱码）。

实测键名白名单（逐项发送、按是否 `invalid_key` 判定）：

| 接受 | 拒绝（同名直觉项） |
| --- | --- |
| `esc`/`escape`、`enter`/`return`、`tab`、`space`、`backspace`/`bs`、`up/down/left/right`、`f1..f12`、`minus/comma/plus/ampersand/backtick`、`ctrl+c`、`ctrl+shift+a`、`shift+tab`、`alt+enter`、`super+a`/`cmd+a`、`alt+up`、`shift+left` | `delete`、`insert`、`home`、`end`、`pageup`/`pagedown`（及 `page-up`/`pgup`/`prior` 等全部变体）、`backtab` |

即：**白名单只覆盖「给 agent 审批 UI 足够用」的最小集**，导航类键一律推给语义 API（滚动 `pane.scroll`、选中 `pane.copy_motion`）。`copy_motion` 的枚举同样是语义动作而非 vi 键：`line_end`、`first_non_blank`、`next_word_start`、`previous_paragraph`…——调用方不需要知道用户的 copy-mode 键表。

**TmuxGo 现状**：
- 控制面 `POST /v1/control/panes/run`（`routes/agent-control.ts:185`）只收 `{ text, enter }`，`runAgentPaneInput` 走 `send-keys -l` + 独立 `Enter`（`agent-control.ts:499-524`），并拒绝 NUL/控制字符（`agent-actions.ts:60-64`）。**没有键名通道**，agent 想按 Esc 只能自己拼 `\x1b` 塞进 text——而 text 又被控制字符校验挡掉。
- WebSocket 打字通路是**原始字节直写 pty**（`stream-session.ts:1571-1575`：`this.ptyProcess.write(data)`），tmux 自己是解释器，没有中间层可校验。
- 前端虚拟键自己就是硬编码字节表（`QuickActions.tsx:454-487`：`data: '\x1b'`、`'\x1b[A'`、`'\x03'`），自定义快捷键也一样（`useCustomShortcuts.ts:13-41` `KEY_MAP` 把 `delete → \x1b[3~`、`f1 → \x1bOP` 写死）。

**建议**：在控制面加 `keys` 字段（`panes/run` 或新 `panes/send-keys`），接受 herdr 同款逻辑键名，**服务端统一校验、全部通过才执行 `tmux send-keys <KEY>`**（tmux 自己的 key name 表已经足够，`C-c`/`Escape`/`BSpace`/`PPage`…）。这样 CLI/MCP agent 不必记转义序列，且在 `in_mode` 时天然报 `PANE_IN_MODE`（该门已有，`agent-control.ts:512`）。**键名表取 superset 而非 herdr 的最小集**——我们的前端已经在用 `\x1b[3~`/`\x1b[H` 这类，删掉导航键只会让我们自己的虚拟键条迁移不了。WebSocket 通路保持直写 pty 不动（用户就是要点透传，加校验只会误伤）。

## 3. IME / CJK 两处机制

### 3.1 `switch_ascii_input_source_in_prefix`（不建议抄）

`--default-config` 原文：*"While prefix mode is active, temporarily switch the host input source to an ASCII-capable mode so prefix commands register even when an IME is active, then restore the previous input source when prefix mode exits. macOS and Windows only; best-effort."*

这是 herdr 被 prefix 方案**逼出来的补丁**：中文输入法激活时，某些前缀键（`esc`、`-`）会被 IME 吃掉。我们既然不引入 prefix，就没有这个问题面；且浏览器根本没有切换宿主输入源的 API（`navigator.keyboard` 只能 lock 有限几个键）。**明确不做。**

### 3.2 `reveal_hidden_cursor_for_cjk_ime`（思路已有，缺 allowlist）

原文：*"Expose the focused pane's cursor to the outer terminal so macOS input methods keep tracking the candidate window when TUIs paint their own cursor (Claude Code, pi, codex)."* 配套 `cjk_ime_agents = []` 白名单与 `cjk_ime_cursor_shape = "steady_block"`。

问题本质：TUI 应用（Claude Code 类）**自己画光标并关掉 DECTCEM**，宿主终端的原生光标消失 → 输入法候选窗失去锚点，飘到左上角。herdr 的解法是「合成的光标只在白名单 agent 的 pane 里暴露」。

**TmuxGo 现状**：xterm 的 helper textarea 被搬到 buffer 光标位置（`terminal-focus.ts:34-61`：`left = cursorX*cellWidth`、`top = cursorY*cellHeight`、宽字符用 `line.getWidth()` 修正、`zIndex=-5` 藏在画布下）。**这比 herdr 更稳**：锚点是 buffer 光标而非 DOM 光标元素，DECTCEM 关闭不影响它。真正的残留问题是**锚点跟的是「buffer 光标停在哪」**——Claude Code 这类把光标停在屏幕底部/隐藏区的 TUI，候选窗会跟到那个奇怪位置。

**建议**：抄 `cjk_ime_agents` 这个**收敛思路**，不抄光标绘制：对已知「自绘光标 + 自管输入框」的 agent（检测结果现成，`lib/agent-state.ts` / manifest 体系），把 IME 锚点从 buffer 光标换成**最近一次输出帧的底部行**（或该 pane 的视口底部），并对其他情况保持现状。可做成 `~/.tmuxgo/preferences` 里一个默认关的开关，出问题可退。**前置条件**：需要先有一份「锚点漂移」的真实复现录屏，否则不动——这是纯体验优化，不是缺陷。

## 4. 右键路由（成本最低的一项）

herdr 有两层，且第二层是**每 pane**独立的：

```toml
# [ui]
# Optional modifier that forwards right-click hold/drag gestures to pane apps instead of opening Herdr's pane menu.
# Shift is intentionally unsupported because terminals commonly reserve Shift+mouse.
right_click_passthrough_modifier = ""
```

```bash
herdr pane input w1:p1 --right-click pane|herdr     # 实测：返回 {"result":{"type":"ok"}}
herdr pane split ... --right-click herdr|pane        # 建 pane 时即可指定
```

注意 `RightClickTarget` 枚举只有两值——**不存在「什么也不做」**，永远是「归宿主 UI」或「归 pane 应用」。且 `pane get` **读不回** `right_click` 字段（实测只返回 agent_status/cwd/scroll 等），写入后无观测手段，这是个设计瑕疵，不要学。

**TmuxGo 现状**：桌面端完全不拦右键——`TerminalPane.tsx:588` 的 `onContextMenu` 只对 `isMobileDevice` 生效（`preventDefault` 挡掉移动端长按菜单），桌面走浏览器原生菜单。运行时层只在移动端注册 `contextmenu` 捕获拦截（`terminal-runtime.ts:898-899`）。

后果：① 桌面上右键拖拽**永远到不了 pane 应用**（lazygit/btop/htop 的右键手势全废），xterm 只上报左中键与滚轮；② 用户想要"复制/粘贴"时看到的是浏览器菜单，和 Web 终端的语义不符。

**建议**：按 herdr 的两层补齐，但把枚举扩成三值，并把它做成**明确的产品决策**而不是默认行为：
- 桌面右键（无修饰）：`stopPropagation + preventDefault` + 弹我们自己的菜单（Copy / Paste / Select All / Clear / Split / 发送给 pane），与移动端已有菜单共用组件；
- `Alt + 右键`（不用 Shift，理由同 herdr 注释）：不再拦截，让 SGR 右键序列送到 tmux/pane 应用；
- 每 pane 一个覆盖位（`rightClick: 'herdr' | 'pane' | 'menu'`，默认 `menu`），split 时可指定。

实现面很小：`TerminalPane.tsx` 加一个 `onContextMenu` 分支 + 一个偏好项，不需要动 tmux 策略。

## 5. copy-on-select 与选区模型

herdr：`copy_on_select = true` 默认开，关掉后 *"retain drag or double-click word selection until Ctrl+C"*。更有意思的是**选区是服务端模型**：

```jsonc
"PaneSelectionReadParams": { "pane_id", "anchor": Point, "cursor": Point, "content_revision": "uint64?" }
"PaneCopyMotionParams":    { "pane_id", "cursor": Point, "motion": <语义动作>, "content_revision": "uint64?" }
"PaneLinkActivateParams":  { "pane_id", "viewport_row", "col", "offset_from_bottom"?, "content_revision"? }
```

传 `content_revision` 的意义是**过期即失效**：客户端拿着旧 revision 的坐标来读选中内容，服务端可以拒绝，避免"用户选 A 行、复制到 B 行"。`pane.link.activate` 同样只用 `viewport_row/col` 定位链接——点击点→单元格→服务端判定是否链接，客户端不做链接解析。

**TmuxGo 现状**是**双轨**：
1. tmux `mouse on` 时拖选归 copy-mode，tracker 每 160ms 轮询 tmux 选区坐标（`terminal-selection-tracker.ts:44,169`），按 pane 相对坐标换算回 xterm window 行列计数（`countTmuxSelectionChars`，含矩形选），松手把 tmux buffer 文本回写剪贴板（`terminal-runtime.ts:798` 注释与实现）。
2. 应用自己开 mouse 时走 xterm 本地选区，`onSelectionChange` → `useTerminalSelectionSync.setSelection`（`terminal-runtime.ts:523`），`Ctrl/Cmd+C` 走原生 copy 事件（`terminal-key-handler.ts:34-42`）。

复制执行是"三连发"兜底（`useTerminalSelectionSync.ts:116-131`：native → `requestAnimationFrame` → `setTimeout(0)`），因为写系统剪贴板可能被浏览器拒（无安全上下文/无权限），失败退 app 剪贴板并 toast（`:14-20`）。

**判断**：双轨是 tmux 决定的，不可能统一成 herdr 那种单模型，**不抄**。但两条可学的：
- **`copy_on_select` 开关**：我们现在松手必复制（`handlePointerSync` 无条件 `runCopySelection`），而"拖选后想 Ctrl+C 再复制"是很多人的习惯；且松手复制会在拖拽经过链接/按钮时误触发剪贴板写入。加一个偏好项（默认开，保持现状）。
- **`content_revision` 的过期语义**：我们的 `countTmuxSelectionChars` 用的是**轮询到的快照**，输出在滚动中会算出错位字符数——这只影响 toast 里的字符数，不影响复制内容（复制取的是 tmux buffer）。**建议只标注不改**：真要修，在 `pane_selection` 快照里带一个 `revision`，字符数算出来对不上就不显示。优先级低。

## 6. mouse 捕获边界

herdr：`mouse_capture = true` 默认，注释：*"Set false to let the terminal handle normal clicks, such as Cmd-clicking URLs. Pane apps like lazygit and btop can still receive mouse when they request it."* 注意语义是**三段式**：宿主要不要抢 → 抢了之后转发不转发 → pane 应用是否主动请求。关掉捕获不等于让 pane 应用失聪。

**TmuxGo 现状**：`mouse on` 在 attach 前无条件钉到 session（`tmux-policy.ts:51-56`，注释说明是「destroy-unattached off + mouse on」固定策略）。没有关闭档，也没有 per-session 覆盖。滚轮在桌面走 xterm → SGR 序列 → tmux（因此受 tmux 自己的滚动行为支配），移动端走 `pane_scroll` 语义上行。

**建议**：把"是否捕获鼠标"暴露成 session 级偏好，落到 `set-option -t <session> mouse off|on`（**必须是 session 级 `-t`，不能碰 `-g`**，见同文件注释的隔离原则）。关闭后的收益：浏览器快捷键恢复（Cmd+点击开链接、右键菜单归浏览器）、文字可用原生选区；代价：pane 切换/拖拽分屏失效，所以默认仍 on，只给"只想看输出"的场景留口子。

`mouse_scroll_lines = 3`（herdr 默认）在我们的桌面链路里等价于 tmux 的滚轮翻页量——不经我们代码，**不需要实现**；触屏链路行数由手势位移算出（`TerminalPane.tsx:270`），已可调。

## 7. 其它值得记录的输入细节

| 细节 | herdr | 说明 / 对我们的意义 |
| --- | --- | --- |
| 谁的键盘 | `--remote-keybindings <local\|server>`：远程 attach 时可选本地或服务端键位 | 我们天然只有一层（浏览器 + tmux 自己的 prefix）。**产品缺陷**：会话内 tmux prefix（默认 `C-b`）对用户完全不可见，新用户不知道"浏览器里的 C-b 是送进 pane 的"。**建议**：设置页展示当前 session 的 prefix 值（`tmux show-options -g prefix` 已可查），并在 QuickActions 的长按提示里说明「终端内键盘全部发往 pane」。 |
| 长命令行门 | `pane run`/`agent start` 在 macOS 上拒绝超过终端 canonical 行上限的命令，**提交前**报错 | 我们有 `panes/run` 4096 字符上限（`agent-control.ts:505`）但那是我们自己的限制，不是终端 canonical 上限。优先级低（Linux 下 canonical 上限宽松），但当用户粘贴巨型文本会被截断——已有 `paste-data` 通道分流（`sync-panes.ts:17` 注释），可接受。 |
| 重获焦点重绘 | `redraw_on_focus_gained = true`（含"关掉可减少闪烁，代价是罕见损坏要等下次全量重绘"） | 我们有 `pageshow`/`visibilitychange`/`orientationchange` 三条恢复路径（`terminal-runtime.ts:781-784`）。语义一致，**不需动**；herdr 那条 trade-off 注释值得抄进我们代码注释（现在只写了做什么，没写为什么可以关）。 |
| 光标策略 | `host_cursor = auto\|native\|drawn`（WSL/Windows 画自绘光标以避 ConPTY 闪烁） | 浏览器里 xterm 只有自绘光标，**不适用**。 |
| 输入源成对性 | `esc` 规范名 + `escape` 别名；`enter`/`return`、`backspace`/`bs` 同样双名 | 我们的 `KEY_MAP` 也接受 `esc`/`escape`（`useCustomShortcuts.ts:15-16`），但缺 `enter/return`、`backspace/bs` 别名对称。顺手补齐即可。 |

## 8. 明确不建议抄

1. **prefix 模式**：浏览器端引入 prefix 会与浏览器自带 chord、tmux 自己的 prefix 形成三层键盘归属，学习成本和冲突面都翻倍；我们的用户是图形化点击为主。
2. **navigate 模式**：同上，且移动端已有虚拟键条。只借"修饰键闩锁"这一个点。
3. **`switch_ascii_input_source_in_prefix`**：依赖宿主 OS 输入源切换，浏览器无 API；且问题本身由 prefix 派生。
4. **键名白名单的最小集**：herdr 拒 `delete/home/end/pageup` 是有意的（逼调用方走语义 API），但我们前端已有这些键的字节映射和用户习惯，抄最小集会造成自我不兼容。取 superset。
5. **服务端选区模型整体替换**：由 tmux copy-mode 决定，替换等于自己实现一套选区，性价比极低。只借 `content_revision` 思路。
6. **`pane.input.set` 只写不可读**：读回能力（观测性）必须有，否则排障只能靠猜。
7. **`host_cursor`/`theme` 等纯 TUI 面**：不适用浏览器。

## 9. 遗留问题（需老板拍板）

1. 右键菜单的具体条目集与默认值（`menu` / `pane` / 三值枚举）——这是产品决策，不是技术决策。
2. 是否给控制面开 `keys` 通道（涉及 MCP tool 是否新增 `pane_send_keys`，`apps/mcp` 的权限面要一起定）。
3. `copy_on_select` 开关默认值：保持"松手即复制"，还是改成"选中后需 Ctrl+C"。
4. IME 锚点漂移的修复需要一份真实复现录屏；无复现则不动。
5. session 级 `mouse off` 与现有 `attachExclusive/shared` 语义的交互未验证（被动客户端场景下关闭捕获是否影响 owner）。
