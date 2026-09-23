# D-B：跳转到实现 / 跳转到类型定义（resolver API + 入口 + 测试）

- worktree：`/home/guo/project/other/TmuxGo-wt-nav-jumps`，分支 `feat/nav-more-jumps`（已建，基于 master 9383603）
- 目标文件：`apps/frontend/src/lib/code-navigation.ts`（新增 API）、`apps/frontend/src/components/EditorWorkbench.tsx`（入口接线）、`apps/frontend/src/i18n` 或 en/zh 文案文件（新增 toast 键）、单测 + `e2e/editor-navigation.spec.ts`（扩用例）
- 背景：resolver 已建完整 LanguageService 管线（虚拟 host + program + checker），但只用了 `getDefinitionAtPosition`。同基建下 `getImplementationAtPosition`/`getTypeDefinitionAtPosition` 是一行 API 的事，覆盖 interface/abstract 跳实现、变量跳类型两个高频场景。

## 实现要求

1. **resolver API**：`resolveEditorImplementation` / `resolveEditorTypeDefinition`（或 `resolveEditorDefinition` 加 `kind` 参数统一入口，worker 按最小 diff 选）。复用同一 LS host/program 构建路径，返回与现有 `{ status, target }` 同形状；多结果取第一个 + toast 提示数量；结果为空明确 `not-found`，不得 1:1 假成功；遵守 signal 取消
2. **入口**：`EditorWorkbench.tsx` keydown capture handler 里加 `Ctrl+F12`（跳实现，VSCode 惯例）与 `Ctrl+Alt+F12`（跳类型定义），与现有 F12 同 preventDefault/stopPropagation 路径；工具栏在现有定义按钮旁加最小入口（下拉或并排按钮，按现有结构选最小改动），三态一致（loading/binary/compare 禁用）
3. **复用生命周期防线**：新入口必须走与 goToDefinition 相同的 abort/stale-guard/pendingLocation 管线（建议把 goToDefinition 泛化为带 kind 的内部函数）；ctrl+click 的 cancel 豁免逻辑不动（它只属于 definition 手势）
4. **多结果 toast**：i18n 键新增（en/zh 双语），如「共 N 处实现，已跳至首个」
5. **E2E**（扩 `e2e/editor-navigation.spec.ts` 正式用例）：
   - interface `Shape` 在 a-entry、实现类 `Circle`/`Square` 在另一文件 → Ctrl+F12 落在实现类声明（断言真实行列+可见）
   - `const c: Circle = ...` 调用点 `c.area()` 的 `c` → Ctrl+Alt+F12 落在 Circle 类声明
   - 断言真实 model URI，不落 import 行
6. **单测**：resolver 层覆盖 interface→impl、typeAnnotation→class、多实现取首个+数量、not-found；组件层覆盖快捷键分发与 stale-guard 复用

## 流程

1. `cd /home/guo/project/other/TmuxGo-wt-nav-jumps`（node_modules 已装好）
2. 建 todo；先读 `code-navigation.ts` 尾部 LS 构建段（约 985-1056 行）与 `EditorWorkbench.tsx` 的 F12/goToDefinition 管线
3. 验证：`cd apps/frontend && npx vitest run`（相关文件）、`npm run typecheck`、`env -u TMUX npx tsx scripts/run-e2e.ts e2e/editor-navigation.spec.ts`、eslint/prettier 改动文件净
4. commit 到分支（**不 push**），回执 DONE 到 %0：commit、改动文件、验证结果、遗留风险

## 安全红线

- 严禁裸 `tmux`；e2e 必须走 `env -u TMUX npx tsx scripts/run-e2e.ts`；永不 `kill-server`/`kill-session`
- 与 D-A（paths 补强）同改 `code-navigation.ts`：**新增的 resolver 函数尽量追加在文件尾/独立区段**，减少合并冲突；合并顺序 D-A 先
- 不碰 `code-navigation.ts` 现有 `resolveModuleSpecifier` 区段逻辑
