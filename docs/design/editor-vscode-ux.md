# 编辑区 VSCode 化改造（2026-10）

> 目标：把编辑区从「能看能改」提升到「日常改文件不用切 IDE」，功能对齐 VSCode 的**编辑人体工学**，
> 但不引入语言服务器、调试器、扩展宿主。所有能力可用键盘完成，且打字路径零额外渲染。

## 1. 边界：要什么、明确不要什么

用户要求「像 VSCode 一样好用」，与 `docs/ROADMAP.md` 里「editor 不做 IDE」的红线看似冲突。判定口径：

- **要**：编辑行为、导航、视图开关、标签管理、状态可见性——即「打开文件之后怎么改得顺手」。
- **不要**：LSP 语义（补全/诊断/重命名）、调试器、项目管理面板、扩展市场、内置终端。
  这些是 code-server（79724★，最后核查 2026-10-30）的地盘，做了也打不过，还拖垮核心层投入。

因此实现全部落在 Monaco 0.56 已有 API + 自写轻量 UI，**零新增依赖**。

> 2026-10 例外（R1）：markdown 的「预览即可编辑」需要吞掉语法标记，Monaco 0.56 无 `Decoration.replace`
> 与 atomic ranges，只能靠 CSS 隐藏，光标/IME 会落进不可见文本；因此 markdown 的 live 模式改用
> CodeMirror 6（8 个包，MIT，锁小版本），Monaco 仍负责源码模式/其他语言。边界与账单见
> `docs/design/editor-render-upgrade.md`。

## 2. 参考项目与取舍

