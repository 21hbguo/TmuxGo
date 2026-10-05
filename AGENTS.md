# Global Rules

- 变量命名格式保持前后一致
- 代码紧凑，不写废话
- 答复简洁专业、紧凑准确
- 输出仅核心内容，不冗余表述
- 协议编解码、tmux 行为 workaround、安全相关分支等非显而易见逻辑必须写注释说明意图
- 提交前通过 eslint / prettier / typecheck，存量告警分批清理，不做一次性全仓格式化
- 测试 session 画面、tmux 行为等一律在名为 test 的 tmux session 中进行，不得操作用户其他 session
- 禁止遍历 /tmp 目录批量 `tmux kill-server`：`TMUX` 已设置时 tmux CLI 忽略 TMUX_TMPDIR、直接用 TMUX 内嵌的 socket 路径，批量清理会误杀用户 default server。任何 tmux server 生命周期操作必须显式 `-S <socket路径>` 且 `env -u TMUX`（或 `TMUX=''`）
- 跑单测/单文件用根目录 `pnpm test <路径子串>`（run-tests.ts 支持过滤并负责隔离+清理），禁止自造 TMUX/TMUX_TMPDIR env 直跑 `tsx --test`
