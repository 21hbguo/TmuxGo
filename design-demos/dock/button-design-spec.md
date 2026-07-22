# Button 设计规范（apple-design）

## 设计语言对齐 apple-design skill

| 维度 | apple-design 规则 | 本设计对应 |
|---|---|---|
| §1 Response | pointer-down 立即反馈，scale 0.96-0.98 + 1px translate | 全部按钮 `:active` 用 `scale(0.97) translateY(1px)`，80ms |
| §4 Springs | `cubic-bezier(.2,.8,.2,1)` 模拟 damping=1.0 spring | transition 统一用此曲线 |
| §11 Smoothness | transform-only 动画，compositor-friendly | `transform: translateZ(0); will-change: transform` |
| §12 Material weight | "Lighter materials = interactive" / "Never stack light on light" | chip/button 玻璃深度小于 panel；不要在 glass 背景上放 glass 按钮 |
| §12 Top edge | bright hairline = "light catching the material" | `inset 0 1px 0 var(--glass-highlight)` |
| §12 Bigger → thicker | 更大面积配更强 blur + 更深阴影 | L3 button blur 22px / shadow 8-12px；L2 chip blur 14px / shadow 4px |
| §14 Reduced motion | 用 opacity 替代 transform，drop blur if reduce-transparency | @media 自动降级 |
| §15 Typography | 玻璃上用 higher-contrast + slightly heavier weight | button 用 text-text-1 + font-weight 500+ |

## 三层按钮 + 两变体

| 层级 | class | 尺寸 | 用途 | 玻璃强度 |
|---|---|---|---|---|
| L1 keycap | `.tmuxgo-keycap`（已有） | 11-13px / min 28px | kbd 提示 / 修饰键 / 快捷键标签 | 浅（hairline + 顶部高光，无 blur） |
| L2 chip | `.tmuxgo-chip` | 10-11px / padding 2-6px | 内联动作（stage/unstage/✕） | 浅（同 keycap，无 blur） |
| L3 button | `.tmuxgo-button` | 12-13px / padding 5-14px | 模态确认/取消/恢复/重试/打开 | 中（hairline + 顶部高光 + 4px shadow） |
| L3 primary | `.tmuxgo-button--primary` | 同上 | 主要 CTA（保存/创建/确认） | 实心 accent，文字 white |
| L3 danger | `.tmuxgo-button--danger` | 同上 | 破坏性（删除/中止/退出） | 实心 danger tint |
| L3 ghost | `.tmuxgo-button--ghost` | 同上 | 次要（取消/关闭） | 无 border，hover 才填充 |

## `:active` 与 `:hover` 一致性

所有按钮统一：
- `:hover`：`background` 升至 `--glass-fill-strong`，`box-shadow` 加深，文字 `text-1`
- `:active`：`transform: translateY(1px) scale(0.97)` + 移除阴影（"按下去"）
- 动画：`transition: transform 80ms cubic-bezier(.4,0,.6,1), background-color 160ms cubic-bezier(.2,.8,.2,1), color 160ms ..., box-shadow 180ms ...`
- disabled：`opacity 0.55`，禁止 hover/active 反馈

## 尺寸 token

- sm: padding 3-7px, font 11px, radius 6px
- md (default): padding 5-14px, font 12px, radius 8px
- lg: padding 8-18px, font 13px, radius 9px

## 迁移范围

### 必须迁（L1 keycap 已有，复用即可）
- QuickActions 自定义快捷键 ✓
- AddShortcutModal 修饰键 ✓
- TopBar `<kbd>` 提示
- CommandPalette / CommandSnippets 的快捷键标签（待检视）

### 必须迁（L2 chip，新增 `.tmuxgo-chip`）
- GitPanel: stage/unstage/discard/checkout/merge/✕
- FilePanel: 面包屑 chip
- TerminalPane / EditorWorkbench: 关闭 ✕
- DiffViewer: "staged" 标签（用 span）

### 必须迁（L3 button + 变体，新增类）
- ConfirmDialog / PromptDialog / AddShortcutModal：确认/取消
- QuickActions: attach 按钮、+ 添加按钮
- FilePanel: restore from trash
- GitPanel: retry / continue operation / abort operation / commit
- EditorWorkbench: clear / find / format
- AuditLog: refetch
- Settings: 多个 save/cancel
- PluginSettings: install

### 不迁
- `tmuxgo-icon-button` 已有统一样式
- 切换开关（Settings 等大 toggle）
- 模态 backdrop / dialog container
- 拖拽占位符
