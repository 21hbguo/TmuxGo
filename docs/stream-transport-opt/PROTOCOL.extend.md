# Stream Protocol Extension Addendum (wire-compact)

> 状态：**ADDENDUM** — 本文只追加扩展，不修改 `PROTOCOL.md` 冻结正文。  
> Magic 仍为 `0x54 0x47`；冻结 type 1–12 / version=1 语义保持不变。  
> 创建：2026-09-22（分支 `perf/wire-compact`）

本附录覆盖两项传输层扩展：

1. **Agent 上行预压缩**（agent → Gateway 终端输出帧 gzip）
2. **小帧 header 瘦身**（per-connection session 字典 + version=2 紧凑帧）

---

## A. Agent 上行预压缩

远端 agent 侧对终端输出预压缩，弱网跨主机降带宽；Gateway 解压后再走既有 sanitize / 出站压缩路径。

### A.1 协商（register caps）

Agent 在 `register` 中声明能力；Gateway 回显 `registered` 时带上生效 caps：

```json
// agent → gateway
{
  "type": "register",
  "host": { "id": "...", "name": "...", "address": "..." },
  "version": "0.1.0",
  "caps": { "compressTerminalOutput": true }
}

// gateway → agent（仅当接受时回显 true）
{ "type": "registered", "agentId": "...", "caps": { "compressTerminalOutput": true } }
```

- 旧 agent 不带 `caps` → Gateway 不回显 → 上行保持明文（现网行为）。
- 新 agent 未收到 `compressTerminalOutput: true` → **不压缩**（协商失败回退明文，不断连）。
- Gateway 侧对已注册 agent 记录 `caps.compressTerminalOutput`。

### A.2 帧格式

协商成功后，agent 对 `terminal-output` 可发送 gzip 变体：

```json
{
  "type": "terminal-output",
  "attachmentId": "…",
  "encoding": "gzip",
  "data": "<base64 of gzip(utf8 ANSI)>"
}
```

规则：

| 项 | 约定 |
|---|---|
| `encoding` | 缺省 = 明文 utf8 字符串（现网）；`gzip` = base64(gzip(utf8)) |
| 阈值 | 明文 ≥ 256 字节才尝试压缩（避免小帧 base64 膨胀） |
| 更小才发 | base64 后若不小于明文则回退明文 |
| 解压失败 | Gateway **丢弃该帧**（不注入乱码），**不断连**；后续帧继续 |
| 未知 `encoding` | 按明文解释 `data`（不断连） |
| 指标 | `outputBytes` 继续只统计 **Gateway → 浏览器** 的 wire bytes；agent 上行压缩不影响该指标 |

Gateway 解压后的明文进入与现网完全相同的 `onData` → sanitize → 出站压缩路径。

### A.3 SSH 路径

SSH host（`ssh -tt → tmux attach`）不经 agent 进程，PTY 落在 Gateway 本地：

- **不改 sshd / 远端 tmux**。
- Gateway 侧在 spawn `ssh` 时请求 `-o Compression=yes`（是否生效取决于 server `Compression` 配置；OpenSSH 默认常为 `delayed`/`no` 时客户端请求仍安全回退）。
- 弱网跨主机收益主要依赖 **SSH 自带压缩**；agent 模式不可用时不在 Gateway 对 PTY 读入再压（PTY 已在本地，压了也省不了上游带宽）。
- 结论：**Agent 路径用 A.1/A.2 预压缩；SSH 路径依赖 SSH 链路压缩。**

---

## B. 小帧 Header 瘦身（version = 2 + stream_route）

### B.1 设计原则

- **不改** type 1–12 语义；gzip 位规则沿用冻结表。
- 旧客户端（未协商 `compactHeader`）**永不**收到 version=2 帧。
- 帧序不变；JSON 控制面与 binary 帧仍在同一 WebSocket 上保序。

### B.2 Header（version = 2）

12 字节定长头，little-endian；host/session 全文由 `routeIdx` 替代：

