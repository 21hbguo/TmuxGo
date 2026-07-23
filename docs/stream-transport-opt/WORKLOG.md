# 流式传输优化 WORKLOG

## 2026-07-24 — 实现完成

### P0
- 冻结 PROTOCOL.md
- 夹具 tests/fixtures/terminal-streams/*
- REGRESSION.md、bench-stream-transport.ts

### P1/P2 压缩
- gateway stream-binary gzip type 3/4
- stream.ts caps + 阈值策略 + metrics
- frontend async decode + DecompressionStream
- 性能看板压缩指标

### P3/P4 Cell
- terminal-grid parser/grid/diff/encode
- stream.ts cell 模式（TMUXGO_STREAM_CELL=1）
- frontend cell→ANSI apply + seq 恢复
- cell gzip type 6/8 叠加
- 性能看板 cell 指标

### 验证
- `npx tsx --test tests/stream-binary.test.ts tests/terminal-grid.test.ts` 10/10 pass
- bench: resync_full_screen gzipRatio≈0.009；spinner gzipRatio≈0.234
- frontend stream-binary / useSystemInfo / SystemHealthPanel 单测 pass
- `npx tsc -p apps/gateway/tsconfig.json` pass

### 环境变量
- `TMUXGO_STREAM_COMPRESS` 默认开（`0` 关闭）
- `TMUXGO_STREAM_COMPRESS_THRESHOLD` 默认 4096
- `TMUXGO_STREAM_CELL` 默认关（`1` 开启）

## 2026-07-24 — 在线冒烟与优化

### 操作
- `./start.sh --restart --rebuild`
- systemd drop-in: `TMUXGO_STREAM_COMPRESS=1`, `TMUXGO_STREAM_CELL=1`

### 冒烟结果（WS attach tmuxgo, ~5s）
- caps: binary + gzip + cell 均 true
- attached: true
- 帧类型: cell_snapshot_gzip / cell_diff / cell_diff_gzip
- wire/payload ≈ **0.15**（约 **85%** 体积下降）
- compressBytesOut/In ≈ **0.15**
- cellFallbackAnsi: **0**
- 无 gunzip/协议错误

### 优化点
- parser 对未知序列忽略，避免误杀 cell 模式
- 单帧 parse 失败只回退该帧，不永久关闭 cell
- dirty 阈值 0.4 → 0.55
- 无 cell/光标变化时跳过发送