| 项目 | star | 借了什么 | 没借什么 |
| --- | --- | --- | --- |
| [microsoft/vscode](https://github.com/microsoft/vscode) | 194342 | 键位表（Ctrl+G / Ctrl+Shift+O / Ctrl+K 和弦 / Alt+Z / Ctrl+1..9）、状态栏信息层级、面包屑符号路径、标签右键菜单项命名、sticky scroll | 命令系统全量注册表、扩展宿主 |
| [microsoft/monaco-editor](https://github.com/microsoft/monaco-editor) | 46917 | `addAction`/`getAction`、`stickyScroll`、`getVisibleRanges`、`pushEditOperations`（换行符整篇改写仍可撤销） | — |
| [suren-atoyan/monaco-react](https://github.com/suren-atoyan/monaco-react) | 4757 | `options` 复用与 `path` 复用 model 的用法（据此做 options 缓存） | — |
| [coder/code-server](https://github.com/coder/code-server) | 79724 | 反面参照：浏览器里塞整个 IDE 的代价（包体、内存、启动） | 不引入其架构 |
| [eclipse-theia/theia](https://github.com/eclipse-theia/theia) | 21726 | 反面参照：插件化 IDE 的复杂度 | — |
| [zed-industries/zed](https://github.com/zed-industries/zed) | 92387 | 状态栏「少而准」的信息密度取舍 | GPUI/自绘渲染 |
| [ajaxorg/ace](https://github.com/ajaxorg/ace) | 27131 | 轻量编辑器可以做到什么程度的下限对照 | — |

> codemirror/dev（7808★，**archived**）、voideditor/void（28727★，**archived**）只作生态现状参考，不采用。

## 3. 能力矩阵（全部可键盘触发）

| 能力 | 入口 | 实现位置 |
| --- | --- | --- |
| 转到行/列（支持 `12`、`:12`、`12:5`） | `Ctrl+G`、状态栏行号 | `EditorQuickPick` + `lib/editor-quickpick` |
| 转到符号（缩进/正则大纲，非 LSP） | `Ctrl+Shift+O`、面包屑文件名 | `lib/editor-outline` |
| 文档格式化 | `Shift+Alt+F` | Monaco `editor.action.formatDocument` |
| 查找 / 替换 | `Ctrl+F` / `Ctrl+H` | Monaco 原生（Ctrl+H 映射 `editor.action.startFindReplaceAction`） |
| 选中同词多光标 | `Ctrl+D` / `Ctrl+Shift+L` | Monaco 原生，**不拦截** |
| 上下加光标 | `Ctrl+Alt+↑/↓` | Monaco 原生 action |
| 标签关闭族 | `Ctrl+W` / 右键菜单：关闭、关闭其它、关闭右侧、关闭已保存、全部关闭（`Alt+K W`） | `lib/editor-tab-actions` + store `closeEditors(ids)` |
| 重开已关闭标签 | `Ctrl+Shift+T`（栈深 10） | store `closedEditors` |
| 全部保存 | `Alt+K S` 和弦（`Ctrl+K` 已被应用命令面板占用） | 串行保存 + 聚合失败提示 |
| 组间焦点 | `Ctrl+1..9`、`Ctrl+PageUp/PageDown` | 组顺序由布局树推导 |
| 拆分 | 标签右键 / 工具栏 `⋯` → 向右、向下（4 组上限） | `placeEditorInSplit` |
| 换行符 CRLF/LF 切换（含混合检测） | 状态栏 `CRLF` | `lib/editor-status` + `pushEditOperations` |
| 缩进探测与切换（空格 2/4、Tab） | 状态栏缩进项 | `detectIndent` + `model.updateOptions` |
| 空白字符可视化 | 状态栏 `¶` 循环 none/boundary/all | `renderWhitespace` |
| 自动换行 / minimap / sticky scroll | 状态栏 + `⋯` 菜单 | `lib/editor-view-prefs`（持久化） |
| 三区独立缩放 | 编辑区：状态栏百分比 / `Ctrl+滚轮` / `Ctrl+±0`；终端区：终端内 `Ctrl+滚轮` / 焦点在终端时 `Ctrl+±0`；其他区（外壳/侧栏/标签/状态栏/弹窗）：其余位置 `Ctrl+滚轮` / `Ctrl+±0` | 三套比例独立持久化；编辑区 9 档（fontScale），终端 9 档（terminalScale），UI 9 档（uiScale）；编辑区内容随外壳 zoom 反向抵消，终端同理 |
| 自动保存（可配延迟 400–10000ms） | `⋯` 菜单 | 同上 + 防抖 effect |
| 面包屑（目录 + 符号路径） | 顶部条 | `EditorBreadcrumbs` |
| 快捷键speedsheet | `Ctrl+Shift+/`、`⋯` → 显示快捷键 | `EditorShortcutsDialog` |
| 命令面板里搜到上述全部命令 | `Ctrl+K`（应用级命令面板，本仓既有键位） | `lib/editor-command-bus` |

### 键位冲突与浏览器保留键

- `Ctrl+K`：本仓是应用级命令面板（`ConsoleLayout`），编辑器**不拦截**，因此和弦前缀改为 `Alt+K`。
  单测 `resolveEditorKey({key:'k',ctrlKey:true}) === null` 锁死这一点，防止以后抢回来把面板弄哑。
- `Ctrl+F` / `Ctrl+D` / `Ctrl+H`（查找/多光标/替换）、`Ctrl+S`、`Ctrl+W` 一律交给 Monaco 或既有逻辑，不拦截。
- 浏览器保留键：`Ctrl+1..9`、`Ctrl+PageUp/Down`、`Ctrl+=`/`-`/`0` 在 Chrome 里可能被浏览器先处理；
  缩放在 window 捕获阶段 `preventDefault` 并验证有效，Ctrl+滚轮另用 `passive:false` 拦住浏览器整页缩放；
  路由规则是「滚轮看指针、键盘看焦点」，编辑区/终端区/其他区各改各的 store，不联动。
  编辑区缩放仍保留状态栏/命令面板入口；终端与 UI 缩放目前只有键盘/滚轮入口。
  键盘只是加速器——这条与 VSCode Web / code-server 的限制一致。

## 4. 性能设计（打字不改整树）

1. **光标外置**：`onDidChangeCursorPosition` 不再 `setState`，写入 `lib/editor-cursor` 的 rAF 合并 store；
   状态栏、面包屑各自 `useSyncExternalStore` 订阅 → 打字时只有这两个小节点重渲染，工作台 0 次。
2. **派生数据防抖**：大纲 300ms、选区统计 250ms、缩进/行尾 250ms；小文档（≤16KB）markdown 预览保持同步，大文档加 220ms 防抖。
3. **Monaco options 缓存**：按 `(language, tabSize, insertSpaces)` 记忆化，避免每次渲染把新对象塞给 Monaco 触发 `updateOptions`。
4. **行号映射去二次方**：markdown 预览的 `data-line` 注入原本每块都 `countLines(content.slice(0, offset))`，
   200KB 文档 3.8s → 0.8s（jsdom；浏览器同比例）。修复见 `apps/frontend/src/lib/markdown.ts` 的 `createLineCounter`。

### 实测（`npx tsx scripts/measure-editor-latency.ts`，本机 Node 22，p95）

| 场景 | p50 | p95 | 预算 |
| --- | --- | --- | --- |
| 大纲 20k 行 TS | 6.18ms | 7.88ms | 80ms |
| 大纲 20k 行 Markdown | 1.53ms | 4.65ms | 80ms |
| 快速选择 2k 项 × 8 次输入 | 3.46ms | 4.39ms | 60ms |
| 缩进探测 40k 行 | 0.89ms | 1.43ms | 30ms |
| 行尾探测 40k 行 CRLF | 0.38ms | 0.42ms | 30ms |
| CRLF→LF 全文改写（600KB） | 1.32ms | 3.32ms | 60ms |
| 选区统计 10k 行 | 0.01ms | 0.01ms | 5ms |
| 500 标签批量关闭三连 | 0.08ms | 0.11ms | 5ms |
| 行号解析 ×1000 | 0.12ms | 0.38ms | 5ms |

9/9 在预算内。CI 由 `apps/frontend/src/lib/editor-perf.test.ts` 单手守（阈值留 5–30 倍冗余，只拦 O(n²) 级退化）。
命令：`pnpm measure:editor`（纯函数基线）、`pnpm measure:editor:browser`（真实浏览器，见下）。

### 真实浏览器（Chromium，Playwright，`e2e/editor-latency.spec.ts`）

400 行 TS fixture，隔离 tmux server + 临时 dist，`pnpm measure:editor:browser` 一条命令跑完：

| 指标 | 实测 | 预算 | 口径 |
| --- | --- | --- | --- |
| 打字 keydown→绘制 | p50 11.5ms / p95 18.0ms / max 18.1ms（n=30） | p95 50ms | 页面内 keydown 时间戳 → 模型内容变化后下一帧 |
| 光标移动→状态栏更新 | 19ms | 100ms | setPosition → 状态栏文案含新行号 |
| Ctrl+G → 面板可见 | 18ms | — | 键盘事件 → 面板 DOM 可见 |
| Enter → 光标落到 122:7 | 38ms | — | Enter → 模型 getPosition 命中 |
| 打开 400 行文件→可输入 | < 1.5s（断言通过） | 1500ms | 点击文件行 → Monaco 实例挂载且行数正确 |

> 打字 p95 恰好贴在 2 帧内（16.7ms/帧）：状态栏与面包屑订阅独立 store，工作台不参与重渲染；
> 若哪天有人在 `onDidChangeCursorPosition` 里 `setState`，这条会立刻红。

## 5. 测试与验证

- 单测/组件测试：`lib/editor-{status,outline,quickpick,tab-actions,commands,view-prefs,cursor,command-bus}`、
  `EditorStatusBar`、`EditorBreadcrumbs`、`EditorQuickPick`、`EditorContextMenu`、`EditorShortcutsDialog`、`CommandPalette`。
- 集成：`EditorWorkbench.test.tsx` 78 例，新增 16 例覆盖 Ctrl+G/符号面板/和弦保存/标签菜单/重开/自动保存/状态栏/面包屑/视图开关关闭/不吞 Ctrl+F、Ctrl+D。
- 全量：前端 `175` 文件 `1764` 通过（24 skip）；根 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build` 见验收记录。
- 真实浏览器延迟：`e2e/editor-latency.spec.ts` 4 例全绿（见 §4 表格），由 `pnpm measure:editor:browser` 驱动。

## 6. 后续可做（未开工）

- 多光标/列选择的预览联动（现在只跟随主光标）。
- 标签溢出滚动条的拖拽（现在是横向滚动 + 自动 reveal）。
- 符号大纲替换为 `editor.action.quickOutline`（Monaco 原生，更准）作为可选项，与轻量大纲并存。
- 状态栏「问题数」需要 LSP，明确不做。
