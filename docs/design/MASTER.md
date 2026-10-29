# TmuxGo Design System — MASTER

来源：`nextlevelbuilder/ui-ux-pro-max-skill`（GitHub 142,397 ★，MIT，2026-10-26 最后 push）。
本文件是该 skill `--design-system` 流程在本项目的落地产物，后续新增页面/组件以本文件为准。

## 0. 检索证据（skill CLI 实际输出）

> skill 仓库临时克隆在 `.dbg/ui-audit/skills/`（`.dbg/` 已 gitignore，可随时删除；复跑命令见下）。

```bash
# 产品画像
python3 .dbg/ui-audit/skills/ui-ux-pro-max/scripts/search.py "developer tools dashboard" --domain product
# → Developer Tool / IDE · Dark Mode (OLED) + Minimalism & Swiss Style
#   · 次级 Flat Design + Bento Box Grid · Dashboard: Real-Time Monitor + Terminal
#   · 色板重点: Dark syntax theme colors + Blue focus

# 风格
python3 .dbg/ui-audit/skills/ui-ux-pro-max/scripts/search.py "dense data desktop app chrome" --domain style
# → data-dense-dashboard: grid 8px, card padding 12px, 12–14px type, sticky headers, 36px row

# 字体
python3 .dbg/ui-audit/skills/ui-ux-pro-max/scripts/search.py "terminal ide productivity" --domain product
# → JetBrains Mono / JetBrains Mono（terminal, cli, developer, precision）
```

结论：**Dark OLED + 瑞士式极简栅格 + JetBrains Mono + 蓝色 focus**，密度高、装饰少、层次靠明度台阶而非描边。

## 1. 方向：Calibrated Console（校准过的控制台）

一句话：像一台调校过的终端设备，而不是一堆灰色卡片。

- **层次靠明度**：4 级表面（canvas / panel / raised / hover），不用边框堆层级。
- **线条只做分隔**：hairline 7.5% 白，永远不围出完整盒子；分隔用「上边线 + 留白」，不用四边框。
- **一个强调色**：蓝色只出现在焦点、选中、主操作，其他一律中性。状态色只在有状态时出现（运行绿 / 等待琥珀 / 失败红）。
- **数字等宽**：所有指标、尺寸、计数走 `tabular-nums`，保证扫读对齐。
- **微观排版**：分组标题 9.5px / 0.14em / 600 字重 / text-3；正文 13px；标题 15px 600。
- **动效只做反馈**：120ms（hover）/ 160ms（面板），cubic-bezier(0.2,0.8,0.2,1)；不做入场动画。

## 2. Token

| Token              | 值（dark）               | 用途                                        |
| ------------------ | ------------------------ | ------------------------------------------- |
| `--bg-0`           | `10 11 13`               | 画布 / 终端底                               |
| `--bg-1`           | `18 20 24`               | 面板 / 侧栏                                 |
| `--bg-2`           | `32 35 42`               | 抬起面 / hover 底                           |
| `--bg-3`           | `44 49 59`               | 抬起面 hover（新）                          |
| `--line`           | `rgba(255,255,255,.075)` | hairline                                    |
| `--line-strong`    | `rgba(255,255,255,.14)`  | 需要更明确的分隔（新）                      |
| `--text-1`         | `240 243 248`            | 主文本                                      |
| `--text-2`         | `160 168 181`            | 次文本                                      |
| `--text-3`         | `112 120 134`            | 说明/标签（仍 ≥4.5:1 on bg-1）              |
| `--accent`         | `10 132 255`             | 焦点/选中/主操作                            |
| `--accent-text`    | `106 168 255`            | 小字号蓝字（新，解决 #0A84FF 小字对比不足） |
| `--accent-soft`    | `rgb(10 132 255 / .14)`  | 选中底色（新）                              |
| `--radius-control` | `8px`                    | 控件（新）                                  |
| `--radius-surface` | `10px`                   | 行/卡片（新）                               |
| `--radius-panel`   | `14px`                   | 面板（新）                                  |
| `--row-h`          | `34px`                   | 列表行高（新）                              |
| `--control-h`      | `30px`                   | 控件高（新）                                |
| `--tab-h`          | `30px`                   | 窗口标签高（新）                            |
| `--fs-micro`       | `9.5px`                  | 分组标题（新）                              |

浅色 / 高对比 / dracula / nord / catppuccin / sage 六个主题只覆盖基色，新增 token 用 `color-mix()` 从基色推导，保证 7 个主题一致，不逐主题手写。

