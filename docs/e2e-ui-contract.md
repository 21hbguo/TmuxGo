# e2e 与 UI 契约（改 UI 前先看这一页）

e2e 不是"点一遍看看"，它和 UI 之间有一份隐性契约：**UI 的哪一部分是断言锚点，锚点变了 e2e 就会红**。
这份文档把历史上真实漂过的六处记下来，每条都回答三件事——断言什么、怎么变会漂、改了要同步改哪个 spec。

处置原则（红了先分类，别急着改产品）：

1. **断言跟 UI 走**：UI 有意改了表达，锚点消失 → 改 e2e 换等价锚点。
2. **选择器收紧**：DOM 结构没变但匹配变宽（新增同 role/同名元素）→ 收紧 e2e 选择器。
3. **真 bug**：UI 行为与文档承诺不符 → 停手，单独立单，不在 e2e 里打补丁掩盖。

---

## 1. 编辑器光标：没有「Ln x, Col y」文案

- **契约**：编辑器的光标位置是**模型状态**，不是头部文案。`getNavigationPosition`
  优先读存活实例（`apps/frontend/src/components/EditorWorkbench.tsx:338`），`cursorById`
  只是 React 提交后的快照兜底。
- **断言什么**：`e2e/editor-navigation.spec.ts` 的 `waitCursorCommitted` 读 monaco 模型
  `getPosition()`，并等一帧 `requestAnimationFrame` 让 React 提交 `cursorById` 后再触发快捷键。
- **怎么变会漂**：编辑器头部在 `c402f04`「收成单行」时删掉了 `Ln x, Col y` meta 行。
  任何"等这行文案出现"的等待都会永远超时，而且**失败在前置断言上，跳转逻辑一次都没跑**
  （表现为 10 例同时红，很容易误判成导航坏了）。
- **改了要同步**：`e2e/editor-navigation.spec.ts`；`e2e/editor-scroll-restore.spec.ts`
  同样只读模型/滚动位置（下面第 7 条）。

## 2. 任务中心：入口是事件，不是侧栏 tab

- **契约**：`tmuxgo-open-tasks` 是应用内事件，派发方是任务完成通知
  （`apps/frontend/src/components/TaskNotifications.tsx:53`），监听方是 `ConsoleLayout`
  （`apps/frontend/src/components/ConsoleLayout.tsx:771`）。
- **断言什么**：`e2e/tasks.spec.ts` 的 `openTaskCenter` 在 `expect.poll` 里派发同一事件，
  以「`Tasks / 任务中心` 标题可见」为准重试。
- **怎么变会漂**：侧栏的那个 tab 已在 `c73efe2` 移除；再想"点侧栏进任务中心"没有入口。
  另外 `goto` 返回时 `ConsoleLayout` 可能还没挂载，一次性派发会被丢弃 → 必须重试。
- **改了要同步**：`e2e/tasks.spec.ts`；若事件改名，`TaskNotifications` / `ConsoleLayout` /
  `tasks.spec.ts` 三处一起改。

## 3. 下拉框：自定义 combobox，不是原生 `<select>`

- **契约**：`Select.tsx` 的 inline 变体（`apps/frontend/src/components/Select.tsx:188`）
  是 `role="combobox"` 的 **button**，值挂在 `data-value`（:204），选项是 `role="option"`
  且各自带 `data-value`（:236）。
- **断言什么**：值用 `toHaveAttribute('data-value', …)`；选值先开列表，再按
  `[role="option"][data-value="…"]` 点。`e2e/multi-host.spec.ts` 的 `pickHost` 是范本。
- **怎么变会漂**：
  - `toHaveValue()` 会报 `Not an input element`，`selectOption()` 直接不可用。
  - 选项**文案随 locale 变**（同一条目可能是 `local-machine` / `本机`），按文案选会脆。
  - 切换器外层是 `<label>`：点按钮会经 label 再转发一次 click，主机切换后偶发"开了又立刻关"
    → 开列表用键盘（`focus` + `Enter`），并先看 `aria-expanded` 判断当前是否已展开
    （已展开时 `Enter` 是"确认当前项"，会把列表关掉）。
