# 今晚两个任务（来自 review 派发端 devin@TmuxGo:1.1 回:%556）

完成后以 `DONE` 开头回执，附：改动文件清单、验证结果（lint/typecheck/test/build）、遗留风险。
先用 todo_write 拆任务再动手。全程遵守 AGENTS.md（eslint/prettier/typecheck 必过；非显而易见逻辑写注释；测试只在名为 test 的 tmux session 里做）。改完按仓库惯例提交 commit（参考 git log 风格），不要 push。

---

## 任务1：Python 文件函数跳转慢/无反应 —— 优化 `resolveGenericDefinition`

**现状**（apps/frontend/src/lib/code-navigation.ts）：非 TS/JS 文件走 `resolveGenericDefinition`：
本地文件正则 → 已打开编辑器 → `searchContent(entryDir)` → `searchContent('')` 全 root。问题：

1. 全 root（如 `home=~`）rg `-uu` 无差别扫全部文本文件（含 md/json/log，5M 上限），常打满 12s AbortSignal 超时；
2. 期间 `definitionPendingRef`（EditorWorkbench.tsx:362-391）互斥吞掉后续点击 → 用户感知"没反应"；
3. entryDir 没命中就直接跳整 root，中间范围完全没利用。

**方案（按优先级做，均已评估）**：

### P0 import 直解快速路径（Python 主要场景：跳 import 来的函数）
`extractImportModuleHints` 已能产出 module 提示（`from a.b import word` → `a/b`、`a/b/word`）。在跑 rg **之前**，把提示直接解析成文件：
- 以入口文件 absolutePath 的目录为基准，逐级向上（最多 3 级，不超过 rootPath）：`joinPath(ancestorDir, hint)` 尝试 `*.py`、`*/__init__.py` 候选，用 `readResolverFile`（带缓存、限 root 内）读取；
- 读到文件后跑 `findGenericDefinition` 定位行号返回；
- 相对 import 要正确处理：`from . import x` / `from ..pkg import x` —— N 个前导点 = 从入口目录向上 N-1 层（PEP 328）。注意现有正则 `[\w.]+` 会把前导点吞进 modulePath 再 `.replace(/\./g,'/')` 导致 `..pkg` → `//pkg` 被 normalize 成 `pkg`（语义错误），需要单独解析前导点数量再拼接路径；
- 此路径成功 = 零 rg 调用，跳转应 <100ms。

### P1 逐级后退的范围搜索（用户原案，替代现在的 entryDir→root 二段跳）
rg 兜底搜索范围序列：`[entryDir, 上级, 上上级, 上上级]` 即最多退 3 级（clamp 到 root 内、去重），**顺序执行、首个出 def 命中的范围即返回**；全部落空后才轮到 `''` 整 root 兜底（保留现有 12s 超时，语义不回归）。典型 Python 项目 def 都在同包/父包内，实际几乎不会走到 root。

### P1 按扩展名收窄 rg 扫描
`searchContent` 增加可选 `ext` 参数（前端 api.files.searchContent → gateway `search-content` route → `searchContentWithRg` 加 `-g '*{ext}'`；`searchContentFallback` walk 时按文件名后缀过滤）。code-navigation 调用处传入口文件扩展名（`.py`→只扫 `*.py`）。旧 gateway 收到未知参数会忽略，天然向后兼容。FilePanel 的通用搜索不传 ext，行为不变。
注意 `searchContent` 的 q 是分词模型（空格/`|`），不要试图塞正则进去。

### P2 跳转中不再静默吞点击
`goToDefinition` 里 `definitionPendingRef` 现在直接 return。改为：`resolveEditorDefinition` 增加可选 `AbortSignal`，贯穿到每次 `searchContent`；新一次跳转请求 abort 上一个再启动（pending 检查从"吞掉"变"取消重发"）。若实现复杂度失控，至少保证慢搜索期间用户看到 pending 提示（如 >800ms 未返回时 toast/状态栏提示"跳转搜索中"），别让点击石沉大海。

**验证**：`code-navigation.test.ts` 已有 mock 基建（searchContentMock），补用例：import 直解命中（不发 searchContent）、逐级后退顺序（断言 basePath 序列）、ext 参数透传、相对 import。跑 `pnpm --filter frontend test`（或仓库对应命令）+ lint + typecheck。

---

## 任务2：手机端桌面连接 `novnc client module HTTP 404`、无密码弹窗

**根因已定位**（不用猜）：生产 gateway 跑的是 `apps/gateway/dist/index.js`，而 dist 是 commit `2954f73`（引入 `/api/vnc/client-module` 兜底路由）**之前**的旧构建——`grep client-module apps/gateway/dist` 无结果；journal 里 `02:05:22 GET /api/vnc/client-module → 404`（tailscale 移动端）。移动端浏览器命中动态 import 死锁 → fallback fetch 打在不存在的路由上 → 404 → RFB 建不起来 → `credentialsrequired` 永远不来 → 没密码弹窗。密码弹窗缺失是同一根因的症状，不是独立 bug。

