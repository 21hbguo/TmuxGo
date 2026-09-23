# 函数定义跳转与返回/前进：边界复核及修复任务

- 时间：2026-09-23 09:30（Asia/Shanghai）。代码基线：`2f1f413`。
- 接收人：**pane2**。发送前核实当前 pane 身份；不要沿用上一轮 `%655` 等旧地址。
- 本轮只调查、做临时复现测试、出任务书，不修改业务代码，不重启线上服务。
- 用户要求：跳到函数真实定义，不停在 import/文件顶部；返回恢复出发位置；覆盖 Alt+左右方向键及工具栏返回/前进按钮。

## 一、结论与证据等级

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 中转导出导致跳到顶部/import | **已复现，解析器层错误**，并非都属于 Monaco 落位失败 | 真实 `resolveEditorDefinition`，5 个最小 fixture，4 失败、1 对照通过 |
| 返回后被旧定义请求再次带走 | **已复现，导航请求生命周期错误** | 真实组件/Store + 可控异步 resolver，返回 A 后旧请求完成又打开 B |
| 快速切换标签回到旧定位 | **已复现，pending 重放覆盖位置** | 真实组件/Store + 有状态 Monaco 替身，手动 44:5 被旧定位 33:3 覆盖 |
| 按钮/Alt 导航基本栈逻辑全错 | **不成立，至少简单路径正常** | 两个正向组件测试覆盖 F12、Ctrl+点击、定义按钮、Back/Forward、Alt+左右，断言实际替身行列 |
| 返回保持原视口/选区 | **结构上未保存，尚未真实浏览器复现** | NavigationEntry 只存行列，返回统一居中；没有应用级 viewState/selection 快照 |
| Monaco 原生快捷键与自定义处理是否竞争 | **待浏览器验证，不作为已确认根因** | 现有 handler 仅 preventDefault，需实测是否发生二次导航，不能直接猜测 |

**重要边界**：本轮定位了能解释用户现象的确定代码路径，但没有用户具体文件与点击位置，不能断言覆盖其全部场景。CDP 依赖检查提示 Chrome 未连接，因此未在真实浏览器重现该次操作；下面的组件测试不能冒充真实 Monaco E2E。

## 二、已复现 N1：解析器把 import 或文件顶部当成函数定义

位置：`apps/frontend/src/lib/code-navigation.ts`

- `findExportedNode` 约 214–262 行：不跟随 `export { foo } from './impl'` / `export * from './impl'`；本地声明查找允许命中 ImportSpecifier；`export default foo` 直接返回 export 表达式。
- `resolveEditorDefinition` 约 830–865 行：快捷路径找到模块就立即返回 success；`targetNode` 不存在时通过 `targetNode?.getStart(...) || 0` 把未找到定义转成 **1:1 成功**，后面的语义解析没有机会执行。

### 可重复 fixture 与实际输出

入口均为 `entry.ts`，点第 2 行第 2 列的 `foo()`；所有 fixture 在 `/workspace` 根下、已打开且内容可用，排除网络加载及编辑器落位干扰。

实际定义 `impl.ts`：

```ts
// header

export function foo() { return 1 }
```

目标应为 `impl.ts:3:17`（函数名位置，行列均 1-based）。

| 入口 import | 中转文件 | 应到 | 实际到 |
| --- | --- | --- | --- |
| `import { foo } from './impl'` | 无 | impl.ts:3:17 | **impl.ts:3:17，通过** |
| `import { foo } from './barrel'` | `// barrel` + 换行 + `export { foo } from './impl'` | impl.ts:3:17 | **barrel.ts:1:1** |
| 同上 | `// barrel` + 换行 + `export * from './impl'` | impl.ts:3:17 | **barrel.ts:1:1** |
| 同上 | `import { foo } from './impl'` + 换行 + `export { foo }` | impl.ts:3:17 | **barrel.ts:1:10，即 import 中的 foo** |
| `import foo from './default'` | default.ts：`// header` / `function foo() { return 1 }` / `export default foo` | default.ts:2:10 | **default.ts:3:16，即 export 引用而非定义** |

### 最小修复要求

