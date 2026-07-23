# TmuxGo 流式传输优化计划：压缩 + Cell 差分

> 状态：计划待评审（**尚未开工写代码**）  
> 创建：2026-07-24  
> 范围：`apps/gateway` 流式出口 + `apps/frontend` 接收/渲染路径  
> 相关现状：binary 帧已存在（`stream-binary`）、`stream_caps`、profile/backpressure、整窗 `tmux attach` → ANSI → xterm

---

## 1. 目标

在**不限制多开 web**、**不故意增加常态延迟**、**不降低流畅体感**的前提下，同时落地：

1. **压缩（Compression）**：降低链路上的字节体积（重点大帧/可开关路径）。
2. **Cell 差分（Cell Diff）**：在合适场景用「屏幕状态补丁」替代「全量 ANSI 指令流」，降低稳态信息量，并为后续共享状态/fan-out 打基础。

### 1.1 成功长什么样

| 维度 | 成功标准（做好后） |
|---|---|
| 功能正确 | 终端显示与现网路径一致：中文、颜色、alt-screen、清屏、滚动、resize、resync 无回归 |
| 多开 web | 仍可多标签/多客户端同时看同一会话，不踢人、不强制单连接 |
| 延迟/流畅 | 默认路径 p99 组帧+发送开销不劣化；无「攒包变钝」；Agent spinner 不比现在糊 |
| 带宽 | 压缩：大帧/弱网有稳定体积下降；差分：TUI/spinner 稳态相对 ANSI 基线有显著下降（见 §6 指标） |
| 可回滚 | 能力协商 + 服务端/客户端 feature flag；任一侧不支持即自动回退 ANSI/binary 明文 |
| 可观测 | 性能看板可区分 ansi / compressed / cell 路径的字节与帧类型 |

### 1.2 非目标（本计划明确不做）

- 限制多开 web / 踢旧连接 / 强制单客户端  
- 全局加大 flushInterval（4ms→32ms 常态）换带宽  
- 只推 active pane、砍整窗多 pane 体验  
- 截图/视频流替代终端  
- 本阶段不强制上「单 attach fan-out」（可作为后续独立项；Cell 差分设计预留接口）  
- 不追求替换 xterm 为自研渲染器（差分 MVP 仍落到 xterm 可接受的 apply 路径）

---

## 2. 硬约束（验收一票否决）

来自产品讨论，写入验收：

1. **多开保留**：N 个 web 同时 attach 同一 session 必须可用。  
2. **常态零变钝**：默认 foreground 路径不得为省流量而合并帧或提高发送周期。  
3. **流畅不回退**：同场景下掉帧、输入延迟、resync 风暴不得比基线更差。  
4. **兼容优先**：能力协商失败或解码失败 → 静默回退现有 binary/JSON ANSI 路径，不白屏。  
5. **最小惊讶**：默认对旧客户端完全透明。

---

## 3. 现状与问题结构

```
tmux attach (整窗 PTY)
  → gateway sanitize / buffer / flush (4ms foreground)
  → binary 或 JSON {type:output|output_resync, data: ansi}
  → 每个 WebSocket 客户端各收一份
  → 前端 xterm.write
```

高 `outputBytes` 的主因（实测）：

- 多 web → 总出口 ≈ 单路 × N  
- 多 pane Codex/TUI 局部重绘进整窗流  
- resync/snapshot 大帧  
- 已有 binary，但**未压缩**；**无屏幕状态层**

压缩与差分解决的是不同层：

| 层 | 压缩 | Cell 差分 |
|---|---|---|
| 编码体积 | ✅ | ✅（间接） |
| 逻辑信息量 | ❌ | ✅ |
| 本机 xterm 解析量 | ❌（解压后同量） | ✅（若 patch 廉价） |
| 多开总份数 | 仍 ×N | 仍 ×N（底数可变小） |

---

## 4. 总体架构原则

1. **双轨并存，默认兼容**  
   - Track A：ANSI 字节流（现有）± 压缩  
   - Track B：Cell snapshot/diff 帧  
   - 由 `stream_caps` 协商启用，可运行时降级  

2. **压缩策略：偏置安全**  
   - 默认：**大帧才压**（resync / 超过阈值的 payload）  
   - 小帧高频路径：默认不压，避免 CPU 排队伤延迟  
   - 可选实验开关：`compressAll`（仅 dev/flag，不进默认）  

3. **差分策略：正确性 > 极限压缩比**  
   - MVP 覆盖常见 TUI + 中文 + 基本 SGR + 清屏/光标  
   - 遇到状态机不确定或未支持序列 → **回退 ANSI 帧**（同连接允许混用或整段 fallback）  
   - 不做「为了差分而丢字符」  

