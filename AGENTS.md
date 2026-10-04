# Global Rules

- 变量命名格式保持前后一致
- 代码紧凑，不写废话
- 答复简洁专业、紧凑准确
- 输出仅核心内容，不冗余表述
- 协议编解码、tmux 行为 workaround、安全相关分支等非显而易见逻辑必须写注释说明意图
- 提交前通过 eslint / prettier / typecheck，存量告警分批清理，不做一次性全仓格式化
- 涉及 GitHub 远端操作时优先使用 github-ops skill
- GitHub 的 push、pull、ls-remote、repo view、远端校验前先检查代理链路
- 本机存在 Mihomo/Clash 本地代理时优先走 socks5h://127.0.0.1:7890
- 可用 zsh 的 proxy_fast_local 快速接入代理
- 若仓库已配置 git http.proxy 和 https.proxy，则优先复用仓库本地代理配置
- 测试 session 画面、tmux 行为等一律在名为 test 的 tmux session 中进行，不得操作用户其他 session
- 禁止遍历 /tmp 目录批量 `tmux kill-server`：`TMUX` 已设置时 tmux CLI 忽略 TMUX_TMPDIR、直接用 TMUX 内嵌的 socket 路径，批量清理会误杀用户 default server（2026-10-04 全 pane 消失事故根因）。任何 tmux server 生命周期操作必须显式 `-S <socket路径>` 且 `env -u TMUX`（或 `TMUX=''`）
- 跑单测/单文件用根目录 `pnpm test <路径子串>`（run-tests.ts 支持过滤并负责隔离+清理），禁止自造 TMUX/TMUX_TMPDIR env 直跑 `tsx --test`
- 完成代码改动后必须重启运行中的 app 让用户能立即体验：生产实例用 `systemctl --user restart tmuxgo-gateway`（端口 3001，systemd user service），前端 dist 随请求读取无需重启但要重新 build；dev 实例为 3101 gateway + 5199 vite