1. 保留直接导出的快速路径，不能以牺牲现有速度为代价一律全项目扫描。
2. 快捷路径只有命中真实声明才返回 success；不能用 1:1 伪装函数定义解析成功。点击模块路径字符串打开文件首行是不同语义，允许保留。
3. 补中转导出、导出别名、import 后再 export、default identifier 到真实声明的解析。可以复用现有语义解析；实施者比较最小补丁，不预设重写架构。
4. 跟随导出链时对文件+符号去重并响应取消，循环导出应终止；找不到定义明确失败，而非偷偷落首行。
5. 不统一硬编码到函数体第一行：测试依据真实声明节点/函数标识符行列确定，目标要能在视口看到。

## 三、已复现 N2：返回后，旧异步跳转覆盖用户的新导航

位置：`EditorWorkbench.tsx` 约 328–403 行。

复现顺序：

1. A:22:4，F12 到 B:60:10，产生可返回历史。
2. 在 B 再按 F12，resolver 暂不完成。
3. 按 Alt+Left，正确返回 A:22:4。
4. 让第 2 步 resolver 完成，返回 B:90:10。
5. **实际又打开 B；预期仍停在 A。**

原因：只在发起下一次定义搜索时 abort 旧 controller；Back/Forward 不使旧搜索失效。搜索期间 `navigationPendingRef` 尚未置 true，因此可以返回；旧结果随后继续 `navigateToEntry`，还会改写历史。

修复要求：

- 用户执行返回/前进后，之前未完成的定义搜索不得再导航或改写历史；同时覆盖工具栏和快捷键，走同一命令逻辑。
- 核查手动切换文件、关闭源文件、组件卸载时的旧结果失效；保留“下一次定义搜索取消前一次”的现有行为。
- 不通过搜索期间禁用返回来规避问题；慢搜索不应锁住用户。
- 补延迟 resolver 的精确顺序测试，既断言最终文件/行列，又断言历史栈未被旧结果污染。

## 四、已复现 N3：旧 pending 与编辑器生命周期混用

位置：`EditorWorkbench.tsx` 约 654–687、1045–1098 行。

复现顺序：

1. location 事件将 A 放到 33:3，落位成功。
2. 用户手动将光标移动到 44:5。
3. 1500ms 内切换到 B 再切回 A，发生 remount。
4. **实际 A 又被设置成 33:3；预期保留用户最新的 44:5。**

原因：落位成功仍保留 pending 1500ms；onMount 无条件尝试重放。它无法区分“同一次导航遇到 loading/StrictMode 重挂”与“用户已经改变位置后普通切换标签”。

修复要求：

- 将一次导航落位与用户后续编辑位置区分，不再依赖固定 1500ms 时间窗判定所有权。
- 保留未加载/实例尚未就绪时的落位能力，不能简单删除 pending 使原先加载竞态回归。
- 保存/恢复必要的编辑位置与视图状态；本地 `@monaco-editor/react` 当前默认销毁模型的卸载分支并不保存 viewState，因此**只清 pending 不能保证 remount 回到 44:5**。
- 只对当前目标实例/模型生效，列号也应按有效模型范围校验；补 loading 延迟、旧实例 dispose、快速 remount 测试。
- “跳到定义”可居中目标；“返回/前进”应恢复历史游标并尽量还原原视口/选区，避免每次都强制把源行拉到屏幕中央。

## 五、尚需验证，勿当已确认根因直接扩改

1. `getNavigationPosition` 约 240 行先取 React 的 `cursorById`，再取 Monaco `getPosition()`；在状态尚未提交的边界可能记录旧位置。建议读取当前存活实例为准、缓存兜底，并补事件顺序测试；本轮未单独复现此项。
2. 历史栈在打开文件成功前 pop/push；`openFileInEditor` 捕获读取错误后仍返回 id。需要覆盖目标读取失败/文件删除/权限错误时历史不能丢失；不为此擅改公共 API 签名。
3. 快捷键目前挂在 window capture，只排除终端；需要验证 Monaco 原生命令、浏览器 Alt+Left、输入框/模态框是否抢占。同一用户动作只能产生一次应用导航。
4. 用户说“前向跳转到函数”指 **Go to Definition**；工具栏 **Forward/Alt+Right** 应是重做历史，而不是重新搜索光标下函数。文案和测试名称分开，避免把两者实现混在一起。

## 六、测试基线与复现产物

### 本轮实际执行

```sh
cd apps/frontend
npx vitest run src/lib/code-navigation.test.ts src/components/EditorWorkbench.test.tsx
```

结果：**2 文件、56 测试全通过**。现有导航测试主要检查目标参数/activeEditorId，Monaco getPosition 固定 1:1，opener mock 不派发真实 location 事件，因此不能证明导航位置正确。