- **改了要同步**：`e2e/multi-host.spec.ts`、`e2e/file-panel-session.spec.ts`（根目录选择器）。

## 4. 终端输入：只有 WS，没有 REST

- **契约**：键盘输入走 WS 的 `input` 帧（`apps/gateway/src/routes/stream.ts:322`），
  没有 `POST /api/hosts/:hostId/sessions/:id/input` 这个 REST 端点。
- **断言什么**：`e2e/repro-switch.spec.ts` 的 `sendKeys` 直接对 **e2e 隔离的 tmux server**
  发 `send-keys`：显式 `-S <socket>` + `TMUX=''`，绝不触达用户的 default server。
- **怎么变会漂**：任何还调 `/sessions/:id/input` 的写法会拿到 `{"message":"Not found"}`；
  失败点看起来像"终端没输出"，实际是注入没发生。
- **改了要同步**：`e2e/repro-switch.spec.ts`；需要"真的敲键盘"的场景优先用
  `page.keyboard` + `openSession`，只有验证 pane 内容时才用 `send-keys`。

## 5. 终端渲染：桌面端是 WebGL，DOM 里没有行元素

- **契约**：非移动端会尽量加载 WebGL addon（`apps/frontend/src/lib/terminal-core.ts:69-81`），
  行画在 `<canvas>` 里；`recordRenderer` 记录当前是 `dom` 还是 `webgl`。
- **断言什么**：
  - **文本**从 `__tmuxgoTerminal.buffer.active` 读（`getLine(i).translateToString(true)`），
    不是 `document.querySelector('.xterm-rows').textContent`。
  - **几何**优先 `.xterm-rows`（DOM 渲染器），回退 `.xterm-screen`（WebGL，`canvas` 的父层）。
  - 尺寸一致性用 `cols * cellWidth` 与渲染面宽度对齐，别去量行元素。
- **怎么变会漂**：WebGL 下 `.xterm-rows` 为空/不存在 → `textContent` 是 `''`、
  `lastElementChild` 是 `null`，断言会以"终端空白""末行不存在"的形式红。
  context 丢失时会 dispose 回退 DOM renderer，所以**两种渲染器都可能出现**，断言要同时成立。
- **改了要同步**：`e2e/terminal-rendering.spec.ts`（`bufferVisibleText` / `getRenderMetrics`）、
  `e2e/terminal-gutter.spec.ts`（末行/渲染面底边）、`e2e/multi-client-arbitration.spec.ts`
  的 `termState`、`e2e/render-dedup.spec.ts` 的尺寸测量。

## 6. 窗口 chip：`role="tab"`，不是按钮

- **契约**：窗口条是 `role="tablist"` + 每窗 `role="tab"`
  （`apps/frontend/src/components/WindowTabs.tsx:290,299,320`）；tab 内还嵌了「关闭」按钮。
- **断言什么**：`page.getByRole('tab', { name: … })`；因为内层按钮的 aria-label 也参与
  可访问名计算，用文字包含匹配而不是精确名。
- **怎么变会漂**：写成 `getByRole('button', …)` 会 10s 超时（元素存在但 role 不匹配），
  报错只说 "waiting for … to be visible"，很容易误判成窗口没渲染出来。
- **改了要同步**：`e2e/render-dedup.spec.ts`；批量选择态下 tab 禁用、文案前缀 `☑/☐` 也会影响匹配。

---

## 7. 次级契约（同样漂过，写在这里免得再踩）