**要做的**：

1. **修部署**：`pnpm --filter gateway build` 重建 dist（确认 `grep client-module apps/gateway/dist` 有输出），`systemctl --user restart tmuxgo-gateway`。验证 `curl -s http://127.0.0.1:3001/api/vnc/client-module`（带鉴权）返回 200 且是 rfb js 内容。前端 dist 已含 `rfb-Cw3mtRGP.js`，但如果你动了前端代码要重新 `pnpm --filter frontend build`。
   - 注意：`npm run --workspace=gateway start` 的 cwd 是 `apps/gateway`，`path.resolve(cwd,'../frontend/dist')` 解析正确，这条不用改。
2. **防回归**：`rfb-*.js` chunk 名依赖打包器命名，哪天变了路由又静默 404。vite `build.manifest: true` 产出 `.vite/manifest.json`，gateway 路由改为：优先读 manifest 找 `@novnc/novnc` 对应 chunk，找不到再退回现有 `rfb-[\w-]+.js` glob。manifest 里 chunk 的 file 字段即 assets 路径。
3. **移动端提速**：`novnc-loader.ts` 现在所有端都先跑 5s import 竞速才走 fetch 兜底。移动 UA（`navigator.userAgentData?.mobile` 或 `/Android|iPhone|iPad|Mobile/i`）直接 fetch→blob import 起步，省掉 5s 死等；fetch 失败（如老 gateway 无路由）再退回直接 import。桌面端顺序不变。注释里说明两套顺序的原因。
4. **顺手验证**：密码弹窗链路（DesktopView.tsx credentialsrequired → 表单 → sendCredentials）代码走查一遍确认移动端无额外障碍即可；有条件可用 dev 实例 + 本机 VNC display 实测连接。`TMUXGO_VNC_DEBUG=1` 已在 prod 开启，改完可看 journal 确认。

---

## 任务3：手机端 windows 抽屉里按 window 展开 pane 列表，点 pane 直达跳转

**现状**：`MobileDrawer.tsx` 的 `type==='windows'` 只渲染 `sessionWindows` 平铺列表（名字+#index），没有 pane 概念；`type==='panes'` 实际是 QuickActions。移动端无法直接跳指定 pane。

**数据已就绪，不用动 gateway**：
- `useSessionPanes(hostId, sessionId)`（hooks/useApi.ts:489）→ `GET /api/hosts/{h}/sessions/{s}/panes`，每个 pane：`{id:'local:%N', tmuxPaneId, windowId:'local:@N', index, title, active, size:{cols,rows}, windowName, agent?...}`
- 选中链路照抄桌面端 `SessionPanel.tsx:310-326`：`pane.windowId !== activeWindowId` 先 `api.windows.select(hostId, sessionId, windowId)`，再 `api.panes.select(paneId)`，`api.snapshot.get` 刷新 queryClient `['session-snapshot',h,s]` 缓存，`setActivePane(paneId)`。drawer 里可直接用 `useSessionSnapshot` 已有缓存。

**UI 要求（ui 统一）**：
- window 行保持现有 `rounded-apple`/`bg-bg-2`/active accent 样式；右侧加展开 chevron（▸/▾ 旋转过渡）+ pane 数徽标（如 `·3`），chevron 点击 stopPropagation 不触发窗口切换；行本体点击仍是选窗口。
- 展开后 pane 行缩进一级（如 `ml-4`/`pl-3` + 左边框线可选），每条显示 `title`（兜底 'shell'）+ `#index`，active pane（`pane.id===activePaneId`，取 store 或 snapshot.activePaneId）用 accent 标识；点 pane → 选中窗口（若非 active）+ 选中 pane → `handleClose()`。
- 默认展开 active window，其余折叠；展开状态用本地 useState<Set<string>>，drawer 重开时重置。window 数很多时 pane 行别把整个抽屉撑爆——列表区已有 `max-h-[75%]`+滚动，无需额外处理。
- `windowBatchMode` 下保持现有批量勾选 UI，不展开 pane（批量是针对 window 的操作）。
- i18n：zh.ts/en.ts 补需要的 key（如 pane 计数 `drawer.paneCount` 之类），复用现有 `drawer.*`/`window.*` 命名风格；别硬编码中文。
- `MobileDrawer.test.tsx` 已有基建，补用例：展开/折叠、pane 点击触发 windows.select+panes.select 顺序、batch 模式不出现 pane 行。

**验证**：`pnpm --filter frontend test` + lint + typecheck；改完 `pnpm --filter frontend build`（prod dist 随请求读取，但要重新 build 才生效）。

---

## 收尾
三个任务都完成后：确认 prod 网关已重启、前端 dist 已重建；然后回执 `DONE` + 上述清单。
