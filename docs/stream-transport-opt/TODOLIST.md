# 流式传输优化 TODOLIST

> 对应计划：`docs/stream-transport-opt/PLAN.md`  
> 状态约定：`TODO` | `DOING` | `DONE` | `BLOCKED` | `SKIPPED`  
> 执行规则：严格按 ID 顺序；未完成依赖不可开工；每完成一项更新状态与日期  
> **当前：全部 TODO，未开工写代码**

---

## 总览

| Phase | 主题 | 项数 | 出口 |
|---|---|---|---|
| P0 | 基线、协议冻结、夹具 | 6 | 协议文档 + 基线数据 |
| P1 | 压缩 MVP | 8 | 可合并、默认可开压缩策略 |
| P2 | 压缩加固与可观测 | 5 | 看板/配置/降级完备 |
| P3 | Cell 差分 MVP | 12 | flag 可开、正确性达标 |
| P4 | Cell 加固 + 与压缩叠加 | 7 | 可考虑默认策略 |
| P5 | 收尾文档与预留 | 4 | 文档与边界清晰 |
| **合计** | | **42** | |

**推荐合并节奏**：P0+P1 → P2 → P3 → P4 → P5（每阶段可独立 review）。

---

## P0 — 基线与契约

### T-P0-01 冻结协议与 caps 字段
- 状态：`TODO`
- 依赖：无
- 产出：`docs/stream-transport-opt/PROTOCOL.md`
- 内容：
  - binary type 编号表（1–8 或最终表）
  - `stream_caps` 请求/响应 JSON schema
  - 压缩阈值默认值、gzip 原始编码（utf8 后再压）
  - cell snapshot/diff 字段布局（字节级）
- 验收：前后端实现可只对照该文档；无歧义 type 冲突

### T-P0-02 建立终端流夹具
- 状态：`TODO`
- 依赖：无
- 产出：`tests/fixtures/terminal-streams/`（至少 5 个）
- 建议夹具：
  - `plain_ascii.txt`
  - `color_sgr.txt`
  - `chinese_wide.txt`
  - `clear_and_cup.txt`
  - `spinner_sim.txt`（重复局部更新）
  - `resync_full_screen.txt`（偏大、重复）
- 验收：夹具可被 bench/单测复用

### T-P0-03 记录现状基线（本机）
- 状态：`TODO`
- 依赖：无
- 做法：对 `/api/system` 采 30s；记录 activeClients、outputBytes 速率、resync、drop、profile
- 产出：写入 `WORKLOG.md` 基线表（开工后建）或本文件附录
- 验收：有可对比数字（客户端数、KB/s 区间）

### T-P0-04 延迟/体积 bench 脚本骨架
- 状态：`TODO`
- 依赖：T-P0-02
- 产出：`scripts/bench-stream-transport.ts`（或 .mjs）
- 能力：对夹具跑「明文 binary 体积」；预留 compress/cell 钩子
- 验收：本地一条命令输出各夹具字节数

### T-P0-05 回归范围清单
- 状态：`TODO`
- 依赖：无
- 产出：本目录 `REGRESSION.md` 简表
- 必测：attach、resize、多 web、断线重连、resync、中文输入回显、Agent 会话打开
- 验收：P1/P3 出口可按表勾选

### T-P0-06 开工确认门禁
- 状态：`TODO`
- 依赖：T-P0-01（及计划评审）
- 验收：用户确认 PLAN/PROTOCOL 后，本项标 DONE，才允许 P1 写代码

---

## P1 — 压缩 MVP

### T-P1-01 gateway：gzip 工具与 encode API
- 状态：`TODO`
- 依赖：T-P0-01, T-P0-06
- 改动：`apps/gateway/src/lib/stream-binary.ts`（或旁路 `stream-compress.ts`）
- 验收：单测 roundtrip；type 3/4 与 1/2 并存

### T-P1-02 gateway：`sendTerminalOutput` 策略接入
- 状态：`TODO`
- 依赖：T-P1-01
- 规则：已协商 compress 时，resync 必压；output 仅 `len >= threshold`
- 验收：threshold 以下仍发 type 1；以上发 type 3/4

### T-P1-03 gateway：`stream_caps` 协商 compress
- 状态：`TODO`
- 依赖：T-P1-02
- 验收：未声明 compress 的客户端永不收到 3/4；声明后响应 echo 实际启用值

### T-P1-04 frontend：decode 压缩帧
- 状态：`TODO`
- 依赖：T-P0-01
- 改动：`apps/frontend/src/lib/stream-binary.ts`
- 验收：单测解压后与明文一致；坏数据返回 null

