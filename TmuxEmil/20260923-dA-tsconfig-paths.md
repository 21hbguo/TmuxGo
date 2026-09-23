# D-A：跳转解析器 tsconfig paths / ESM 扩展名映射补强（code-navigation.ts）

- worktree：`/home/guo/project/other/TmuxGo-wt-nav-paths`，分支 `feat/nav-tsconfig-paths`（已建，基于 master 9383603，含 warmup 提交）
- 目标文件：`apps/frontend/src/lib/code-navigation.ts` 及其单测 `code-navigation.test.ts`
- 背景：resolver 当前 `resolveModuleSpecifier`（约 510 行起）只硬编码 `@/`→sourceRootPath、相对路径、node_modules 逐层上溯（main/module/types/exports）。真实项目里 tsconfig `paths`/`baseUrl` 自定义别名、`import './x.js'`→`x.ts` 的 ESM 写法、`exports` 通配子路径全部解析不到 → not-found。这是 N-A 已修功能的正确性加固。

## 修复要求

1. **tsconfig paths/baseUrl**：从含导入语句的文件目录向上找最近 `tsconfig.json`（到 `context.rootPath` 为止），经 `readResolverFile` 读入、`ts.parseConfigFileTextToJson` 解析（JSONC，容忍注释/尾逗号）。取 `compilerOptions.paths` + `baseUrl`：
   - bare specifier 先按 paths 匹配（精确 key、单 `*` 通配取最长前缀、数组按序回退），目标相对 baseUrl（无 baseUrl 时相对 tsconfig 目录）
   - paths 未命中时再尝试 `baseUrl/specifier`（仅当配置了 baseUrl）
   - 命中 paths/baseUrl 后仍走 `resolveFileCandidate` 补扩展名/index
   - 优先级：paths → baseUrl → node_modules 现有上溯逻辑；硬编码 `@/` 兜底保留在 paths 失败之后（tsconfig 优先）
   - `extends` 链：做单层（tsconfig 里 `extends` 指向同 root 内文件时合并 compilerOptions），更深不递归，注释说明边界
   - tsconfig 解析结果按文件路径缓存进 context（避免每次跳转重读）
2. **`.js`→`.ts` ESM 映射**：specifier 以 `.js/.jsx/.mjs/.cjs` 结尾且按字面解析失败时，替换为 `.ts/.tsx/.mts/.cts` 再试（含 `.d.ts` 变体）
3. **`exports` 通配子路径**：package.json `exports` 的 key 含 `*` 时做子路径模式匹配并把命中段代入目标 `*`（如 `"./*": "./dist/*.js"`）；现有精确 key/条件对象逻辑不动
4. 全链路遵守 `signal` 取消；解析失败仍明确 `not-found`，不得回落 1:1

## 必过 fixture（落成正式单测）

- `import { x } from '#/lib'`（paths `"#/*": ["./src/*"]`）→ src/lib.ts 真实声明
- `import { x } from 'util'`（仅 `baseUrl: "src"`）→ src/util.ts
- paths 数组回退：第一个目标不存在时用第二个
- `import { x } from './impl.js'` 实际文件 impl.ts → 命中（NodeNext 写法）
- exports 通配：`"exports": {"./*": "./dist/*.js"}` + `import pkg/sub` → dist/sub.js
- 无 tsconfig / 未命中别名：维持原行为且明确 not-found

## 流程

1. `cd /home/guo/project/other/TmuxGo-wt-nav-paths`（node_modules 已装好）
2. 建 todo；先写红测再实现
3. 验证：`cd apps/frontend && npx vitest run src/lib/code-navigation.test.ts`、`npm run typecheck`（仓库根）、eslint/prettier 改动文件净
4. commit 到分支（**不 push**），回执 DONE 到 %0：commit、改动文件、验证结果、遗留风险

## 安全红线

- 严禁裸 `tmux`（本包不需要）；如需手动命令必须 `env -u TMUX TMUX_TMPDIR=<私有目录>`
- 不碰 `EditorWorkbench.tsx`（D-B 地盘）；改动尽量集中在 `resolveModuleSpecifier`/`resolvePackageEntry`/`resolveFileCandidate` 区段，便于与并行工作合并