| 主题           | 契约                                                                                                             | 断言写法                                                                                           | 怎么变会漂                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 文件面板       | 行数超过视口两倍时窗口化渲染（`FilePanel.tsx:406` 的 `shouldVirtualize`）                                        | 用 `[data-row-path="…"]` 定位；必要时有界滚动（≤10 次 × 200px）直到行进 DOM                        | 直接 `toBeVisible()` 会因"元素根本没渲染"而红；按文件名搜索当导航手段也不行（过滤会藏掉不匹配的子项，且与展开状态互相重置） |
| 侧栏按钮       | 同一文案可能有多个 `role="button"`（可排序会话行也带 role）                                                      | `getByRole('button', { name })` 后 `.first()`，或加限定容器                                        | strict mode violation：`resolved to 2 elements`                                                                             |
| 新建会话名     | 名字会被规范成 tmux 安全名（前缀 `session-<host>-`，见 `apps/gateway/src/lib/tmux-target.ts:19`，重名再补 `-N`） | 断言 `toHaveValue(new RegExp(name))`，再用 `inputValue()` 拿实值做后续核对                         | 硬等原名会红，且报错只显示期望/实际字符串，容易误判成"导入失败"                                                             |
| 编辑器滚动恢复 | 恢复的是**光标**，随后 reveal 会把该行滚进视口                                                                   | 随机用例只断言光标往返；滚动位置仅在"光标在视口内"的场景断言（并按 `min(设值, 当前 maxTop)` 比较） | 拿任意 `scrollTop/scrollLeft` 当绝对期望会红——monaco 会钳制（行尾、文件末尾、横向尽头），reveal 也会改写 `scrollTop`        |
| 后台页能力     | 后台/旁观端不得改远端尺寸，也不得写 pty；从"变后台"到"重附着为 passive"是**异步**的                              | 等足够窗口（当前 2.5s）再断言；不要用"本地 resize 是否被采纳"做探针                                | 探针本身会触发重新 attach，把被测页又变回 active，反而制造红                                                                |

---

## 8. tmux 版本与环境

- **基线**：网关认为 `3.6b` 及以上才算达标（`apps/gateway/src/lib/security.ts:4`），
  低于基线会在启动时打一行 `[security] tmux … is below the recommended security baseline`。
- **现状**：CI 与开发机**都是发行版 tmux 3.4**（CI 直接 `apt-get install tmux`，
  日志里同样有那行 baseline 告警）。所以"本地 3.4 / CI 3.6b"这个组合目前不存在，
  **不要把本地红/绿差异归因到 tmux 版本**——先怀疑并发、时序、残留状态。
- 真正对 tmux 版本敏感、将来升级到 3.6b 时要重点回归的地方：
  - `select-layout` 的 preset 校验（非法 preset 的报错文本会原样透出到网关 500 消息里）；
  - copy-mode 判定（`#{pane_in_mode}`）与滚轮进入 copy-mode 的时机；
  - `display-message -p` 的格式串与状态行行数（`#{status}` 影响 `rows` 计算）；
  - 窗格尺寸协商（`window_width/window_height` 与客户端 cols/rows 的换算）。
- **隔离纪律**：所有 tmux 操作显式 `-S <socket>` + 清 `TMUX`；测试一律只碰名为 `test`
  的会话；禁止批量 `kill-server`（`TMUX` 存在时 tmux CLI 会忽略 `TMUX_TMPDIR`，
  会误杀用户自己的 server）。

---

## 9. 红了怎么办（三步）

1. 单跑该 spec（`npx tsx scripts/run-e2e.ts <spec> --reporter=line`），拿到**第一处**失败的锚点，
   确认失败发生在"前置断言"还是"被测行为"——上面六条里至少三条历史上都是前置断言先死。
2. 对着本文档找同名锚点，判断属于"UI 有意改（跟 UI 走）"还是"匹配变宽（收紧）"还是"真 bug（停手立单）"。
3. 改完跑默认全量，别只看单例：`npx tsx scripts/run-e2e.ts`。本地绿不等于 CI 绿——
   `playwright.config.ts:14` 在 CI 下 `retries: 1`（本地 0），worker 数由
   `TMUXGO_E2E_WORKERS` 决定（默认按 CPU 核数），本机与 runner 的核数、时序都不同。
   以 PR 的 `e2e` job 为准。
