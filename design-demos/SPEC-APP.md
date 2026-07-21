# SPEC · TmuxGo App 前端高保真原型 (Phase 2)

## A. 任务

重做 TmuxGo 的 app 前端为**可交互 HTML 原型**：desktop (1440×900) + mobile (375×812) 自适应，能点击切主题、打开 CommandPalette、打开 Settings、展开/收起侧栏面板。每位 subagent 各出一版完整 HTML，HTML 用 inline CSS+少量 JS。

## B. 必须包含的状态 / 屏

每个 subagent 必须交付以下**全部**（在同一个 HTML 里用 JS 切换）：

### 桌面端 (1440×900) 必须覆盖：
1. **主控台态**（默认打开）
   - 左侧 ActivityBar（56px，含 sessions / files / thumbnails / git / search / settings 6 个图标）
   - SessionPanel（带 4-5 个 tmux 会话项）
   - 主区：终端 TerminalPane（xterm 风格占位，绿色字符 + 蓝色 prompt 行 + 几行输出）
   - FilePanel（折叠态，左侧文件树占位）
   - StatusBar（底部 status bar，显示连接/性能/会话信息）
2. **CommandPalette 弹出态**（点击 ActivityBar 上的搜索图标）
   - modal 居中，输入框 + 命令列表（"新建会话" / "切换主题" / "打开设置" 等）
3. **Settings 打开态**（侧边抽屉或 modal）
   - 主题选择（6 个色块圆点，点击立即切换）
   - 其他设置项（占位）
4. **面板打开/收起**：FilePanel / SessionPanel 都能 toggle
5. **主题切换器**：顶栏 6 色块圆点，点击实时切换 6 套主题

### 移动端 (375×812) 自适应
- 通过 media query `@media (max-width: 1023px)` 切换
- 显示 PaneGrid（终端）+ MobileNav 底部 dock
- MobileNav 含 sessions / search / files / git / settings 5 个图标
- FileSheet 可以从底部弹起 75%
- GitSheet 可以从底部弹起 88%

## C. 技术硬约束

1. **单文件 HTML** → `/home/guo/project/other/TmuxGo/design-demos/app/01-<代号>.html` 等
2. **inline CSS**（无 Tailwind CDN、无外部依赖）
3. **inline JS**（主题切换 + 面板 toggle + CommandPalette 弹出 + Settings 抽屉）
4. **6 套主题 token 必须 100% 复用** `apps/frontend/src/app/globals.css` 已定义的 CSS variables：
   - `--bg-0 / -1 / -2`、`--text-1 / -2 / -3`、`--accent / -accent-2 / -warn / -danger`
   - `--line / --glow`、`--glass-blur / -fill / -fill-strong / -rim / -highlight / -shadow`
   - `--font-ui / -font-mono`
5. **必须不写死 hex**。所有颜色都走 `rgb(var(--xxx) / <alpha-value>)`
6. **字体**：只用 `var(--font-ui)` 和 `var(--font-mono)`，display 不引入外部字体
7. **Glass 拟态**：面板用 `.tmuxgo-glass` 或等价方式（`backdrop-filter: blur(var(--glass-blur)) saturate(160%); border: 1px solid var(--glass-rim); background: var(--glass-fill)`）
8. **总行数 ≤ 3500**（app 比路线图复杂，自然允许更多）

## D. 内容 / 数据

### 终端占位内容（主控制台 TerminalPane 内）
显示 3-4 行真实感输出，比如：
- prompt: `hongbin@local:~/projects/tmuxgo $ `
- output: 
  ```
  Last login: Mon Jul 21 09:31:04 on ttys001
  hongbin@local:~/projects/tmuxGo $ ls apps/frontend/src/components | head -5
  ActivityBar.tsx
  AgentStatusBadge.tsx
  ConsoleLayout.tsx
  DesktopWorkbench.tsx
  EditorWorkbench.tsx
  ```

