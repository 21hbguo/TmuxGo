# Cell 二进制渲染协议：现状与冻结判定

> 结论（2026-10-24）：`TMUXGO_STREAM_CELL` 保持 `0`。不是「补测试后灰度」——存在确定的带宽反例、模式保真缺口与新旧链路集成阻断。重开需先满足文末清单，重评估前不要灰度。

## 背景

cell 协议 = 服务端 xterm-headless 解析 PTY 输出成 grid，逐帧只发脏 cell 差分（`cell_diff_v2`，每 cell 20B 固定头），前端 apply 直写 xterm buffer。意图：省流 + 省前端解析 CPU。历史踩过四个渲染 bug（Unicode 宽度错配、grapheme 截断、resize reflow 残留、v1 wire 截断），均已修单点但无端到端保真验证。

## 冻结理由（代码级证据，评审计于 HEAD 8ce3ac4）

### 带宽反例（wire 字节，含 compact 外头）

| 场景             | ANSI+gzip 路径 | cell diff              |
| ---------------- | -------------- | ---------------------- |
| 光标回显 1 ASCII | 13–17B         | 53B                    |
| 任意位置改 1 格  | 26–30B         | 53B                    |
| 同色连续 80 格   | ~105B          | ~1712B（续格同计 20B） |

关键不对称：`stream-session.ts` 中 `useGzip` 仅对 `cell_snapshot_v2` 开——**diff 永不压缩**；ANSI ≥256B 即试 gzip。cell 无 scroll op，滚动把移动格逐格记脏。优势场景窄：整屏重绘后仅少数格真变。

### 保真缺口

- DEC 模式位未投影（`grid.ts` flags 恒 0）：应用方向键/小键盘/bracketed paste/鼠标模式丢失
- alt-buffer 身份不传：前端无法按 cell 切 alt
- scrollback=0，无换行/历史/isWrapped 元信息——影响本地回滚/搜索/reflow
- 仅 5 个 style 位：dim/italic/underline/inverse/OSC 链接丢失

### 集成阻断（休眠 bug，CELL=0 时不发作）

1. **直写未接通**：`useWebSocket.ts` 组装 cell 对象后 `handleMessage` 重建消息时丢 `cell` 字段；`useSessionSocket` 同病。当前开 =1 仍走 cell→ANSI→xterm，直写收益为零。
2. **apply-cell.ts 签名错误**：`setCellFromCodepoint` 第 4 参传了字符串（xterm 5.5 要 `IAttributeData`）；`packFg/packBg` palette 常量错（0x1000000/0x2000000）；width0 续格缺失。被上面的丢字段 bug 遮住，接通即爆。
3. **mirror 集成冲突**（T-241 引入）：`tryAttachFromMirror` 发 ANSI 快照但不 feed cell parser；warm hub 二次 attach 后下一次局部输出会从空白 cell 基线生成全屏 snapshot 覆盖已恢复画面。
4. `useSessionSocket` 的 `cellLastSeq` 跨连接共享，多 session 交错输出会互相误判。

## 重开前置清单（全部满足才谈灰度）

- [ ] 协议补：scroll op、DEC 模式位、alt-buffer 身份、样式位扩展
- [ ] 修 apply-cell 真实 xterm 签名 + palette；接通 hook 丢字段；cellLastSeq per-connection 隔离
- [ ] mirror↔cell 基线同步（attach 快照同时 feed cell parser）或门控互斥
- [ ] diff 帧压缩策略对齐 ANSI（按大小选编码，不是协议强制）
- [ ] 端到端对照测试：真实 ANSI 分块 → 服务端 → 真实 socket hook → 真实 xterm，逐 cell/属性/模式比对（覆盖 warm-mirror 局部增量、多连接、resize、CJK/组合符/ZWJ、粘贴/方向键/鼠标模式）
- [ ] 真实分帧策略下的 wire 字节 + CPU A/B（ANSI+gzip vs cell+gzip vs 按大小选）
- [ ] 成本账：per-connection grid clone + 整屏抽取 + diff 扫描 + 第二份 headless 解析器（mirror 已有一份）的 CPU/内存实测

## 相关

- mirror attach（快照/增量）走 ANSI 路径已落地（`stream/pane-mirror.ts`），与 cell 无关、不受影响。
- 历史 bug 修复 commit：1b48881 / 79fc58f / 4e526d8 / 0ccb2d2 / 7c80c7d。