| Offset | Size | 字段 |
|---|---|---|
| 0 | 1 | magic0 = `0x54` |
| 1 | 1 | magic1 = `0x47` |
| 2 | 1 | **version = 2** |
| 3 | 1 | type（与冻结表相同：1/2 明文 ANSI，3/4 gzip，5–12 cell） |
| 4 | 2 | **routeIdx**（u16 LE，≥ 1；0 = 非法） |
| 6 | 2 | reserved（写 0，读忽略） |
| 8 | 4 | payloadLen（压缩后或编码后的字节数） |
| 12 | payloadLen | payload |

小帧收益示例：`host=local(5) + session=dev(3)` 时，version=1 头+寻址 20B → version=2 12B。

### B.3 协商（stream_caps 扩展字段）

在既有 `stream_caps` JSON 上增加可选布尔字段：

```json
// client → server
{ "type": "stream_caps", "binaryOutput": true, "compressOutput": "gzip", "cellOutput": false, "compactHeader": true }

// server → client（实际生效交集）
{ "type": "stream_caps", "binaryOutput": true, "compressOutput": "gzip", "cellOutput": false, "compactHeader": true }
```

- 省略字段 = 不支持。
- Server 仅在 `binaryOutput` 生效且请求 `compactHeader: true` 时回显 `true`。
- 环境变量 `TMUXGO_STREAM_COMPACT=0` 可强制关闭（回显 `false`，只发 version=1）。

### B.4 路由字典（stream_route）

**Per-connection** 字典：每条 stream WebSocket 连接独立维护 `routeIdx → {hostId, sessionName}`。

连接建立并完成 caps 协商后（或首次 attach 时），Server 分配索引并下发：

```json
{ "type": "stream_route", "routeIdx": 1, "hostId": "local", "sessionName": "dev" }
```

规则：

1. `routeIdx` 从 **1** 递增（0 保留非法），上界 `0xFFFF`。
2. 同一连接内同一 `(hostId, sessionName)` 映射稳定；重复 `stream_route` 幂等。
3. **Server 必须先发 `stream_route`，再发引用该 idx 的 version=2 帧**（同 socket FIFO 保证）。
4. 字典按连接生命周期；断线重连后重新协商。
5. 索引用尽（极罕见）→ 回退 version=1 全文头，不断连。
6. 切换 attach 到新 session → 补发新的 `stream_route`。

### B.5 解码与错误回退

| 场景 | 行为 |
|---|---|
| version=1 | 照旧解析 host/session 全文 |
| version=2 + 已知 idx | 从字典解析 host/session，payload 规则同 type 表 |
| version=2 + 未知 idx | **丢弃该帧**（不抛异常、不断连）；可依赖后续 resync / 重发 `stream_route` 恢复 |
| 未协商却收到 version=2 | 丢弃（防御：server 不应发送） |
| 与旧帧混用 | 允许：解码器按帧头 `version` 分派，不要求连接级模式锁死 |

### B.6 兼容矩阵（扩展后）

| Client caps | Server 发送 |
|---|---|
| 仅 binary | type 1/2，version=1 |
| + compress | 1/2/3/4 按策略，version=1 |
| + compactHeader | 在 route 就绪后改发 version=2；route 未就绪/回退时仍 version=1 |
| 无 binary | JSON 明文（现网）；不发 compact binary |

### B.7 与指标

- `outputBytes` 记录 **实际写出的 wire bytes**（紧凑帧更短则指标同步变小）。
- 出站 gzip 的 `compressBytesIn/Out` 逻辑不变（仍相对逻辑明文载荷）。

---

## C. 实现锚点

| 能力 | 位置 |
|---|---|
| version=1/2 编码 | `apps/gateway/src/lib/stream-binary.ts` |
| 路由字典 | `apps/gateway/src/lib/stream/stream-route.ts` |
| caps / 发送路径 | `apps/gateway/src/lib/stream/stream-session.ts` |
| agent 上行解压 | `apps/gateway/src/agent-manager.ts`、`apps/gateway/src/lib/agent-terminal-output.ts` |
| agent 预压缩 | `apps/agent/src/index.ts` |
| 前端解码 | `apps/frontend/src/lib/stream-binary.ts`、`hooks/useSessionSocket.ts`、`hooks/useWebSocket.ts` |
| SSH Compression | `apps/gateway/src/lib/terminal-attachment.ts` |
