# 贡献指南 / Contributing

欢迎 Issue、PR 与使用反馈。本文档面向外部贡献者，目标是：不依赖私聊即可复现环境、验证改动并提交 PR。

## 环境要求

- Node.js `^20.19 || ^22.12 || >=24`（`npm run env:check` 可校验）
- pnpm `11.7.0`（见根 `package.json` 的 `packageManager`，可用 corepack 启用）
- tmux `>= 3.6b`、git、curl、python3、ripgrep；`node-pty` 原生依赖需要 `make` / `g++` / `pkg-config`
- e2e 额外需要 Playwright Chromium：`pnpm exec playwright install chromium`

## 启动与最小验证

```bash
pnpm install --frozen-lockfile
npm run dev          # gateway 3101 + vite 5199
```

提交前按改动范围选择：

```bash
npm test                  # 单元/脚本测试
npm run test:frontend     # 前端 vitest
npm run test:e2e          # Playwright e2e（需要本地 tmux）
npm run lint              # eslint
npm run typecheck         # tsc（frontend/gateway/agent/cli/mcp）
npm run build             # 改了前端必须重建 apps/frontend/dist
npm run verify            # 全量：test + frontend test + e2e + build
```

注意：真实 SSH e2e（`test:ssh-e2e`）需要显式环境变量，不纳入默认测试；所有测试性 tmux 操作请在名为 `test` 的 session 中进行，不要动其他 session。

## PR 要求

- 一个 PR 只做一件事；README/文档的中英文改动保持一致
- 通过 CI：`eslint --quiet`、warning 基线检查（只允许下降）、typecheck、变更文件 prettier 校验
- 本地 `lint-staged` 只处理暂存文件；**不做全仓格式化**，存量告警分批清理
- 描述复现步骤、验证命令与结果；UI 改动附截图/录屏
- 协议编解码、tmux workaround、安全分支等非显而易见逻辑写注释说明意图

## 不进仓库的内容

- 凭据、token、本机 `~/.tmuxgo/` 数据与日志
- 个人工作文件、临时排查脚本（`TmuxEmil/`、`docs/` 下的过程稿按仓库约定归档，勿混入正式目录）
- 构建产物 `apps/frontend/dist` 由发布流程生成，不手改提交

## npm scope 说明（`@21hbguo`）

发布包为 `@21hbguo/tmuxgo`（个人 scope，`npm run publish:npx` 发布），`@21hbguo/tmuxgo-mcp` 暂不发布。**当前保持包名不变**，`npx @21hbguo/tmuxgo install` 用户不受影响。

个人 scope 不是缺陷；只有在确定长期维护组织、npm 发布权限与迁移路径后才会评估组织 scope。若未来迁移：旧包保留并标注 deprecation/迁移提示，或短期双发布兼容，同步更新安装命令与自动化；不允许全局替换包名后让旧用户静默失效。

## 可贡献范围

- bug 修复、测试与文档改进：直接 PR
- 新功能/架构调整：先开 Issue 讨论再动手
- 多账号/RBAC 等团队权限能力当前不在范围内（TmuxGo 定位为个人自托管、单管理身份），有需求请先在 Issue 里讨论威胁模型与迁移方案
