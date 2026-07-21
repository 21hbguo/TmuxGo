# SPEC · 三方向 subagent 共同输入

## A. 项目 / 任务

把 `/home/guo/project/other/TmuxGo/docs/ui-beautify-pr-list.md`（一份含 8 个 PR 的 TmuxGo UI 美化路线图）转化为单文件 HTML 长滚动可视化文档。

**所有数据 1:1 反映**（不允许改写）：
- 总分进度：**7.0 → 9.0**
- 8 个 PR 各自提升分、工时、类型、风险、验收项必须与原文一致
- 不在本次范围段落（4 项）也要保留
- 时间线（W1/W2）必须保留
- 分支策略（git worktree 命令）可以略写为说明，不必逐行

## B. 受众与场景

- **主受众**：TmuxGo 研发团队（内部评审 + 自己回看）
- **次受众**：公开分享场景（同事围观 / roadmap showpiece）
- **消费路径**：桌面 1440 宽度滚动阅读
- **情感基调**：专业克制 + 克制中的兴奋 + 可信承诺（数据精确）

## C. 输出规格（硬约束）

1. **单文件 HTML**：写一份 `<代号>.html`，CSS inline，可双击 `file://` 打开
2. **路径**：写到 `/home/guo/project/other/TmuxGo/design-demos/<代号>.html`
3. **viewport**：1440 推荐宽度，自适应 1280–1920，长滚动（不少于 3 屏）
4. **总高度**：不超过 9000px
5. **6 套主题 token 自适应**：dark（默认）/ light / high-contrast / dracula / nord / catppuccin，**必须** 6 套全支持，通过顶栏切换器触发 `document.documentElement.dataset.theme = 'xxx'`。所有颜色 **100% 走 CSS variable**，不写死 hex
6. **token 来源**：复用 `apps/frontend/src/app/globals.css` 已定义的变量，不要重新定义。需要的变量：
   - `--bg-0` / `--bg-1` / `--bg-2`
   - `--text-1` / `--text-2` / `--text-3`
   - `--accent` / `--accent-2` / `--warn` / `--danger`
   - `--line` / `--glow`
   - `--glass-blur` / `--glass-fill` / `--glass-fill-strong` / `--glass-rim` / `--glass-highlight` / `--glass-shadow`
   - `--font-ui` / `--font-mono`
7. **字体**：必须使用 `var(--font-ui)` / `var(--font-mono)`；display 不滥用异型字体
8. **顶部主题切换器**：6 个色块圆点，点击即时切换（不要 modal）
9. **自检**：交付前打开 HTML，浏览器 DevTools 看 6 套主题全部能切

## D. 内容板块（必含，按从上到下顺序）

### D1 · Hero / 进度仪式区（≈1.5 屏）
- 主标题：「TmuxGo UI 美化 · 7.0 → 9.0」
- 副标题：「8 PR · 累计 +3.2 分 · 2 周落地」
- 巨型进度条（横向 100% 宽，左端标 `7.0`，右端标 `9.0`，中间填充体现「已规划进度」）
- 进度条上方加里程碑刻度（每个 PR = 一个节点，可点击跳到对应卡片 anchor）
- 进度条用主题 accent 渐变

### D2 · 总览统计区
4 张并排小卡：总 PR 数 / 累计分提升（+3.2）/ 总工时 / 平均每 PR 工时

### D3 · 8 个 PR 卡片区（核心）
**严格按 ROI 排序**（PR-1 在最前），每张卡片必须包含：

| 字段 | 必含 | 备注 |
|------|------|------|
| 编号 | PR-1 至 PR-8 | |
| 标题 | 与原文一致 | |
| 提升分 | 巨号 + 颜色（accent / accent-2 / warn） | 来源 +0.4 / +0.6 / +0.3 等 |
| 工时 | 徽章样式 | 0.5h / 2h / 3h / 4h |
| 类型 | 工程 / 设计 | label |
| 风险 | 无 / 低 / 中 | label |
| 描述 | 1–2 行 | 来源原文 |
| 实现要点 | ≤4 条 bullet | 来源原文 |
| 验收清单 | ≤4 条 checkbox | 来源原文（如果有） |
| 风险说明 | 1 行 | 来源原文 |
| 回滚方式 | 1 行（如果有） | 来源原文 |