新增临时探针（测试结束自动删 repo 内 probe，不污染正式测试集）：

```sh
python3 /tmp/tmuxgo-navigation-resolver-probe.py
python3 /tmp/tmuxgo-navigation-ui-probe.py
```

| 探针 | 实际结果 | 限制 |
| --- | --- | --- |
| Resolver | 5 执行：1 通过、4 失败，具体见 N1 | 使用真实 resolver，文件内容由已打开文档 fixture 提供 |
| Component | 4 执行：2 通过、2 失败；原文件其他 35 项跳过 | 使用真实组件/Store，有状态 Monaco 替身；resolver、opener 可控，opener 派发 location 事件 |

日志：`/tmp/tmuxgo-navigation-resolver-probe.log`、`/tmp/tmuxgo-navigation-ui-probe.log`、`/tmp/tmuxgo-navigation-baseline.log`。

探针源码备份：`/tmp/navigation-review-probe.test.ts`、`/tmp/navigation-review-probe.test.tsx`。这些是本机临时产物，需实施者把关键用例正式纳入仓库，不能只引用 /tmp 作为长期验收证据。

### 必须新增的正式验收矩阵

| 场景 | 操作 | 必须断言 |
| --- | --- | --- |
| 同文件/跨文件定义 | F12、Ctrl/Meta+点击、定义按钮 | 模型 URI、声明行列、目标在可见区域；不是仅 tab 标题 |
| 中转/别名/default | 直接导出、named/star re-export、别名、多级、循环、缺失符号 | 真正声明位置；不存在时不以 1:1 冒充成功 |
| 返回及重做 | Back、Forward、Alt+Left、Alt+Right 交叉操作 | 源位置、目标位置与栈状态一致；快捷键不触发浏览器离开应用 |
| 多级与分叉 | A→B→C，退两次/进两次；退回后跳 D | 顺序正确；新定义跳转清空旧 forward 分支 |
| 目标内移动 | A→B，B 移到另一行，再 Back/Forward | Back 恢复 A；Forward 恢复离开 B 时位置，不强制回初始定义行 |
| 慢搜索冲突 | resolver 未完成时 Back/Forward/切 tab/关闭源文件 | 旧结果不抢回焦点、不改历史 |
| 加载与 remount | 已打开/未打开/预览被替换/读取延迟/StrictMode | 不落 1:1、不被旧 pending 覆盖；未保存内容不被重载 |
| 视口与选区 | 源行不在屏幕中心，有水平滚动/选区后跳转再回 | 游标、选区及必要的纵横滚动恢复 |
| 输入边界 | Monaco、终端、普通输入框、模态框、IME | 无意外导航、命令不双触发；按照当前界面快捷键约定验收 |
| 失败与连续操作 | 目标读取失败、快速连按、取消 | 无丢历史/无永久 busy；错误有反馈 |

真实浏览器 E2E 必须使用真实 Monaco，不替换成 textarea；以调用行与定义行明显分离的长文件为 fixture，函数名列号不取 1，以免“永远落 1:1”也能通过。读取模型位置可使用测试专用钩子或可靠的编辑器观察方式，不暴露无必要生产调试接口。需要 tmux 时只使用隔离测试服务的 `test` session，不操作用户现有 session。

## 七、建议 pane2 拆包

- **N-A：解析器** — `code-navigation.ts` 及对应单测。先消除顶部/import 假成功，保留直接导出速度。与 N-B 文件无重叠，可并行。
- **N-B：导航生命周期/历史位置** — `EditorWorkbench.tsx` 及组件测试，必要时最小修改 `editor-open.ts`。包含 N2/N3；这两项同文件，交同一 worktree 串行处理，不再拆给多人互相覆盖。
- **N-C：真实交互回归** — 新建独立 editor navigation E2E spec/fixture。覆盖真实位置、Alt 与按钮交叉、加载/历史；可先写红测，最后合并态执行，不 mock resolver 成功来掩盖 N-A。

请 pane2 用 todo 拆任务、确认当前 worker 身份后自行分配独立 worktree；先读日志再修，不必复制现有终端渲染包。回执：`ACK-NAV-BOUNDARY`。验收需 typecheck/eslint、相关单测、真实 E2E；合并业务改动后 build 前端并 `systemctl --user restart tmuxgo-gateway`，再报告可体验状态。本轮文档本身无需重启。
