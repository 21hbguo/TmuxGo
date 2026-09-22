# TmuxGo 优化建议

- 评审时间：2026-09-23 01:03:03（Asia/Shanghai）
- 代码基线：`d4a1168`，评审开始时工作区干净。
- 范围：本地源码、测试入口、CI、前端构建与终端流相关实现。
- 本次仅新增建议文档，不修改业务代码、配置或生产构建产物，不重启运行实例。

## 一、结论与优先级

优先补齐测试安全性与有效覆盖，再优化首屏和轮询；不建议现在重写终端协议、迁移状态管理或按文件大小拆模块。

| 优先级 | 建议                                            | 证据状态               | 收益                             | 改动规模 |
| ------ | ----------------------------------------------- | ---------------------- | -------------------------------- | -------- |
| P1     | 隔离真实 tmux 测试环境，统一使用 `test` session | 源码确认               | 避免测试进入用户日常 tmux server | 小至中   |
| P1     | 将 Gateway 测试接入默认验证链路                 | 源码确认               | 补齐 50 个测试文件的入口覆盖     | 小       |
| P1     | 修复流畅度校验脚本失效检查                      | 命令复现失败           | 恢复可信的验证结果               | 小       |
| P2     | 按功能入口延迟加载非终端面板                    | 已测包体，体验收益待测 | 降低首屏下载与解析负担           | 中       |
| P2     | 防止系统信息轮询重叠，暂停隐藏页面轮询          | 源码确认，竞态待复现   | 降低重复请求与旧响应覆盖风险     | 小       |
| P2     | 补齐 Gateway 优雅退出路径                       | 源码确认，运行影响待测 | 提高重启清理与连接恢复确定性     | 小至中   |
| P2     | 建立增量质量门禁与关键 PR 冒烟测试              | 配置与告警实测         | 提前发现交互回归，控制新增技术债 | 小至中   |
| P3     | 去除 React alias 对 pnpm 内部目录版本的绑定     | 源码确认，当前构建通过 | 降低依赖升级时的配置耦合         | 小       |

P1 表示建议优先处理，不表示已发生生产故障；P2、P3 分别为后续优化和低风险维护项。

## 二、本次验证结果

