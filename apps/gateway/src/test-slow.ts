// @slow 分层：真起 tmux/git/WS 或靠 TTL/心跳等待的用例（单次 >2s 且耗时来自"等"）
// 用这个描述符标住。默认 false（照常跑）；`TMUXGO_TEST_FAST=1 pnpm test` 时跳过，
// 日常迭代拿秒级反馈，全量/CI 仍旧全跑。
// 不标计算密集型用例：它们跑得快，跳过只会丢覆盖率。
export const slowSkip = process.env.TMUXGO_TEST_FAST === '1' ? 'slow: 等待型集成用例（FAST 模式跳过）' : false