4. **延迟预算（写死）**  
   - 压缩：仅当 `payloadBytes >= COMPRESS_THRESHOLD`（建议 4KiB）才进入压缩路径  
   - 差分：按「有脏就发」，**不**为凑帧率故意 delay；可与现有 flush 节奏对齐，但不额外 `setTimeout` 攒差分  
   - 单帧处理 p99 目标：压缩或 diff 组帧 **< 2ms**（本机 dev 测量；超标则缩小范围或回退）  

5. **协议演进**  
   - 扩展现有 `TG` binary，而不是平行搞第三套完全不同的 WS  
   - `STREAM_BINARY_VERSION`  bump 或 type 枚举扩展；旧客户端忽略未知 type  

---

## 5. Workstream A：压缩

### 5.1 方案选型（计划内定）

| 项 | 选择 | 理由 |
|---|---|---|
| 算法 MVP | **gzip**（Node zlib + 浏览器 DecompressionStream 或 pako 等价） | 普及、可流式、无新原生依赖争议；后续可换 zstd |
| 挂载点 | **应用层 binary payload 压缩**，不是先上 permessage-deflate | 与现有 binary 一体、可按帧策略、易测、易协商 |
| 触发 | `output_resync` 默认压；`output` 仅 `data.length >= threshold` | 保小包延迟 |
| 协商 | `stream_caps: { binaryOutput, compressOutput?: 'gzip'\|false }` | 双向确认后才压 |
| 帧标识 | header flags 或 type 变体：`OUTPUT_COMPRESSED` / `RESYNC_COMPRESSED`，或 flags 位 | 解码端明确 |

### 5.2 协议草案（压缩）

现有 header（12B）：

```
0-1: magic 'T''G'
2:   version
3:   type  (1=output, 2=resync)
4-5: hostLen
6-7: sessionLen
8-11: dataLen
+ host + session + payload
```

扩展建议（二选一，实现前定稿）：

**推荐：type 扩展**

- `3 = output_gzip`  
- `4 = resync_gzip`  
- payload = gzip(utf8_ansi_bytes)  
- `dataLen` = 压缩后长度  

**备选：flags 字节**（version bump 到 2，type 后增 flags）— 更灵活但破旧解码，需 version 门闩。

MVP 倾向 **type 扩展 + version 仍为 1**（旧前端忽略 3/4 则需服务端发现 caps 后才发；未协商绝不发 3/4）。

### 5.3 代码落点

| 位置 | 改动 |
|---|---|
| `apps/gateway/src/lib/stream-binary.ts` | encode 支持 compressed types；gzip helper |
| `apps/gateway/src/routes/stream.ts` | caps 协商；`sendTerminalOutput` 按策略压 |
| `apps/frontend/src/lib/stream-binary.ts` | decode 3/4；解压 |
| `apps/frontend/src/hooks/useWebSocket.ts` | caps 声明 `compressOutput:'gzip'` |
| `apps/gateway/src/lib/perf-metrics.ts` | `compressedFrames`, `compressedBytesSaved` 等 |
| 性能看板 | 展示压缩帧数/节省字节（可选同一 PR 或紧随） |
| 测试 | `tests/stream-binary.test.ts` + 前端 decode 单测 |

### 5.4 压缩验收

- 未协商客户端：行为与现网 bit 级兼容  
- 协商后：resync 体积相对明文下降（构造重复 ANSI 夹具，目标 ≥ 40% 体积下降）  
- 小包（< threshold）：不走压缩，耗时不劣于基线  
- 解压失败：记 metric + 请求 resync 或降级，不崩溃  
- 多客户端：有/无 compress caps 可混连同一 gateway  

---

## 6. Workstream B：Cell 差分

### 6.1 方案选型（计划内定）

| 项 | 选择 | 理由 |
|---|---|---|
| 状态机位置 | **gateway 侧**维护 grid（ANSI → cells） | 多客户端可共享计算（即使本阶段仍每连接一 PTY，模块按「可共享」设计） |
| 前端 apply | MVP：**将 diff 转为最小化 ANSI 或 xterm 内部可写路径**；优先正确。阶段 B2 再评估直接 buffer API | 降低首版渲染分叉风险 |
| 帧类型 | `snapshot`（全量）+ `diff`（脏 cell 列表/RLE）+ 必要 meta（cursor, modes） | 标准两段式 |
| 失败策略 | 解析不确定 → 发 ANSI fallback 帧；连续失败 → 关 cell 模式本连接 | 保体验 |
| 范围 MVP | BMP/常用 Unicode、16/256/truecolor 基础、bold/dim/italic/underline/inverse、清屏、cursor、scroll region **尽力**；六边形图/图片协议等 → fallback ANSI | 先覆盖 Codex/TUI |

