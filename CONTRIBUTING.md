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
- 个人工作文件、临时排查脚本（过程稿归档到本地 `TmuxEmil/` 或 `notes/`，勿混入 `docs/` 正式目录）
- 构建产物 `apps/frontend/dist` 由发布流程生成，不手改提交

## npm scope 说明（`@21hbguo`）

发布包为 `@21hbguo/tmuxgo`（个人 scope，`npm run publish:npx` 发布），`@21hbguo/tmuxgo-mcp` 暂不发布。**当前保持包名不变**，`npx @21hbguo/tmuxgo install` 用户不受影响。

个人 scope 不是缺陷；只有在确定长期维护组织、npm 发布权限与迁移路径后才会评估组织 scope。若未来迁移：旧包保留并标注 deprecation/迁移提示，或短期双发布兼容，同步更新安装命令与自动化；不允许全局替换包名后让旧用户静默失效。

## 可贡献范围

- bug 修复、测试与文档改进：直接 PR
- 新功能/架构调整：先开 Issue 讨论再动手
- 多账号/RBAC 等团队权限能力当前不在范围内（TmuxGo 定位为个人自托管、单管理身份），有需求请先在 Issue 里讨论威胁模型与迁移方案

## CI 与合并门禁

> 对应 `.github/workflows/ci.yml`；建议分支保护只把 `merge-gate` 标为 required。

### Job 依赖关系

```
lint-typecheck ─┐
test (node20/22) ┼─► smoke ─┐
build ──────────┘           ├─► gate (merge-gate)
e2e ────────────────────────┘
ssh-e2e（可选信号，不进 gate）
```

- `lint-typecheck`：eslint（warning 基线只降不升）、typecheck、变更文件 prettier。
- `test`：node 20/22 矩阵，`pnpm test`（gateway + tests/ 全量）+ `pnpm run test:frontend`。
- `build`：`pnpm run build`。
- `smoke`：`pnpm run test:smoke`（登录 + 终端附着冒烟）。
- `e2e`：`pnpm run test:e2e`（run-e2e + auth-e2e + default-auth + auth-restart + agent-e2e），45min `timeout-minutes`，单 job 串行、隔离 tmux server/端口/HOME，不与其它 job 共享环境。
- `gate`（name: `merge-gate`）：`needs` 上述五项，`always()` 检查全部 `success`，任一失败即红。
- `ssh-e2e`：真实远端 SSH e2e，可选回归信号，**不进 merge gate**。

### Required check 配置建议

分支保护只需把一个 check 标为 required：**`merge-gate`**（即 gate job 的 name）。其余 job 保留为信息性状态。

### 触发与时长

- `pull_request`（全部）、`push` 到 master/main、`workflow_dispatch`。
- 预算：lint/test/build/smoke 分钟级；e2e 单次全量，45min 硬超时防悬挂。

### E2E 失败产物与脱敏

- 仅 `failure()` 时上传 `test-results/` + `playwright-report/`，retention 7 天。
- 上传前跑 `pnpm exec tsx scripts/scrub-e2e-artifacts.ts test-results playwright-report`：
  - 删除式替换所有 secret 形态 env 值（key 含 TOKEN/PASSWORD/SECRET/PRIVATE_KEY/PASSPHRASE/CREDENTIAL 且长度 ≥6）；
  - 替换 `Bearer …`、`x-tmuxgo-agent-token: …`、`authorization: …` 凭据形态；
  - 仅处理 ≤20MiB 文本文件（txt/json/html/log 等）；`.zip` trace 为二进制归档不逐字节改写——e2e 环境全部使用一次性测试凭据与隔离 config，不接触生产凭据。
- 残余风险：截图/视频中的终端输出可能含测试过程打印的任意文本；e2e 全部使用临时生成的测试凭据，泄露面限定为无价值测试值。

### SSH e2e（可选）

- job `ssh-e2e`：`pnpm run test:ssh-e2e`（`scripts/run-ssh-e2e.ts`，真实远端、test session 名隔离）。
- 凭据来自 secrets：`TMUXGO_SSH_E2E_HOST` / `TMUXGO_SSH_E2E_USER`（必需），可选 `TMUXGO_SSH_E2E_AUTH`（agent|key）、`TMUXGO_SSH_E2E_PORT`、`TMUXGO_SSH_E2E_JUMP_HOST`、`TMUXGO_SSH_E2E_KNOWN_HOSTS_POLICY`、`TMUXGO_SSH_E2E_PRIVATE_KEY`（key 模式落 `$RUNNER_TEMP` 0600；agent 模式依赖 runner ssh-agent）。
- **fork PR**：`head.repo.full_name != github.repository` → 整个 job 跳过。
- **同仓未配 secrets**：`Check SSH e2e credentials` step 输出 `::notice::SSH e2e skipped` 并跳过安装/执行，job 仍 success——不阻塞合并、不泄露是否已配置。

### 本地等价验证

- `tests/ci-workflow.test.ts`：ci.yml 结构契约（job 依赖、超时、scrub 先于上传、ssh skip 逻辑、无明文 secret/不指生产 :3001）。
- `tests/scrub-artifacts.test.ts`：脱敏脚本单测（env 采集、文本替换、就地 scrub、缺目录容错）。
- 完整 e2e 本地跑法不变：`pnpm run test:e2e` / `pnpm run test:smoke`（自带隔离环境，无需起生产）。