### SessionPanel 占位
5 个会话：
- `★ dev-tools` （置顶，活跃）
- `main-app`
- `experiment-x`
- `prod-debug`
- `adhoc`

### ActivityBar 6 个图标
- Sessions (终端框图标)
- Files (文件夹)
- Thumbnails (网格)
- Git (分支)
- Search (放大镜)
- Settings (齿轮)

使用 inline SVG stroke icon 或 unicode char（不要 emoji！）

### StatusBar
- 左侧: 连接状态 (绿点 + "connected")
- 中部: 会话名/窗口/pane
- 右侧: 主题按钮 / 性能监控文字

## E. 三 subagent 任务表（DNA 分工）

| Slot | 代号 | DNA | 灵感来源 | 必须严格遵守 |
|------|------|-----|---------|----------|
| 1（轮盘） | `01-functional-brutalism` | 功能主义网格 Functional Brutalism | Are.na / Lobsters / Quartz; design-styles.md 网页 #17 | 配色近白/近黑+1px 灰分割线 #E0E0E0+经典链接蓝 #0000EE；系统字栈 `system-ui`；紧凑行距；零圆角（slop 雷区）；用 hairline 边框做容器，不用 box-shadow |
| 2（参照） | `02-linear-glass-bento` | Linear 玻璃便当 Linear/Cursor | Linear、Cursor；design-styles.md PPT #2 Bento Grid + 网页 #13 Glassmorphism Bento | 配色 #08090A 底 + 去饱和蓝紫 #5E6AD2 accent + 微光渐变；字体 Geist (用 var(--font-ui) 替代) + Geist Mono (用 var(--font-mono))；玻璃面板 + bento 网格 |
| 3（顶级定制） | `03-anthropic-editorial` | Anthropic 出版物 / 暖色编辑 | Claude 官网（Anthropic); Penguin 平装书排印； design-styles.md 网页 #12 Warm Editorial | 配色奶油底 `#F5F0E8` + 赤陶橙 `#CC785C` + 近黑 `#191919`（写 CSS var 多套主题 token 时，以默认 dark token 为 fallback，editorial 视觉仅在 dark/high-contrast 主题下生效）；衬线字体用 `var(--font-ui)` fallback + serif 字族选择；max-width 限制阅读宽度 |

**每个 subagent 独立工作**：只看 spec + 自己的 DNA + **不互相参考**。

**禁止**：
- 不允许跨 slot 借元素（DNA-2 不能借 DNA-1 的网格）
- 不允许再次触发"三方向门"自检（只交付你这一份）
- 不允许偷工 — 必须填满 B 段所有状态

## F. 反 AI slop 硬清单

- ❌ emoji 充当图标（用 unicode 字符或 inline SVG stroke icon）
- ❌ 左 border accent + 圆角卡片当主形态
- ❌ 紫色渐变 / 霓虹 glow 滥用
- ❌ 字体塞 Inter/Roboto 兜底
- ❌ 背景全填渐变
- ❌ 假数据装饰（unsplash / stock 图）
- ❌ 占位「Lorem ipsum」

## G. 验收（每个 subagent 自检）

- [ ] HTML 双击 file:// 能开
- [ ] 1440×900 桌面端正常显示主控台
- [ ] 375×812 移动端正常显示 PaneGrid + MobileNav
- [ ] 6 套主题全都能切（点击顶栏圆点切换）
- [ ] CommandPalette 弹出可用（点 ActivityBar 搜索图标）
- [ ] Settings 抽屉可用
- [ ] SessionPanel、FilePanel 折叠 / 展开状态都有
- [ ] 终端占位内容真实可读（看起来是 tmux session，不是 "Hello World"）
- [ ] 不依赖任何外部 CDN
- [ ] 总行数 ≤ 3500

## H. 输出报告

返回 1 段 ≤ 100 字：
- DNA + 这一版的视觉签名（1 句）
- 8 个状态都覆盖了的确认（1 句）
- 1 个最特殊的设计决策（1 句）
- 任何 caveat（1 句）

写完即结束，不要再修改。
