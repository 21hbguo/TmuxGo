# CI 与合并门禁

> Status: current（`.github/workflows/ci.yml` 对应文档）

## Job 依赖关系

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

## Required check 配置建议

分支保护只需把一个 check 标为 required：**`merge-gate`**（即 gate job 的 name）。其余 job 保留为信息性状态。

## 触发与时长

- `pull_request`（全部）、`push` 到 master/main、`workflow_dispatch`。
- 预算：lint/test/build/smoke 分钟级；e2e 单次全量，45min 硬超时防悬挂。

## E2E 失败产物与脱敏

- 仅 `failure()` 时上传 `test-results/` + `playwright-report/`，retention 7 天。
- 上传前跑 `pnpm exec tsx scripts/scrub-e2e-artifacts.ts test-results playwright-report`：
  - 删除式替换所有 secret 形态 env 值（key 含 TOKEN/PASSWORD/SECRET/PRIVATE_KEY/PASSPHRASE/CREDENTIAL 且长度 ≥6）；
  - 替换 `Bearer …`、`x-tmuxgo-agent-token: …`、`authorization: …` 凭据形态；
  - 仅处理 ≤20MiB 文本文件（txt/json/html/log 等）；`.zip` trace 为二进制归档不逐字节改写——e2e 环境全部使用一次性测试凭据与隔离 config，不接触生产凭据。
- 残余风险：截图/视频中的终端输出可能含测试过程打印的任意文本；e2e 全部使用临时生成的测试凭据，泄露面限定为无价值测试值。

## SSH e2e（可选）

- job `ssh-e2e`：`pnpm run test:ssh-e2e`（`scripts/run-ssh-e2e.ts`，真实远端、test session 名隔离）。
- 凭据来自 secrets：`TMUXGO_SSH_E2E_HOST` / `TMUXGO_SSH_E2E_USER`（必需），可选 `TMUXGO_SSH_E2E_AUTH`（agent|key）、`TMUXGO_SSH_E2E_PORT`、`TMUXGO_SSH_E2E_JUMP_HOST`、`TMUXGO_SSH_E2E_KNOWN_HOSTS_POLICY`、`TMUXGO_SSH_E2E_PRIVATE_KEY`（key 模式落 `$RUNNER_TEMP` 0600；agent 模式依赖 runner ssh-agent）。
- **fork PR**：`head.repo.full_name != github.repository` → 整个 job 跳过。
- **同仓未配 secrets**：`Check SSH e2e credentials` step 输出 `::notice::SSH e2e skipped` 并跳过安装/执行，job 仍 success——不阻塞合并、不泄露是否已配置。

## 本地等价验证

- `tests/ci-workflow.test.ts`：ci.yml 结构契约（job 依赖、超时、scrub 先于上传、ssh skip 逻辑、无明文 secret/不指生产 :3001）。
- `tests/scrub-artifacts.test.ts`：脱敏脚本单测（env 采集、文本替换、就地 scrub、缺目录容错）。
- 完整 e2e 本地跑法不变：`pnpm run test:e2e` / `pnpm run test:smoke`（自带隔离环境，无需起生产）。