8 张卡片排版：你可以选 **2 列 × 4 行** 或 **1 列 × 8 行**，由风格决定，但要保证扫一眼能拿全关键数据。

### D4 · 不在本次范围
列举原文 4 项（字体/spacing/welcome 引导等）

### D5 · 验收总览
5 项硬性接受标准（视觉/回归/Lighthouse/reduced-motion/主题）

### D6 · 分支策略 / 时间线
W1/W2 表格

### D7 · 页脚
- TmuxGo brand 标识
- 主题切换器提醒
- 路线图日期

## E. 必须规避（反 AI slop 硬清单）

- ❌ emoji 充当图标（PR 卡片里的 ✓ ✗ 这种字符除外）
- ❌ 左 border accent + 圆角卡片当主形态（slop 雷区）
- ❌ 紫色渐变 / 霓虹 glow 滥用
- ❌ 字体塞 Inter/Roboto/system-ui 兜底（必须走 `--font-ui`）
- ❌ 背景全填渐变
- ❌ 放 stock 图、unsplash 图、假数据
- ❌ 占位文字如「Lorem ipsum」、「待补充」
- ❌ 编造 stats / quotes 装饰
- ❌ 圆角卡片 + 阴影 + 1px border 当默认容器（要靠 glass token 或风格 DNA 提供形式感）

## F. 图片素材（Phase 3.5 结论）

**装饰图不需要**。所有视觉装饰用 inline SVG（几何形 + token 颜色）。原因：路线图类信息文档「无信息密度」。

节点装饰（PR 卡片边角 / 进度条刻度）可以用 inline SVG 几何形。

## G. 设计 DNA（视觉母题共享 — 由 subagent 各自诠释）

母题概念：**「连续推进的节拍」**

- 8 个 PR = 8 个推进节拍
- 进度感 = 每个 PR 是一节「脉动 / 章节」
- 节奏感 = 由每个 subagent 自己的设计风格决定

三 subagent 各自诠释：
- **DNA-1（轮盘）**：用波形/频谱节奏呈现节点
- **DNA-2（参照）**：用 changelog 时间序列表述
- **DNA-3（顶级）**：用印刷出版物的章节篇章感

## H. 三 subagent 任务表

| Slot | 代号 | DNA | 灵感来源 | 必须严格遵守 |
|------|------|-----|---------|----------|
| 1 | `01-cinematic-soundviz` | 电影感声波可视化 | ElevenLabs + Saul Bass；design-styles.md 网页 #8 | 配色纯黑#000+纯白+#5E6AD2 紫蓝波形 accent；不偏离纯暗电影感 |
| 2 | `02-vercel-changelog` | Developer-first 路线图 | Vercel/Linear changelog；Swiss 简洁派 | 极简 hairline + Geist 字 + 单一 accent；极克制 |
| 3 | `03-dieter-rams` | 「少即是多」功能主义 | Dieter Rams / Vignelli / Swiss | 单色 + 字体对比 + 大量负空间；不堆元素 |

**每个 subagent 独立工作**：只看 spec + 自己那套 DNA + 不互相参考其他两套。

**禁止**：
- 不允许跨 slot 借元素（DNA-2 不能借 DNA-1 的波形）
- 不允许再次触发「三方向门」自检（你只负责交付你这一份）
- 不允许偷工输出单页 HTML placeholder（必须填满内容）

**输出产物**：1 个 `<代号>.html` 文件，写完即可。注意：不要复制 spec 内容到文件注释里凑字数。

## I. 验收（每个 subagent 自检）

- [ ] HTML 文件能双击 file:// 打开
- [ ] 6 套主题 token 都生效（手动切一次看是否变色）
- [ ] 8 个 PR 全在，按 ROI 排序
- [ ] 关键数据（提升分、工时、风险）齐全正确
- [ ] 不在本次范围 / 时间线 / 验收总览也都在
- [ ] 没有 E 段里的 slop
- [ ] HTML 总行数 ≤ 2000（含 inline CSS/SVG）