### 6.2 协议草案（Cell）

在 binary 上新增 type（示例编号，实现前冻结）：

| type | 名 | payload |
|---|---|---|
| 5 | `cell_snapshot` | 见下（可再 gzip：type 6） |
| 6 | `cell_snapshot_gzip` | gzip(snapshot) |
| 7 | `cell_diff` | 见下（可再 gzip：type 8） |
| 8 | `cell_diff_gzip` | gzip(diff) |

**snapshot payload（逻辑结构，编码可用 msgpack/自定义紧凑二进制）MVP 建议自定义紧凑二进制避免新依赖：**

```
cols:u16 rows:u16
cursorX:u16 cursorY:u16
flags:u16   // origin mode, reverse, etc. 必要子集
cellCount:u32  // = cols*rows 或 run-length 条数
// 行优先 cells：RLE 推荐
// 每段: runLen:u16, cp:u32, attr:u32, fg:u32, bg:u32
```

**diff payload：**

```
seq:u32          // 单调，用于丢帧检测
baseSeq:u32      // 基于哪次 snapshot/diff
cursorX/Y, flags
changeCount:u32
// 每项: x:u16 y:u16 cp:u32 attr:u32 fg:u32 bg:u32
// 或矩形 RLE  pen 模式（B2 优化）
```

**丢帧恢复**：客户端发现 `baseSeq` 对不上 → 发 `request_cell_snapshot` 或复用现有 resync 路径。

### 6.3 模块划分

```
apps/gateway/src/lib/terminal-grid/
  ansi-parser.ts      # 字节 → 对 grid 的 mutation
  grid.ts             # cell 存储、resize、snapshot
  diff.ts             # 上一帧 vs 当前 → changes
  encode-cell.ts      # snapshot/diff → Buffer

apps/frontend/src/lib/terminal-grid/
  decode-cell.ts
  apply-cell.ts       # → xterm（MVP ANSI 合成或 buffer）

stream.ts             # 在 queueOutput/flush 旁路：喂 parser；flush 时选 ansi vs cell
useWebSocket.ts       # 分发 cell 帧
TerminalPane.tsx      # apply；resize 同步
```

### 6.4 生命周期

```
attach / resize / resync 触发
  → snapshot（可压缩）
  → 之后 output：parser 更新 grid
  → flush 边界：若 cell 模式开且 diff 更优（或总是 diff）则发 diff
  → 若 diff 变更比例 > 阈值（如 40% cells）改发 snapshot
  → 若 parser 错误：发原始 ANSI，重置「可靠 seq」
```

### 6.5 Cell 验收

- 夹具：纯文本、颜色、清屏、光标移动、中文宽字符、快速 spinner 模拟  
- 像素/文本级：与 ANSI 路径 golden 对比（capture 或 xterm buffer 序列化）  
- 性能：spinner 场景 wire 体积相对 ANSI 基线下降（目标 **≥ 50%** 稳态）；满屏日志允许收益有限  
- 延迟：默认路径无额外定时攒帧  
- 降级：关闭 caps / 注入坏帧不崩溃，可恢复  

---

## 7. 共享基础（两 workstream 共用）

### 7.1 能力协商 `stream_caps`

前端 → 服务端：

```json
{
  "type": "stream_caps",
  "binaryOutput": true,
  "compressOutput": "gzip",
  "cellOutput": true
}
```

服务端 → 前端确认实际启用：

```json
{
  "type": "stream_caps",
  "binaryOutput": true,
  "compressOutput": "gzip",
  "cellOutput": true
}
```

规则：只启用**双方都支持**的子集。

### 7.2 Feature flags（环境/配置）

建议（名称可调）：

- `TMUXGO_STREAM_COMPRESS=0|1`（默认 1）  
- `TMUXGO_STREAM_COMPRESS_THRESHOLD=4096`  
- `TMUXGO_STREAM_CELL=0|1`（默认 0 直到验收通过再默认 1，或默认 1 但 caps 决定）  

计划：**压缩可较早默认开；Cell 先 flag 默认关，e2e 通过后再默认开。**

### 7.3 指标（perf-metrics + 性能看板）

新增建议：

- `compressFrames`, `compressBytesIn`, `compressBytesOut`  
- `cellSnapshots`, `cellDiffs`, `cellFallbackAnsi`, `cellDirtyCells`  
- 速率展示：可增加「有效路径」标签（ansi/compress/cell）  

### 7.4 测试金字塔