### T-P1-05 frontend：caps 声明 + 解压失败处理
- 状态：`TODO`
- 依赖：T-P1-04
- 改动：`useWebSocket.ts`
- 验收：连接后发送 compress 能力；解压失败不抛到顶层

### T-P1-06 压缩 metrics
- 状态：`TODO`
- 依赖：T-P1-02
- 改动：`perf-metrics.ts` + `system` 暴露字段
- 验收：压过帧后 `/api/system` 可见计数增加

### T-P1-07 单测与 bench 更新
- 状态：`TODO`
- 依赖：T-P1-01..06, T-P0-04
- 验收：`tests/stream-binary.test.ts` 覆盖 3/4；bench 打印压缩比

### T-P1-08 P1 手工/脚本验收
- 状态：`TODO`
- 依赖：T-P1-07
- 验收勾选：
  - [ ] 旧 caps 仅 binary 行为不变
  - [ ] 新 caps resync 体积下降（夹具 ≥40%）
  - [ ] 双客户端一开一关 compress 混连正常
  - [ ] 主观：echo 与滚动无变钝

---

## P2 — 压缩加固

### T-P2-01 环境变量/配置
- 状态：`TODO`
- 依赖：T-P1-08
- 项：`TMUXGO_STREAM_COMPRESS`, `TMUXGO_STREAM_COMPRESS_THRESHOLD`
- 验收：0 时永不发压缩帧

### T-P2-02 解压/压缩失败降级路径
- 状态：`TODO`
- 依赖：T-P1-08
- 行为：失败 metric + 对该连接禁用 compress 或触发 resync
- 验收：注入失败不导致 WS 断开死循环

### T-P2-03 性能看板展示压缩收益
- 状态：`TODO`
- 依赖：T-P1-06
- 改动：`SystemHealthPanel` 或 stream 卡片副指标
- 验收：可见 compressed 帧或 saved bytes

### T-P2-04 前端 decode 与 gateway 对称测试
- 状态：`TODO`
- 依赖：T-P1-04
- 验收：同一 payload 两端 roundtrip 夹具全绿

### T-P2-05 P2 出口 Review
- 状态：`TODO`
- 依赖：T-P2-01..04
- 验收：压缩 workstream 可宣布「可默认开」；文档短述用法

---

## P3 — Cell 差分 MVP

### T-P3-01 `terminal-grid` 数据结构
- 状态：`TODO`
- 依赖：T-P0-01, T-P0-06, 建议 P1 已合（可并行但协议勿冲突）
- 产出：`grid.ts`（cols/rows/cells/cursor/resize）
- 验收：单测 resize、写 cell、snapshot 序列化稳定

### T-P3-02 最小 ANSI parser
- 状态：`TODO`
- 依赖：T-P3-01
- 支持 MVP 列表（写进 PROTOCOL）：
  - 可打印字符、换行/回车/退格
  - SGR 颜色（基础 + 256/truecolor 尽力）
  - CUP/CUU/CUD/CUF/CUB、ED、EL
  - 宽字符列宽
- 不支持：明确 fallback
- 验收：夹具 `plain/color/chinese/clear` 与期望 grid golden

### T-P3-03 diff 算法
- 状态：`TODO`
- 依赖：T-P3-01
- 验收：两帧 diff 变更集合正确；全同则空 diff

### T-P3-04 cell 二进制 encode/decode
- 状态：`TODO`
- 依赖：T-P0-01, T-P3-01
- 验收：snapshot/diff roundtrip；与 PROTOCOL 一致

### T-P3-05 gateway 接入：喂 parser + 发送策略
- 状态：`TODO`
- 依赖：T-P3-02, T-P3-03, T-P3-04
- 策略：
  - attach/resize/resync → snapshot
  - 常规 flush → diff；脏比 > 阈值 → snapshot
  - parser 失败 → ANSI type1/2
- 验收：flag+caps 开启时有 cell 帧；关闭时与现网一致

### T-P3-06 `stream_caps.cellOutput` 协商
- 状态：`TODO`
- 依赖：T-P3-05
- 验收：单侧 true 不启用；双 true 才发 cell

### T-P3-07 feature flag 默认关
- 状态：`TODO`
- 依赖：T-P3-05
- 项：`TMUXGO_STREAM_CELL` 默认 0
- 验收：默认部署零行为变化

### T-P3-08 frontend decode cell 帧
- 状态：`TODO`
- 依赖：T-P3-04
- 验收：单测；未知 type 安全忽略

### T-P3-09 frontend apply 到 xterm
- 状态：`TODO`
- 依赖：T-P3-08
- MVP 策略：正确优先（可先合成等价写入，后续再优化）
- 验收：夹具视觉/buffer 与 ANSI 路径一致（自动化 golden 或严格手工清单）