## 3. 组件规则

- **导航条（rail）**：56px 宽，40px 圆形按钮；选中 = accent-soft 底 + 2px 左侧 spine + accent-text 图标；hover = bg-2/60。设置固定底部。
- **列表行**：34–44px，无边框，hover `bg-2/45`，选中 `accent-soft` + 2px spine；次行文字 10.5px text-3。
- **窗口标签**：30px，圆角 8 8 0 0，选中 = bg-0 + 顶部 2px accent 线；未选中无底，hover bg-2/55；关闭按钮仅 hover/选中可见。
- **状态栏**：28px，bg-1 + 顶部 hairline；指标成组，用 1px 竖线分隔（gap 10px）；数值 mono tabular；连接状态用 pill + 状态点。
- **快捷键盘**：分组标题 micro 文案；键帽 28px 高、圆角 6、1px line、hover 抬起 1px；危险键只描边不填色。
- **空态**：44px 圆角图标块 + 13px 标题 + 12px 说明（≤42ch）+ 最多 2 个动作；可带极淡点阵底纹。
- **登录页**：≥lg 双栏（左品牌 + 右表单），<lg 单列；品牌区用点阵底 + 产品名 + 版本号；表单控件 40px。

## 4. 反模式（禁止）

- 每个列表项四边框；同一屏超过 2 层玻璃；灰底灰字低对比；emoji 当图标；彩色渐变按钮；入场动画 / 视差。
- 图标按钮无 aria-label；去掉 focus ring；hover-only 才可用的关键操作。

## 5. 交付前检查（skill pre-delivery checklist + 本项目补充）

- [ ] 图标全部 SVG（react-icons），无 emoji
- [ ] 可点击元素 cursor-pointer，hover 150–300ms 过渡
- [ ] 文本对比 ≥4.5:1（含 text-3 小字、状态栏）
- [ ] `:focus-visible` 可见，不用 outline:none 裸删
- [ ] `prefers-reduced-motion` / `prefers-reduced-transparency` 降级
- [ ] 375 / 768 / 1024 / 1440 / 1600 宽无横向滚动、无重叠
- [ ] 7 个主题（dark/light/high-contrast/dracula/nord/catppuccin/sage）逐一验色

## 6. 2026-10 首轮落地（本次重构改了什么）

范围：壳层（导航 / 侧栏 / 窗口标签 / 状态栏 / 快捷键盘 / 空态 / 登录），不改业务逻辑与数据结构。

| 层         | 文件                                          | 改动                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 令牌       | `apps/frontend/src/app/globals.css`           | 4 级表面 `--bg-3`、`--line-strong`、`--accent-text`、`--accent-soft`、`--radius-{control,surface,panel}`、`--row-h/--control-h/--tab-h`、`--fs-micro`、`--elev-1/2`；light / high-contrast 单独补值；`--radius-apple` 16→12；全局底纹从对角彩雾降为径向微光 |
| 原语       | 同上                                          | `.tmuxgo-toolbar-icon` 30px/圆角 8/选中改 accent-soft；`.tmuxgo-list-row` 选中改底色 + 2px spine；窗口标签选中改顶部 2px 强调线；菜单/分段/状态栏 chip 统一                                                                                                 |
| 新壳组件类 | 同上                                          | `.tmuxgo-shell-rail`、`.tmuxgo-rail-spine`、`.tmuxgo-shell-sidebar__header`、`.tmuxgo-host-bar`、`.tmuxgo-session-meta`、`.tmuxgo-statusbar`、`.tmuxgo-quick-panel`、`.tmuxgo-workspace-empty`、`.tmuxgo-auth__*`                                           |
| 导航       | `ActivityBar.tsx`                             | 视觉上移到新 rail；设置从可拖拽序列移到 rail 底部固定簇；选中 spine 改类名实现                                                                                                                                                                              |
| 侧栏       | `SessionPanel.tsx` / `HostSwitcher.tsx`       | 主机条独占一行（不再与工作区各占半宽被截断）；工作区 + 实心主操作（新建）同行；低频工具退为安静图标行；会话行去下边框、名称 13px、元信息 10.5px；组头改 10px 大写字距标签                                                                                   |
| 空态       | `WorkspaceEmptyState.tsx`（新增）             | 图标块 + 标题 + 说明 + 两个动作 + 快捷键提示；拖拽悬停切换文案；点阵底纹做径向淡出                                                                                                                                                                          |
| 状态栏     | `StatusBar.tsx`                               | 去掉玻璃与 28px 固定高，改 30px 实底 + hairline；指标统一为安静文本组，hover 才浮出胶囊；窄屏隐藏主机名，避免被压成残影                                                                                                                                     |
| 快捷键盘   | `SessionPanel.tsx` / `QuickActions.tsx` / CSS | 容器改 `.tmuxgo-quick-panel`；键帽 30px 圆角 7；强调/危险键只描边不填色；≤820px 高时压到 26px；dock 与状态栏同高 30px，切换不跳版                                                                                                                           |
| 登录       | `AuthGate.tsx`                                | 新增 `AuthShell`：≥1024px 左品牌（标题 / 三条能力 / 版本脚注）右表单，窄屏单列；错误与改密页复用同一外壳                                                                                                                                                    |
| 文案       | `i18n/{zh,en}.ts`                             | 新增 `workspace.empty.*`、`auth.brand*`、`hostSwitcher.localTag` 等键，中英同步                                                                                                                                                                             |