| 检查                                                        | 结果                      | 说明                                                                          |
| ----------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`                                         | 通过                      | 前端、Gateway、Agent 类型检查均通过                                           |
| `./node_modules/.bin/eslint . --format json`                | 0 错误、307 告警          | 扫描 463 个文件，未执行自动修复                                               |
| `npm run test:frontend`                                     | 79 个文件、719 个测试通过 | 本次耗时 66.59 秒                                                             |
| 前端主配置 `vite build --outDir <临时目录>`                 | 通过                      | 产物写入 `/tmp`，未覆盖生产 `dist`；不代表完整工作区及独立 noVNC 构建均已验证 |
| `./node_modules/.bin/tsx scripts/verify-fluency-metrics.ts` | 失败                      | 3 个检查仍指向旧的实现位置，详见建议 3                                        |
| 根目录测试、Gateway 测试、E2E                               | 未执行                    | 部分用例会创建真实 tmux session；本次未操作任何 tmux session                  |

构建结果（Vite 输出的 kB，gzip 仅为构建估算，不代表实际 HTTP 传输已启用压缩）：

| 产物                |      压缩前 |      gzip |
| ------------------- | ----------: | --------: |
| 主入口 `index-*.js` | 1,217.45 kB | 346.84 kB |
| `typescript-*.js`   | 3,454.99 kB | 970.85 kB |
| `xterm-*.js`        |   287.25 kB |  67.83 kB |
| `rfb-*.js`          |   187.69 kB |  56.58 kB |

`typescript`、`xterm`、`rfb` 已是动态入口，不能把它们全部算作首屏同步下载量。本次没有浏览器性能录制，不能据包体直接断言实际卡顿程度。

## 三、具体建议

### 1. P1：先隔离 tmux 测试，再扩大测试执行范围

**依据**

- `scripts/run-tests.ts:37–48` 隔离了配置、偏好和临时文件目录，但没有为 tmux 设置独立 socket 环境。
- `tests/windows-routes.test.ts:11–15`、`tests/session-archives.test.ts:14–19` 使用动态名称创建 session，并直接调用 `tmux`，未显式指定独立 socket。
- `scripts/run-e2e.ts` 已通过临时 `TMUX_TMPDIR` 隔离 server，可以复用这种做法；但其启动 session 为 `tmuxgo-e2e`，部分 E2E 也会创建其他名称，与项目要求的 `test` session 约束不一致。

**最小方案**

1. 在现有测试启动脚本中增加 tmux 环境隔离，确保直接命令和应用启动的子进程使用同一个专用 server。
2. 将真实 tmux 行为测试收敛到名为 `test` 的 session，通过 window/pane 区分场景；对共享 session 的用例串行执行。
3. 清理时仅关闭测试专用 server，禁止在默认 socket 上执行 `kill-server`；不改用户已有 session。
4. 保留已有配置目录隔离，不引入新的测试封装层。

**验收**：运行前后用户日常 server 的 session 列表不变；正常完成、失败和中断均能清理测试资源；整个行为测试只操作专用 server 中的 `test` session。

### 2. P1：让默认测试入口真正执行 Gateway 测试

**依据**

- `scripts/run-tests.ts:31` 只递归收集根目录 `tests/`，其中目前有 23 个 `.test.ts` 文件。
- `apps/gateway/src/` 另有 50 个 `.test.ts` 文件，包含鉴权、分享链接、Agent、终端流等测试。
- `apps/gateway/package.json` 已提供独立 `test` 命令，但 `.github/workflows/ci.yml:43–44` 只运行根目录测试与前端测试，根目录 `verify` 也没有调用 Gateway 的独立测试命令。

**最小方案**

在完成建议 1 后，优先扩展现有 `collectTests` 调用范围，纳入 `apps/gateway/src`，保留原有 `npm test` 命令与隔离环境；不迁移测试文件、不更换测试框架。检查各测试对 `test-env.ts` 的依赖，避免模块初始化发生在隔离变量设置之前。

**验收**：测试入口收集到当前两处共 73 个文件；日志能够证明 Gateway 中的鉴权、分享、流传输测试实际运行；失败能阻断 CI。文件数仅是本次基线，不作为长期硬编码断言。

### 3. P1：修复流畅度校验脚本的错误定位

**依据**

`scripts/verify-fluency-metrics.ts:15` 仍在 `routes/stream.ts` 内查找已迁移的实现，实测报错：

```text
missing-snippet:apps/gateway/src/routes/stream.ts:syncOutputProfile
missing-snippet:apps/gateway/src/routes/stream.ts:bufferedAmount
missing-snippet:apps/gateway/src/routes/stream.ts:SOCKET_BUFFER_HIGH_WATERMARK
```

对应逻辑实际位于 `lib/stream/stream-session.ts`，水位常量定义位于 `lib/stream/stream-config.ts:7`。这是检查定位失效，不能解读成背压功能缺失。

**最小方案**

先更新检查目标，让现有命令恢复可用；随后在已有终端流测试中补足高水位延迟发送、恢复后继续 flush 的行为断言。字符串存在性检查保留为轻量结构检查，不替代行为测试。

**验收**：`npm run verify:fluency` 通过；破坏背压分支时，相应行为测试确实失败。已有 `e2e/fluency.spec.ts:93–106` 的帧间隔、长任务与指标断言应保留，不能仅放宽阈值消除失败。

### 4. P2：优先缩小主入口，而不是盲目拆分所有大包

**依据**

- 主入口构建体积为 1,217.45 kB，gzip 346.84 kB。
- `apps/frontend/src/components/ConsoleLayout.tsx` 静态导入 `Settings`、`FilePanel`、`GitPanel`、`DesktopView` 等功能面板。
- Monaco 编辑器和 TypeScript 已有动态加载：`EditorWorkbench.tsx:32–33`、`lib/code-navigation.ts:46`，无需重复实现。

**最小方案**

从默认关闭、无需承担全局副作用的面板开始，一次只改一个功能入口，沿用项目现有动态加载方式。检查移动端等其他静态引用链，避免只改一个 import 却仍被主入口引入。加载占位限制在面板内部，不能覆盖或卸载终端；不要为减小文件体积重构整个 `ConsoleLayout`。

**验收**：比较相同环境下入口及其静态依赖总量、首次终端可交互时间、面板首次打开耗时；确认未打开面板时相关代码不被提前请求。建议先以主入口 gzip 较本次基线降低 20% 为试验目标，收益以实测为准，不通过提高 chunk 告警阈值掩盖问题。

### 5. P2：避免系统信息请求重叠和同主机响应乱序

**依据**

- `apps/frontend/src/hooks/useSystemInfo.ts:67–74` 使用异步 `poll` 加固定 `setInterval`，没有请求进行中标记。
- 当请求超过轮询周期，同一 effect 内会产生并发；现有 `active` 标记能隔离切换主机或卸载后的响应，但不能区分同一主机的先后请求。
- `StatusBar.tsx:75` 固定每 2 秒调用该 hook；`SystemHealthPanel` 已传入页面可见性开关，而状态栏没有传入。

**最小方案**

在现有 effect 内增加局部请求进行中标记，上一轮未结束则跳过；不改变 hook 签名和默认周期。参照现有健康面板处理状态栏的隐藏页面轮询，恢复可见时刷新。暂不引入全局轮询管理器。

**验收**：用延迟超过 2 秒的模拟响应验证同一 hook 最多一个请求在途；切换主机、禁用和卸载后不写入旧结果；隐藏后请求停止、恢复后刷新。当前测试覆盖切主机和 enabled 开关，应在其基础上追加用例。

### 6. P2：让 Gateway 重启经过完整清理路径

**依据**

- `apps/gateway/src/index.ts:220–227` 的信号处理执行监控、插件和复用 socket 清理后直接 `process.exit(0)`，没有调用 `fastify.close()`。
- `apps/gateway/src/routes/stream.ts:237–240` 将 `session.cleanup()` 绑定在 WebSocket 的 `close` 事件上。

**风险边界**

源码可确认应用没有显式走 Fastify 的关闭流程，但本次未验证是否存在残留 PTY、日志丢失或重连异常，不能将这些推断当作已复现故障。

**最小方案**

在已有 `shutdown` 内加入重复调用保护，明确停止接入、关闭 WebSocket、清理应用资源的顺序，并等待服务器关闭；设置有界退出时间，避免活跃连接无限阻塞。先验证现有 WebSocket 插件关闭行为，不新增通用生命周期框架，也不终止用户 tmux session。

**验收**：在隔离的 `test` session 下测试活跃流连接期间发送 SIGTERM、连续信号和重新启动；进程按时退出、端口释放、浏览器可恢复连接，tmux 会话本身保留。

### 7. P2：以增量门禁替代一次性清理存量告警

**依据**

- 本次 ESLint：307 条告警，其中 `no-empty` 169 条、未使用变量 73 条、Hook 依赖 23 条、控制字符正则 18 条。
- `.github/workflows/ci.yml:25` 使用 `eslint . --quiet`；当前 CI 没有 Prettier 检查，E2E 仅在 `workflow_dispatch` 时运行。
- 已有 lint-staged 负责暂存代码修复，但不能替代 CI 对最终提交内容的校验。

**最小方案**

1. 对 PR 变更文件增加只检查、不重写的 Prettier 校验；不要全仓格式化。
2. 分批审查 Hook 依赖与异常吞掉的告警，先处理真实状态过期和错误不可见问题；不机械补依赖数组，不删除协议正则或已有 workaround 注释。
3. 在 CI 输出告警统计并控制新增数量，暂不要求全仓 `--max-warnings 0`。
4. 完成测试隔离后，将小规模登录、终端附着、基本输入冒烟纳入 PR；保留较重的流畅度、多客户端等测试供手动或定时运行。

**验收**：PR 新增格式错误或关键交互回归能够失败；告警基线不增加；保留有意忽略的清理错误，并以局部意图说明区分合理例外。

### 8. P3：减少 React 解析配置与锁文件内部结构的耦合

**依据**

`apps/frontend/vite.config.ts:48–54` 已设置 `dedupe`，同时将 React 和 React DOM alias 写死到 `.pnpm/react@18.3.1/...` 等内部路径。当前构建通过，这不是已确认的解析故障，但升级依赖或改变安装布局时需要额外同步配置。

**最小方案**

先查清显式 alias 是否仍用于解决重复 React；若 dedupe 与正常依赖解析已足够，则移除多余 alias。若必须保留，使用包解析结果，而非拼接版本目录。单独提交此调整，不顺带升级 React、Vite 或包管理器。

**验收**：正常干净安装后构建、前端测试和真实页面均通过；确认只使用一个 React 实例，没有 Hook 调用错误，同时不再依赖版本字符串目录。

## 四、建议实施顺序

1. **测试闭环**：tmux 隔离 → Gateway 测试纳入默认入口 → 修复流畅度校验。
2. **低侵入优化**：轮询并发控制 → 单个非核心面板延迟加载，分别测量收益。
3. **重启与质量保障**：退出流程验证 → 增量格式/告警门禁 → PR 冒烟测试。
4. **独立维护**：确认 React alias 必要性后再调整。

每批只修改直接相关代码，保留 API、配置字段、命令和协议兼容性。实际代码落地后执行相关测试及 eslint、Prettier、typecheck；涉及前端则重新构建，按项目要求重启 `tmuxgo-gateway`。本次为纯文档评审，不触发构建部署或实例重启。