1. **单测**：编解码 roundtrip、gzip、grid mutation、diff 正确性、宽字符  
2. **组件/集成**：useWebSocket 分发、TerminalPane 不崩  
3. **e2e（可选但推荐）**：attach 会话 echo/颜色；开 caps 前后一致  
4. **基准脚本**：固定 ANSI fixture 比体积与耗时（`scripts/bench-stream-transport.ts`）  

---

## 8. 分阶段交付（推荐顺序）

> 原则：先可回滚的链路增强，再上状态层；每阶段可单独合并、单独关停。

### Phase 0：基线与契约（计划期收尾 / 开工第一刀）

- 冻结协议编号与 caps 字段  
- 记录本机多 Codex 场景基线：KB/s、resync、flush、主观流畅  
- 建立 bench 夹具目录 `tests/fixtures/terminal-streams/`  

### Phase 1：压缩 MVP

1. gzip encode/decode + type 3/4  
2. caps 协商  
3. 仅 resync + 大包  
4. metrics + 单测  
5. 手动/脚本验证多客户端混连  

**出口标准**：默认开启压缩策略后，正确性 100% 回退兼容；resync 夹具体积下降达标；无明显延迟回归。

### Phase 2：压缩加固

- 失败降级、metric 告警字段  
- 性能看板展示节省量  
- threshold 可配置  
- （可选）评估 zstd 为后续，不进本阶段必做  

### Phase 3：Cell 差分 MVP（正确性优先）

1. grid + 最小 ANSI parser（足够 echo/SGR/ED/CUP）  
2. snapshot/diff 编码  
3. 前端 decode + apply（安全路径）  
4. caps `cellOutput`；flag 默认关  
5. golden 测试  

**出口标准**：flag 打开时，夹具与 ANSI 路径显示一致；spinner 夹具带宽下降达标；可一键关回 ANSI。

### Phase 4：Cell 加固与默认策略

- 扩展序列覆盖（scroll、EL、ICH 等按需）  
- 高脏比改 snapshot、seq 丢帧恢复  
- parser 失败 fallback  
- 与压缩叠加（cell_*_gzip）  
- 考虑默认开（需完整回归）  

### Phase 5：体验与结构预留（非必须同迭代）

- 文档更新 README/性能说明  
- 预留「session 级 shared grid」接口注释/模块边界（为 fan-out 铺路，本计划可不实现 fan-out）  
- 性能看板路径分解  

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 压缩小包伤延迟 | 流畅下降 | 阈值；默认不压小包；可关 |
| gzip 在弱 CPU 移动端解压卡 | 掉帧 | caps 可关 compress；测中端 Android |
| Cell parser 不完整 | 错画 | 不确定即 ANSI fallback；flag 默认关 |
| 宽字符/中文列宽错误 | 错位 | 单测 + 中文夹具；wcwidth 一致实现 |
| 双路径维护成本 | 回归 | 统一入口 send；强制 caps 矩阵测试 |
| 指标误导 | 优化错对象 | 看板分路径；文档写清 ×N 客户端 |

---

## 10. 回滚策略

1. 环境变量关 compress/cell  
2. 前端停发对应 caps  
3. 服务端发现旧 type 不识别的客户端永不发送  
4. 紧急：revert 相关 PR，binary v1 type1/2 路径保持不动  

---

## 11. 决策记录（计划阶段已定）

| ID | 决策 | 选择 |
|---|---|---|
| D1 | 两 workstream 都做 | 是，分阶段 |
| D2 | 不限多开 | 是 |
| D3 | 不增常态 flush 周期 | 是 |
| D4 | 压缩默认策略 | 大帧/阈值，非全量小包 |
| D5 | 压缩算法 MVP | gzip |
| D6 | Cell 状态机位置 | gateway |
| D7 | Cell 默认 | 验收前 flag 关 |
| D8 | fan-out | 本计划不做实现，模块预留 |
| D9 | 协议载体 | 扩展 TG binary types |

---

## 12. 开工门禁

在写业务代码前，确认：

- [ ] 本 `PLAN.md` 与 `TODOLIST.md` 已评审（你点头或修订）  
- [ ] 协议 type 号与 caps 字段无异议  
- [ ] Phase 1 验收数字可接受  
- [ ] Cell MVP 序列范围可接受  

**当前状态：计划已写好，等待你确认后再按 TODOLIST 从 Phase 0/1 开工。**

---

## 13. 文档索引

| 文件 | 作用 |
|---|---|
| `docs/stream-transport-opt/PLAN.md` | 本方案（目标/架构/阶段/风险） |
| `docs/stream-transport-opt/TODOLIST.md` | 可执行任务清单与验收 |
| `docs/stream-transport-opt/PROTOCOL.md` | （开工 Phase 0 产出）冻结的二进制协议细节 |
| `docs/stream-transport-opt/WORKLOG.md` | （开工后）执行日志 |
