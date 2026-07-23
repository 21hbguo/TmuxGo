# Stream Binary Protocol Draft（待 T-P0-01 冻结）

> 状态：**DRAFT** — 确认后改名为 `PROTOCOL.md` 并删 draft 字样  
> Magic: `0x54 0x47`（`T``G`）  
> 现网 version: `1`，type `1/2` 保持不变

## 1. 公共 Header（12 bytes，little-endian 多字节）

| Offset | Size | 字段 |
|---|---|---|
| 0 | 1 | magic0 = `0x54` |
| 1 | 1 | magic1 = `0x47` |
| 2 | 1 | version = `1` |
| 3 | 1 | type（见下表） |
| 4 | 2 | hostLen |
| 6 | 2 | sessionLen |
| 8 | 4 | payloadLen（**压缩后或编码后的**字节数） |
| 12 | hostLen | hostId utf8 |
| 12+hostLen | sessionLen | sessionName utf8 |
| … | payloadLen | payload |

## 2. Type 表（拟定）

| type | 名称 | payload 含义 | 默认是否启用 |
|---|---|---|---|
| 1 | `output` | utf8 ANSI 明文 | 是（现网） |
| 2 | `output_resync` | utf8 ANSI 明文全屏/resync | 是（现网） |
| 3 | `output_gzip` | gzip(utf8 ANSI) | 协商 + 策略 |
| 4 | `output_resync_gzip` | gzip(utf8 ANSI) | 协商后 resync 默认 |
| 5 | `cell_snapshot` | 见 §4 | 协商 + flag |
| 6 | `cell_snapshot_gzip` | gzip(§4) | 协商 + 大帧策略 |
| 7 | `cell_diff` | 见 §5 | 协商 + flag |
| 8 | `cell_diff_gzip` | gzip(§5) | 协商 + 阈值 |

未知 type：接收方忽略该帧（不可断连）。

## 3. stream_caps

### 3.1 Client → Server

```json
{
  "type": "stream_caps",
  "binaryOutput": true,
  "compressOutput": "gzip",
  "cellOutput": true
}
```

- 省略字段 = 不支持  
- `compressOutput` 仅允许 `"gzip"` 或省略/false  
- `cellOutput` boolean  

### 3.2 Server → Client（实际生效）

```json
{
  "type": "stream_caps",
  "binaryOutput": true,
  "compressOutput": "gzip",
  "cellOutput": false
}
```

Server 只 echo **双方交集**。例如 server flag 关 cell 则 `cellOutput:false`。

## 4. cell_snapshot payload（未压缩逻辑布局）

全部 little-endian。

```
cols: u16
rows: u16
cursorX: u16
cursorY: u16
flags: u16
seq: u32
runCount: u32
// repeated runCount times:
//   runLen: u16   // 连续相同 cell 数，行优先扫描
//   cp: u32       // Unicode code point；0 可表示空
//   attr: u32     // bit flags: bold,dim,italic,underline,inverse,...
//   fg: u32       // 0x00RRGGBB 或索引色约定（冻结时写清：高位标记色彩空间）
//   bg: u32
```

**色彩空间拟定（待冻）**：

- `attr` bit31-30：fg 类型 00=default, 01=indexed256, 10=truecolor, 11=reserved  
- `attr` bit29-28：bg 类型 同上  
- indexed 时 `fg/bg` 低 8 位为 index  

宽字符：占两列时第二列 `cp` 用哨兵 `0xFFFFFFFF` 表示「宽字符延续」（或专用 attr 位）。**冻结前必须二选一写死。**

## 5. cell_diff payload

```
seq: u32
baseSeq: u32
cursorX: u16
cursorY: u16
flags: u16
changeCount: u32
// repeated changeCount:
//   x: u16
//   y: u16
//   cp: u32
//   attr: u32
//   fg: u32
//   bg: u32
```

规则：

- 首帧 attach 后必须先 `snapshot`（seq=S0）  
- diff 的 `baseSeq` 必须等于客户端最后成功应用的 seq  
- 不匹配 → 客户端请求恢复（见 §6）  
- `changeCount==0` 仍可发（仅 cursor/flags 变）或省略发送  

## 6. 恢复与控制消息（JSON，与现网共存）

拟定新增（可选，实现时最小集）：

```json
{ "type": "cell_resync_request", "sessionName": "...", "hostId": "..." }
```

Server 收到后发 `cell_snapshot`（或 ANSI resync，若 cell 关闭）。

也可复用现有 output_resync 路径：cell 模式下 resync = snapshot。

## 7. 压缩策略常量（默认）

| 常量 | 默认 | 说明 |
|---|---|---|
| `COMPRESS_THRESHOLD` | 4096 | 小于此的 output 不压 |
| resync | 总是尝试压（若已协商） | 除非压缩后更大则回退明文 |
| cell_diff | 仅 `payload >= threshold` 才走 gzip type | 小 diff 不压 |

「压缩后更大则回退明文」：必须实现，避免负优化。

## 8. 与现网兼容矩阵

| Client caps | Server 发送 |
|---|---|
| 仅 binary | type 1/2 only |
| +compress | 1/2/3/4 按策略 |
| +cell | 5/7（+6/8 若 compress）与 fallback 1/2 |
| 无 binary | JSON 明文（现网）；不发 cell/compress binary |

## 9. 待确认问题（确认后删本节）

1. 宽字符第二列哨兵方案 A/B？  
2. Cell MVP 是否必须 truecolor？还是 16 色足够先上？  
3. `TMUXGO_STREAM_CELL` 默认 0 是否同意？  
4. type 编号 3–8 是否一次占号（同意推荐）？  