回归：`pnpm --filter frontend exec vitest run` 覆盖 `ActivityBar / AuthGate / StatusBar / DesktopWorkbench / WorkspaceEmptyState / ConsoleLayout / QuickActions / KeyCap / ListRow` 全绿；`tsc --noEmit`、`eslint`、`prettier` 通过。

## 7. 第二轮：深入面板与对比度（2026-10-30）

第一轮改的是壳层，第二轮补「进去之后」的界面，并把配色从「看起来对」变成「量过」。

### 7.1 文件面板：5 行 chrome → 3 行

原来标题下依次是「根切换行 / 搜索行 / 类型过滤行 / 工具行」，260px 侧栏里有 190px 不是文件树。

- 根切换并入搜索行（`w-[6.75rem]` 定宽，超出省略 + `title` 给全路径），面包屑独占一行只回答「我在哪」。
- 类型过滤段与 6 个工具按钮合并成一行 `.tmuxgo-file-tools`：24px 图标键 + `flex-wrap` 兜底，260px 下正好 9 个控件一行。
- 结果：文件树首行上移 57px（1600×1000 实测：apps 行 y=184 → 127），等于多显示两行文件。

### 7.2 编辑区：标签、顶栏、焦点框

- 标签从 24px 定宽块改为 `.tmuxgo-editor-tab`：30px、圆角 8、内容自适应（`min-w-[7.5rem] max-w-[15rem]`）、选中 = 与内容同色 + 顶部 2px 强调线；与终端窗口标签同一套语言。
- 顶栏 `.tmuxgo-editor-head`：30px 实底，路径从 14px 正文降为 11px mono 辅助信息；7 个动作收进 `.tmuxgo-editor-tools`，22px 高度、无边框、hover 才浮底色，`变体 accent` 表示当前预览模式。
- 去掉「整块编辑区一圈 accent 描边」——单栏时它像给工作面套了个焦点框；只有分屏（`isEditorLayoutSplit`）才保留，用来回答「哪一栏是激活的」。
- 踩坑记录：`Button` 组件恒带 `tmuxgo-icon-button` 基类（24px 定宽），文字按钮必须 `:not(.tmuxgo-button--icon-sm):not(.tmuxgo-button--icon)` 才能放开宽度，否则「清空 / 查找 / 预览」会挤成 24px 互相压字。

### 7.3 对话框与设置

- `--glass-fill-strong` 深色档从 `rgb(255 255 255 / 14%)` 改为 `rgb(var(--bg-2) / 0.86)`：14% 白叠在模糊层上会把弹窗顶成灰板，改成 bg-2 半透明后仍是「深色 + 抬升」。
- `.tmuxgo-settings h3` → 10.5px / 0.14em / text-3 + 发丝下划线：分组标题退为标签，行标签（13px）成为主体，层级不再扁平。
- 共享 `.tmuxgo-panel-header`（文件 / SSH / 机群三处复用）加顶沿微光 + 实底，标题 12.5px 600、副标题 10.5px。

### 7.4 对比度：7 套主题实测

脚本：`.dbg/ui-audit/contrast.mjs`（TreeWalker 遍历文本节点，向上找第一个不透明背景，按 WCAG 2.1 算比值，排除 xterm 画布）。

