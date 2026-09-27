# 侧边栏内嵌浏览器（Sidebar Browser）设计契约

> Status: P0 开发中 · 2026-09-27 · branch feat/sidebar-browser-20260927

目标：TmuxGo 侧边栏内嵌一个真实浏览器画面；pane 内 agent 通过控制面操作同一浏览器实例，用户可随时围观/接管。

## 架构

```
frontend BrowserView ──WS──> gateway /api/browser/stream ──CDP──> chromium-headless-shell
        └─REST /api/browser/*──────────────┘   (spawn: loopback 9222随机端口, 独立 user-data-dir)
pane agent ──stdio──> apps/mcp tmuxgo_browser_* ──REST──> /api/v1/control/browser/* ──CDP──┘
```

- 显示：CDP `Page.startScreencast` JPEG 帧 → gateway 中继 → 前端 `<canvas>`。输入用 `Input.dispatch*` 回注。
- 控制：agent 侧走 `/api/v1/control/browser/*`（沿用 token + `x-tmuxgo-env:1` guard）；前端侧走 `/api/browser/*`（沿用 WS ticket 鉴权，同 /vnc）。
- 浏览器实例：gateway 在 local host spawn `chrome-headless-shell`，`--remote-debugging-port=0`（读 `DevToolsActivePort`），`--user-data-dir=$TMUXGO_CONFIG_DIR/browser-profile`（持久登录态），仅 loopback。P0 仅 `hostId=local`。
- binary 探测顺序：`TMUXGO_BROWSER_PATH` → `~/.cache/ms-playwright/chromium_headless_shell-*/`（取最新）→ PATH 中 google-chrome/chromium；探不到时 setup 接口返回 hint（照抄 vnc setup 的 probe/status/install 模式）。

## WS 协议 `/api/browser/stream`（JSON 双向，单 socket）

server→client：

- `{type:'frame', data:'<jpeg b64>', width, height}` — screencast 帧
- `{type:'page', url, title}` — 活动页元信息变化
- `{type:'targets', targets:[{id,url,title}]}` — tab 列表变化
- `{type:'status', state:'idle|launching|ready|error', error?}`

client→server：

- `{type:'navigate', url}` / `{type:'back'|'forward'|'reload'}`
- `{type:'input', kind:'mousemove'|'mousedown'|'mouseup'|'wheel', x, y, button?, deltaX?, deltaY?}` → `Input.dispatchMouseEvent`
- `{type:'input', kind:'keydown'|'keyup'|'char', key, code, text?}` → `Input.dispatchKeyEvent` / `Input.insertText`
- `{type:'resize', width, height}` → `Emulation.setDeviceMetricsOverride` + 重启 screencast 尺寸
- `{type:'tab', action:'open'|'close'|'activate', url?, targetId?}`

坐标系：前端画布 CSS 像素 → 按 metadata 尺寸换算回页面坐标再 dispatch。

## REST（前端，`/api/browser/*`，走 session auth）

- `GET  /api/browser/status` → `{state, pages[], activePageId, engine, rssKB?}`
- `POST /api/browser/setup` → `{status, hint, manualCommand}`（probe；复用 vnc 的模式）
- `POST /api/browser/launch` / `POST /api/browser/stop`
- `GET  /api/browser/stream`（WS，ticket 鉴权）

## Agent 控制面 `/api/v1/control/browser/*`（token + env guard）

- `navigate {url, tab?}` `back` `forward` `reload`
- `snapshot {tab?}` → `{url,title,text,elements:[{ref:'e12',role,name,tag}]}` —— JS 注入序列化器，元素打 `data-tg-ref` 属性，编号寻址（dsh-browser 同款思路）
- `click {ref}` `type {ref,text}` `scroll {dx,dy}` `press {key}`
- `screenshot {tab?}` → jpeg b64（也可经 inbox push）
- `tabs` / `open {url}` / `close {tab}` / `activate {tab}`
- `eval {expression}`（受限：结果 JSON 化截断 64KB）

## MCP 工具（apps/mcp/index.mjs 新增）

`tmuxgo_browser_navigate / snapshot / click / type / scroll / press / screenshot / tabs / open / close_tab / activate_tab / back / forward / reload` —— 全部转发 control REST。

## 文件所有权（双 agent 并行）

| 归属               | 文件                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 老板会话（本仓）   | `apps/gateway/src/lib/browser-manager.ts`(新)、`apps/gateway/src/routes/browser.ts`(新)、`apps/gateway/src/index.ts`（仅注册行）、`apps/mcp/index.mjs`、gateway 测试 |
| pane devin（前端） | `apps/frontend/src/components/BrowserView.tsx`(新)、`lib/api.ts`、`stores/useConsoleStore.ts`、`ConsoleLayout.tsx`、`ActivityBar.tsx`、`i18n/{en,zh}.ts`、前端测试   |

冲突文件如 `index.ts`：各自只加自己的行，提交前 `git status` 自查。

## P0 验收

1. `POST /api/browser/launch` 后 `GET /api/browser/stream` 持续出帧；前端侧边栏可见画面、地址栏可导航、点击输入可用。
2. pane 内 `tmuxgo_browser_navigate` + `snapshot` + `click` 闭环可用，画面实时同步。
3. eslint / prettier / typecheck 通过；gateway browser-manager 有单测。

## 已知边界

- screencast ~5fps：看视频不流畅；视频场景后续走 VNC 备选。
- headless shell 不支持扩展；需要扩展时切 `--headless=new` 或 Xvnc 路线。
- 远程 host 浏览器（agent relay 中继 CDP 帧）为 P1。
