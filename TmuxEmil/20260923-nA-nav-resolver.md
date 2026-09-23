# N-A：跳转解析器修假成功（code-navigation.ts）

- worktree：`/home/guo/project/other/TmuxGo-wt-nav-resolver`，分支 `fix/nav-resolver-reexports`（已建，基于 master 1813fa3）
- 依据：`docs/editor-navigation-boundary-review-20260923-093054.md` §二（先通读全文，重点 §一/§二/§六验收矩阵）
- 目标文件：`apps/frontend/src/lib/code-navigation.ts` 及其单测 `code-navigation.test.ts`

## 已复现 bug（N1）

- `findExportedNode`（约 214–262 行）：不跟随 `export { foo } from './impl'` / `export * from './impl'`；本地声明查找允许命中 ImportSpecifier；`export default foo` 返回 export 表达式而非真实声明
- `resolveEditorDefinition`（约 830–865 行）：快捷路径找到模块即返回 success；`targetNode?.getStart(...) || 0` 把未找到定义伪装成 1:1 成功

## 修复要求（照文档 §二最小修复要求）

1. 保留直接导出快速路径，不得退化为全项目扫描拖慢解析
2. 快捷路径只有命中真实声明才返回 success；不允许 1:1 假成功（点模块路径字符串打开文件首行是另一语义，可保留）
3. 补：中转导出（named/star re-export）、导出别名、import 后再 export、default identifier → 真实声明；可复用现有语义解析，最小补丁，不重写架构
4. 跟随导出链按「文件+符号」去重并响应取消；循环导出必须终止；找不到定义要明确失败而非落首行
5. 不硬编码到函数体第一行；测试断言真实声明节点/函数标识符行列

## 必过 fixture（文档 §二表，全部落成正式单测）

- `import { foo } from './impl'` → impl.ts 真实声明（已过的对照，防回归）
- barrel `export { foo } from './impl'` / `export * from './impl'` → impl.ts 声明（不再 barrel.ts:1:1）
- barrel `import { foo } + export { foo }` → impl.ts 声明（不再命中 import specifier）
- `import foo from './default'` → default.ts 内 `function foo` 声明（不再 export 引用处）
- 循环 re-export、缺失符号：明确失败不 1:1

## 流程

1. `cd /home/guo/project/other/TmuxGo-wt-nav-resolver && pnpm install`
2. 建 todo；先写红测复现 fixture 再修
3. 验证：`npx vitest run src/lib/code-navigation.test.ts`（apps/frontend 目录）、`npm run typecheck`、eslint/prettier 改动文件净
4. commit 到分支（**不 push**），回执 DONE 到 %0：commit、改动文件、验证结果、遗留风险

## 安全红线

- 严禁裸 `tmux`（本包不需要任何 tmux）
- 不碰 `EditorWorkbench.tsx`（N-B 地盘）