| 主题                        | 修复前低对比节点            | 修复                                                               |
| --------------------------- | --------------------------- | ------------------------------------------------------------------ |
| dark                        | 14（`--text-3` 4.14）       | `--text-3` 112 120 134 → 124 133 148（4.95）                       |
| sage                        | 15（3.47，`--danger` 4.49） | `--text-3` → 136 150 140（4.80）、`--danger` → 218 120 120（4.91） |
| nord                        | 5（强调键帽 4.15）          | 新增 `--accent-text: 130 185 255`（4.95）                          |
| dracula / catppuccin / sage | 强调文字沿用根级蓝          | `--accent-text: var(--accent)`，用各自主题色（5.90 / 8.34 / 5.21） |
| light                       | 语义色偏浅                  | 第一轮已改（0 128 72 / 168 96 0 / 200 36 30）                      |
| high-contrast               | —                           | 无需改动                                                           |

复测结果：**7/7 主题 0 个低于 AA 的文本节点**（排除终端画布——xterm 背景由 canvas 自绘，DOM 比对会误判；终端配色在创建时从同一批 token 读取）。

### 7.5 回归与验收数字

- 前端全量单测：160 个文件、1621 passed / 7 failed / 24 skipped；7 个失败全部落在 `SessionPanel.test.tsx`，且 `git show HEAD:...SessionPanel.tsx` 中同样没有测试期望的 `sidebar.sessions` 文案 —— 属测试与实现的既存漂移，非本次改动引入。
- `tsc --noEmit`、`eslint`（12 个改动组件）、`prettier --check` 全部通过。
- 视觉回归：1600×1000 / 1280×800 / 1024×768 / 390×844，dark / light / high-contrast / dracula / nord / catppuccin / sage 逐一过截图。

## 8. 可访问性（axe-core 4.10.2，WCAG 2.1 A/AA）

脚本：`.dbg/ui-audit/axe.mjs`（注入 axe，跑主工作区 / 设置弹窗 / 命令面板三个面）。

| 规则                 | 修前                                                                                           | 处理                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `color-contrast`     | 4（选中行 10.5px 元信息 4.22；状态栏琥珀 chip 标签 4.20；面板底部按键提示）                    | 选中行元信息升 `text-2`；有色 chip 标签改 `text-current/80`；提示行改 `text-2` → 0            |
| `button-name`        | 1（语言下拉 `role="combobox"` 只有内容没有名字）                                               | `Select` 已有 `aria-label` 入口，设置页语言项补上 → 0                                         |
| `label`              | 1（隐藏的 `<input type=file>`）                                                                | 补 `aria-label`（新增 `upload.selectFiles` 双语键） → 0                                       |
| `meta-viewport`      | 1（`user-scalable=no, maximum-scale=1`）                                                       | `index.html` 去掉缩放锁，保留 `viewport-fit=cover` → 0                                        |
| `nested-interactive` | 16（dnd-kit 给拖拽行默认 `role="button"`，行内还有真按钮；窗口标签 `role="tab"` 内含关闭按钮） | 拖拽容器 role 覆盖为 `group`（tabIndex / aria-roledescription 保留，键盘拖拽不变）→ 16 降至 2 |

剩余 2 处为窗口标签 `role="tab"` 内含关闭按钮 —— VS Code / Chrome 同一形态，属 ARIA tabs 的已知折衷；改结构要把关闭按钮移出 tab 并重写相邻选择器，收益不抵风险，记为已知偏差。

## 9. 主题切换实测（不是改属性模拟）

`.dbg/ui-audit/theme-live2.mjs` 走真实路径：rail 齿轮 → 外观 → 点主题按钮。

```
before { theme: dark,  xtermFg: rgb(240,243,248) }
mid    { theme: light, xtermFg: rgb(28,28,30) }     ← 切到浅色，终端前景同步变深
after  { theme: light, xtermFg: rgb(28,28,30) }
reload { themeOnLoad: light, xtermFg: rgb(28,28,30) } ← 偏好已落库，重载后仍是浅色
```

结论：终端配色跟随 token 实时更新、偏好持久化正常。此前「浅色下终端文字看不见」是截图脚本在页面加载后强改 `data-theme` 造成的假象，不是产品缺陷。

## 10. 构建与回归

- `npm run build`（`apps/frontend`）：主包 + novnc 两个产物均成功，`dist/assets/index-*.js` 646.6 kB（gzip 184.1 kB）。
- 前端全量单测：**160/160 文件通过，1628 passed / 0 failed / 24 skipped**。
- `tsc --noEmit`、`eslint`、`prettier --check`：干净。