### T-P3-10 seq 丢帧与 snapshot 请求
- 状态：`TODO`
- 依赖：T-P3-05, T-P3-09
- 验收：人为丢 diff 后能恢复（自动 snapshot）

### T-P3-11 Cell metrics
- 状态：`TODO`
- 依赖：T-P3-05
- 验收：`/api/system` 可见 cellSnapshots/cellDiffs/cellFallbackAnsi

### T-P3-12 P3 验收
- 状态：`TODO`
- 依赖：T-P3-01..11
- 勾选：
  - [ ] flag 关 = 基线行为
  - [ ] flag 开 + caps：夹具显示正确
  - [ ] spinner 夹具稳态 wire 体积 ≥50% 下降（相对同内容 ANSI binary）
  - [ ] 无额外攒帧延迟（与现 flush 对齐）
  - [ ] 多 web 同时 cell 模式可工作

---

## P4 — Cell 加固 + 压缩叠加

### T-P4-01 扩展 parser 序列（按回归缺口）
- 状态：`TODO`
- 依赖：T-P3-12
- 验收：REGRESSION 缺口清零或文档标明 fallback

### T-P4-02 cell 帧 gzip 叠加（type 6/8）
- 状态：`TODO`
- 依赖：T-P1-08, T-P3-12
- 验收：大 snapshot 再压；小 diff 按阈值

### T-P4-03 高脏比与 resync 统一
- 状态：`TODO`
- 依赖：T-P3-05
- 验收：满屏刷时自动 snapshot，不炸 diff 列表

### T-P4-04 性能看板 cell 指标
- 状态：`TODO`
- 依赖：T-P3-11
- 验收：性能 tab 可见 cell 帧计数/fallback

### T-P4-05 宽字符与边界 fuzz
- 状态：`TODO`
- 依赖：T-P3-02
- 验收：随机短序列 fuzz 不崩溃；失败走 fallback

### T-P4-06 默认策略评估
- 状态：`TODO`
- 依赖：T-P4-01..05, 完整回归
- 产出：是否默认 `TMUXGO_STREAM_CELL=1` 的书面结论（WORKLOG）
- 验收：有明确 go/no-go

### T-P4-07 P4 出口
- 状态：`TODO`
- 依赖：T-P4-06
- 验收：Cell workstream 可发布（flag 或默认按结论）

---

## P5 — 收尾

### T-P5-01 用户文档
- 状态：`TODO`
- 依赖：P2+P4 出口
- 产出：README 或 docs 短文：能力、环境变量、如何关
- 验收：新人可按文档开关

### T-P5-02 模块边界注释/预留 shared grid
- 状态：`TODO`
- 依赖：T-P3-01
- 验收：`terminal-grid` API 可被「未来 session fan-out」调用，无循环依赖

### T-P5-03 最终对比报告
- 状态：`TODO`
- 依赖：P1–P4
- 产出：WORKLOG 附录：基线 vs 压缩 vs cell 的体积/体感
- 验收：三行以上数据表

### T-P5-04 关闭计划门禁
- 状态：`TODO`
- 依赖：T-P5-01..03
- 验收：全部必做 TODO 为 DONE 或 SKIPPED（附理由）

---

## 并行度说明

```
P0 全部
  ↓
P1 压缩 MVP  ──────────────┐
  ↓                        │
P2 压缩加固                 │
                           ↓
              P3 Cell MVP（协议 type 不冲突即可与 P2 尾部交叠）
                           ↓
                         P4
                           ↓
                         P5
```

- **禁止**：P0-06 未确认就写 P1/P3 业务代码  
- **允许**：P1 与 P3 文档/夹具层并行；P3 代码建议 P1 合并后再做以免 caps 混战  

---

## 每项任务完成时的最低记录（开工后）

对每个 `DONE` 项在 `WORKLOG.md` 追加：

```
### <TODO-ID> <标题>
- 完成时间：YYYY-MM-DD HH:mm:ss +08:00
- 改动文件：
- 验证命令/结果：
- 风险/后续：
```

---

## 附录 A — 建议优先级（若必须砍 scope）

若资源不足，保留顺序：

1. P0 + P1（压缩大帧）— 必做  
2. P3 正确性 MVP — 必做（你要求两套都做）  
3. P2 看板 — 可瘦身  
4. P4 叠加 gzip cell — 可稍后  
5. P5 文档 — 必做短版  

**不可砍**：协商、回退、flag、正确性测试。

---

## 附录 B — 当前阻塞

| 阻塞 | 说明 |
|---|---|
| 等待计划确认 | 用户确认 PLAN/PROTOCOL/本 TODOLIST 后，关闭 T-P0-06 并开始 P1 |

