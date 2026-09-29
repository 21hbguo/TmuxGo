# 仓库质量与开放协作优化建议

基于 2026-09-29 仓库现状。按风险与改动成本分批实施；本文件是建议，不表示相应代码或 CI 已修改。

## P0：把完整 e2e 纳入合并门禁

**现状**：`.github/workflows/ci.yml` 在 PR 和 `master`/`main` push 时运行 `smoke`，`e2e` job 只在 `workflow_dispatch` 运行。`pnpm run test:e2e` 已串行覆盖普通 Playwright、鉴权、默认密码、鉴权重启和 agent；`test:ssh-e2e` 需要真实远端，属于另一类集成测试。

1. 保留快速的 `smoke` 作为独立检查，同时让现有 `e2e` job 在 `pull_request` 和 push 时运行；先沿用现有 `scripts/run-e2e.ts` 等隔离环境，不重写测试基础设施。若 PR 时长明显上升，可先只在 PR 跑全套，再决定是否在 push 重跑；不要以夜间任务替代合并门禁。
2. 在仓库设置中保护实际默认分支（目前是 `master`）：将 `e2e` 以及现有 lint/typecheck、单测、build、smoke 列为必需状态检查，禁止检查未通过时合并。仅改 workflow 而不配置分支保护，仍可绕过门禁。
3. 为 `e2e` 设置合理的 job 超时，失败时上传 Playwright trace、截图和测试报告；检查上传内容是否包含 token、密码或终端敏感输出。先测量时长和失败率，确认隔离性后再考虑按场景分片、缓存浏览器依赖；不要并行运行会共享 tmux 或端口的用例。
4. `test:ssh-e2e` 保留人工或隔离环境的定期验证，不能在公共 PR 上直接使用真实生产 SSH 凭据。

**验收**：PR 未通过完整 `test:e2e` 无法合并；故意让一项非 smoke e2e 失败，可看到阻断和可定位的失败产物。

## P1：清理主干的过程性文件

**现状**：Git 当前跟踪 `TmuxEmil/` 的 30 个文件，以及 `.trae/`、`.dbg/`、`0802-goal.md`、`FLUENCY_OPTIMIZATION_REVIEW.md`。数量以 `git ls-files` 为准，不按文件夹印象估计。`docs/` 也有设计记录，其中具有长期参考价值的内容不应一并删除。

1. 逐项筛选：保留架构决策、可复现的排障结论和正式设计文档；任务派发、个人复盘、临时环境信息、调试输出移出仓库，在个人笔记/内部归档保存。必要时先将长期有效结论摘入正式文档，再移走原稿；不删除代码中说明安全、协议或 tmux workaround 的记录性注释。
2. 在 `.gitignore` 中加入确认仅供本地使用的路径；对已跟踪文件单独使用 `git rm --cached` 停止跟踪，审核暂存区后提交。`.gitignore` **不会**自动从历史或索引中移除文件。
3. 在移走前检查这些文件是否有凭据或隐私信息：普通删除不能抹掉 Git 历史；仅在确有泄露时另行安排密钥轮换和历史清理，避免为一般清理重写历史。
4. 对新增文档形成轻量规则：正式设计/故障结论放 `docs/`，个人工作记录不提交；PR 中可检查非预期路径。

**验收**：上述私人/临时路径不再出现在新版本文件树，正式参考资料可从 `docs/` 找到，后续提交不再混入过程性文件。

## P1：补齐 CLI、MCP 两个入口的质量保障

**现状**：`apps/cli` 有 4 个 `.mjs` 文件（`bin/tmuxgo.mjs`、`lib/` 下 3 个），`apps/mcp/index.mjs` 为 453 行；两者虽然会被现有 ESLint 扫描，但根目录 `typecheck` 仅检查 frontend/gateway/agent，且目前缺少专门的入口契约测试。CLI 打包脚本 `scripts/prepare-npx-package.sh` 会拷贝 gateway/frontend 构建产物。

1. 先用独立 `tsconfig` 对两个包的 `.mjs` 开启 `allowJs`、`checkJs`、`noEmit`，纳入现有 `typecheck`，只为真实类型边界补 JSDoc，不修改已发布入口、打包结构或运行命令。类型告警按包逐步消化，避免一次性重写。
2. CLI 增加安装器/启动器的入口测试：`npm pack` 后从临时目录安装并执行 `--help`/必要的安装与启动烟测；检查 `vendor`、可执行入口及 `postinstall` 行为，不能只测仓库源码。涉及系统改动的安装步骤放隔离 CI 环境，不碰用户机器。
3. MCP 增加 stdio 协议测试：启动真实 `index.mjs`，验证 `initialize`、`tools/list`、有效/无效 `tools/call`、无 token 的错误响应与 stdout 纯协议输出；涉及 gateway 的调用通过隔离测试服务验证。固定响应 shape，避免升级破坏客户端。
4. 等这些测试稳定后，再评估是否将源码迁移 TS 并保留 `.mjs` 发布产物；迁移不是建立门禁的前提。

