# 分支功能吸收 TODOLIST

状态：进行中

状态约定：`TODO` | `DOING` | `DONE` | `BLOCKED` | `SKIPPED`
基线分支：`autoresearch/jul24`（`8761169`）
原则：只选择性吸收功能和修复，不直接合并整个历史分支；每项先完成代码对比和测试设计，再决定是否改代码。

## 评审结论

### 值得优先吸收

- `feature/code-navigation`：编辑器 TypeScript/JavaScript 定义跳转、F12、导航前进后退。当前分支没有 `apps/frontend/src/lib/code-navigation.ts`，属于明确缺失的用户功能。
- `session-panel-enhancements`：Git diff 编辑器不写入持久化状态，FilePanel 跟随编辑器时抑制重复跳转，目录/预览加载失败重试，以及 Session/FilePanel 的稳定重渲染。
- `backup/remote-master-before-force-20260603`：附着首屏快照、旧 pane ID 错误反馈、IME 组合输入和会话排序 hydration 保护。需要逐项核对当前实现。

### 需要验证后吸收

- `terminal-pane-enhancements`：visual freeze、`snapshot_refresh`、附着和 pane resize 后的强制快照恢复。当前主线已有 binary output、gzip、cell resync、backpressure 等较新的流协议，不能直接 cherry-pick，需重新对齐协议和多客户端行为。
- `backup/remote-master-before-force-20260603` 中的终端尺寸、移动端键盘和渲染修复。该分支整体落后当前主线，只有经回归验证后才可局部移植。

### 不直接吸收

- 不整体合并 `feature/code-navigation`、`session-panel-enhancements`、`terminal-pane-enhancements`。这些分支改动集中在相同文件，且与当前主线的 `TerminalPane`、`stream.ts` 已经发生结构分叉。
- 不重复移植 `master`、`feat/terminal-fluency-p0`、`wip/blank-workspace-fix-20260529-104829` 已经包含在当前分支的功能。
- 不把 backup 分支当作更完整基线，只把它作为历史修复来源。

## 待办

### BFI-00 评审吸收范围

- 状态：`TODO`
- 依赖：无
- 内容：确认是否按 BFI-01 至 BFI-03 优先实施，是否继续评估 BFI-04 至 BFI-07。
- 产出：确定移植范围和优先级。

### BFI-01 吸收编辑器代码跳转

- 状态：`TODO`
- 依赖：BFI-00
- 来源：`feature/code-navigation`，`75a46ad`、`937c365`、`0c0769b`。
- 内容：评估 `code-navigation.ts` 的 TypeScript 解析、打开文件、定义跳转、F12 和前进后退导航；适配当前编辑器状态和远程文件读取流程。
- 验收：TypeScript/JavaScript 文件可跳转到本地声明和可解析的导入目标；不支持的语言安全返回；导航历史、编辑器分组和远程主机不回归；补齐单测。

### BFI-02 修复 Git diff 编辑器持久化边界

- 状态：`TODO`
- 依赖：BFI-00
- 来源：`session-panel-enhancements`，`abe810e`。
- 内容：评估 `git-diff?` 和 `rootId === 'git'` 编辑器在 `partialize`、恢复和 active editor 状态中的过滤策略。
- 验收：刷新页面不会恢复临时 diff 编辑器；普通文件编辑器、compare editor 和现有布局状态保持兼容；补充 store 和 EditorWorkbench 单测。

### BFI-03 稳定 FilePanel 和 SessionPanel 状态更新

- 状态：`TODO`
- 依赖：BFI-00
- 来源：`feature/code-navigation` 的 `75a46ad`，`session-panel-enhancements` 的 `75a46ad`、`abe810e`。
- 内容：评估 FilePanel 跟随编辑器的短时抑制、目录/预览请求失败重试、事件冒泡处理、Tree 重渲染稳定性，以及 `useOrderedSessions` 和批量选择的无效 state 更新。
- 验收：打开文件后不会被 follow effect 立即覆盖；目录和预览失败可重试；相同输入重复渲染不产生无效状态更新；补齐组件和 hook 回归测试。

### BFI-04 对齐终端附着快照恢复

- 状态：`TODO`
- 依赖：BFI-00
- 来源：`terminal-pane-enhancements`，`20fa91b`、`6f19645`、`a8de6ca`。
- 内容：将附着等待输出、visual freeze、`snapshot_refresh` 和 pane resize 后快照恢复与当前 `stream.ts` 协议逐项对比，确定是否保留、改写或跳过。
- 验收：首次 attach、重复 attach、resize、断线重连和多客户端场景无白屏、闪烁或乱序；旧客户端和远程 host 行为不受破坏；协议测试覆盖快照请求和响应。

### BFI-05 核对历史会话排序 hydration 修复

- 状态：`TODO`
- 依赖：BFI-00
- 来源：`backup/remote-master-before-force-20260603`，`4f23a27`。
- 内容：对比当前 `useOrderedSessions` 的本地/远端排序初始化、时间戳仲裁和首次请求时序，确认该修复是否已被当前实现替代。
- 验收：首次加载不会用空的本地顺序覆盖远端顺序；本地和远端冲突按明确时间戳处理；已有排序测试覆盖失败降级。

### BFI-06 核对终端附着和 pane resize 历史修复

- 状态：`TODO`
- 依赖：BFI-04
- 来源：`backup/remote-master-before-force-20260603`，`daadc57`、`f2304d5`、`15bef6a`。
- 内容：比较 soft recovery、保留旧 session 画面、多次 staggered snapshot 和 mouseup 后 resize 的当前等价实现，避免重复实现或引入旧协议。
- 验收：每个候选修复有“当前已覆盖 / 需要移植 / 不适用”的结论和对应测试证据。

### BFI-07 核对输入和远程 pane 错误处理

- 状态：`TODO`
- 依赖：BFI-00
- 来源：`backup/remote-master-before-force-20260603`，`0ab5697`、`0663e4a`、`28479c0`。
- 内容：评估 IME composition、stale pane ID、缺少 active pane 的错误提示，以及粗指针桌面设备的移动端键盘判断。
- 验收：中文输入、剪贴板粘贴、pane 切换和异常 pane 请求有回归测试；仅在当前行为确有缺口时移植。

### BFI-08 统一测试和移植记录

- 状态：`TODO`
- 依赖：BFI-01、BFI-02、BFI-03、BFI-04、BFI-05、BFI-06、BFI-07
- 内容：记录每个候选功能的来源 commit、当前差异、最终决策、测试命令和回滚边界。
- 验收：所有任务均有 `DONE`、`SKIPPED` 或 `BLOCKED` 结论；不留下未说明的 cherry-pick。