**验收**：CI 运行两个包的静态检查及入口测试；打包产物在临时安装环境可用，MCP 客户端能完成一次协议交互。

## P2：社区化，但不做破坏性包名调整

1. 添加 `CONTRIBUTING.md`：Node/pnpm 版本、启动与最小验证命令、e2e 所需 tmux/Chromium、PR 提交要求、哪些资料不进仓库。`.github/ISSUE_TEMPLATE/` 分别提供 bug/功能模板，`.github/PULL_REQUEST_TEMPLATE.md` 列明复现步骤、测试、截图与兼容性检查；避免模板重复 README。
2. 将可贡献范围和项目维护节奏写清楚；README 已有简短“贡献”段落，可链接至贡献指南。
3. `@21hbguo/tmuxgo` 出现在包名、发布脚本和中英文 README。个人 scope 并非软件缺陷；只有确定长期维护组织、npm 发布权限及迁移路径后，才考虑组织 scope。若迁移，保留旧包的迁移提示或兼容发布方案，并同步更新安装命令与自动化，不能直接全局替换包名。

**验收**：外部贡献者不依赖私聊即可复现、验证并提交 PR；已有 `npx @21hbguo/tmuxgo` 用户不受文档治理影响。

## P2：明确单用户定位；团队权限单独立项

**现状**：README 已说明默认 `admin`、首次修改密码和设备会话，但没有显式说明“一个 Gateway 对应一个管理身份”，容易被理解为具备团队隔离。共享链接的只读访问不等同于多用户 RBAC。

1. 在中英文 README 的“默认安全模型”各补一句：面向个人自托管、单个管理身份；不提供多账号、角色权限、操作审计或租户隔离；需要多人独立授权时，不应把共享账号当团队权限方案。
2. 团队场景如确有需求，再单独设计账户存储迁移、会话/终端/主机资源归属、分享链接权限、逐操作授权和审计日志。先写威胁模型与迁移方案，再决定是否开发；不为“支持团队”直接放宽现有鉴权。

**验收**：读者能在 README 找到明确的适用边界；现有单用户部署与登录逻辑不变。

## P3：技术债与依赖治理

1. **React 18 → 19**：现有 frontend 声明 React/React DOM `^18.2.0`、`@testing-library/react` `^14.3.1`。只在依赖兼容矩阵、类型包和 frontend 测试均通过后单独开升级 PR；先检查 Vite 插件、Monaco、组件库与事件/渲染行为，按官方迁移指南逐项处理。不是本轮合并门禁的先决条件。
2. **前端体量**：`apps/frontend/src` 的 TS/TSX 约 74,836 行。先按路由/功能统计构建产物和改动热点，选最大且可独立加载的页面做一次懒加载试点，比较首屏体积与实际体验；不凭总代码行数直接做大规模模块迁移。分包时留意 gateway 依赖的 Vite manifest、service worker 更新和 noVNC 产物。
3. **漏洞审计**：现有 Dependabot 更新 npm 和 Actions 依赖，但 CI 未见审计步骤。先增加独立的 `pnpm audit --prod --audit-level high` 检查并记录已有结果；逐条核实可达性和修复版本，再决定将其设为 PR 必需检查。对开发依赖可单独周期审计；确需忽略的告警写明依据、责任人和复查日期，避免将历史积压一次性变成不可合并门禁。审计只能辅助排查，不替代升级、代码审查或发布前核验。

**验收**：升级/拆包各有独立回归指标；高危生产依赖告警能被持续发现和处置，新引入风险不能静默进入主干。

## 建议落地顺序

| 批次 | 范围                                  | 合并前检查                    |
| ---- | ------------------------------------- | ----------------------------- |
| 1    | 完整 e2e 自动运行、分支保护、失败产物 | 非 smoke 用例失败时 PR 被拦截 |
| 2    | 工作文件筛选归档、停止跟踪、忽略规则  | 暂存区审查和凭据扫描          |
| 3    | CLI/MCP checkJs 与打包/协议测试       | 两入口在 CI 中被实际执行      |
| 4    | 贡献材料、README 单用户边界           | 中英文措辞一致、无包名破坏    |
| 5    | React 迁移评估、前端试点、审计门禁    | 独立 PR 和可量化回归          |

参考：GitHub [必需状态检查](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[Issue/PR 模板](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/configuring-issue-templates-for-your-repository)；Playwright [CI 指南](https://playwright.dev/docs/ci)；TypeScript [JavaScript 类型检查](https://www.typescriptlang.org/docs/handbook/type-checking-javascript-files.html)；pnpm [audit](https://pnpm.io/cli/audit)；React [19 升级指南](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)。
