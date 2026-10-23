# 依赖升级积压分诊（dependabot）

盘点日期：2026-10-24　基线：master `b63a542`　分支：`chore/deps-triage`
口径：6 个 open PR / 22 个唯一包。**本单只分诊，不合 PR、不动 lockfile、不动依赖。**

## 0. 先说三条前提（影响怎么读后面的档位）

1. **CI 结论目前不可用**。master 的 `ci.yml` 从 2026-09-29 起连续 failure（最近 run `37798524365`：`lint-typecheck` / `test (20)` / `e2e` 均 failure，`build` / `smoke` / `ssh-e2e` success）。同一份代码在本机 `tsc -p apps/gateway` 与 `tsc -p apps/frontend` 都是 0 错误，说明红线来自 CI 环境（node/pnpm/浏览器依赖）而非代码。**因此所有 PR 上那排 `lint-typecheck:FAILURE` 都不能归因于依赖升级**，合并判据必须换成本地跑通（或先修 CI）。
2. **Node 20 是这批升级的分水岭**。`engines` 声明支持 `^20.19.0 || ^22.12.0 || >=24.0.0`，CI 矩阵是 `node: [20, 22]`。四个包的新版本已经抬到 node≥22：`vitest@5`（`^22.12 || ^24 || >=26`）、`jsdom@30`（`^22.22.2 || ^24.15 || >=26`）、`@testing-library/jest-dom@7`（`node >=22`）、`@testing-library/react@16` 自身 node≥18 但联动 dom 10。**在保住 Node 20 的前提下这四个不能升**；要不要 drop Node 20 是另一个决策（见 §4 P3）。
3. **`#30` 是一个 group PR 混装 17 个包**，里面同时有「可以直接合」和「明确不能升」。它不能整单合并，也不该逐包等 dependabot 重开——建议关掉，改 dependabot 配置（major 单独成组 / 或人工摘取低风险子集，见 §4）。

## 1. 分档总览

| 档位            | 包数 | 处置                                                            |
| --------------- | ---- | --------------------------------------------------------------- |
| 低风险·可直接合 | 13   | 合（`#21` `#22` `#24` 直接合；`#30` 里 10 个摘出来合成一批）    |
| 中风险·验证后合 | 3    | 独立小分支验证（zod 4 / xterm addon / RTL 16）                  |
| 高风险·缓       | 2    | typescript 7（收益最大，需配套）、tailwindcss 4（视觉回归面广） |
| 明确不该升      | 4    | 关（Node 20 约束，随 Node 20 决策一起重开）                     |

## 2. 逐 PR 清单

### #21　@tanstack/react-query 5.103.1 → 5.103.2　**低**　→ 直接合

patch 版，无 API 变化。触点：全站 `useQuery`/`useMutation`（约 20 个 hook 文件），跑前端全量即覆盖。

### #22　marked 18.0.9 → 18.0.14　**低**　→ 直接合

patch，仅安全/修复。触点：前端 markdown 渲染。注意 lockfile 里另有一份 `marked@14.0.0` 是间接依赖，别被 diff 迷惑。

### #24　actions/upload-artifact 4 → 6　**低**　→ 直接合（建议改 target `v7`）

v6 只有一处变化：运行时换 Node 24，要求 self-hosted runner ≥ 2.327.1（托管 runner 天然满足）。我们用法仅一处：e2e 失败时上传 `test-results/`、`playwright-report/`，`if-no-files-found: ignore`，无 API 变更。
附带发现：该 action 已发到 `v7.0.2`，升 v6 等于马上再升一次，直接锁 `v7` 更省事（v7 说明未逐条核，合前扫一眼 release notes）。

### #19　@xterm/addon-web-links 0.10.0 → 0.12.0　**中**　→ 验证后合

0.x 的 minor 按依赖约定可含破坏性改动。PR 的 lockfile diff 显示 0.12.0 **不再声明 `@xterm/xterm` peer**（0.10 声明 `^5.0.0`），也就是 web-links 与终端实例的耦合方式变了；我们 `@xterm/xterm` 仍是 `^5.4.0`。
触点只有两处：`apps/frontend/src/lib/terminal-core.ts` 动态 import + `new WebLinksAddon(handler)`；测试 mock 在 `TerminalPane.test.tsx`。
验证要点：装后跑 `TerminalPane.test.tsx`，再手点终端里的 URL 确认走 `openUrl` 而非整页跳转、OSC8 链接仍生效。

### #20　zod 3.25.76 → 4.6.5　**中（改动量明确，6 处）**　→ 验证后合

v4 是 major，我们有 3 个包声明 zod（gateway `^3.22`、agent `^3.22`、cli 精确锁 `3.25.76`）。手工盘出的真实触点：

- `z.record(z.unknown())` **5 处**（`routes/hosts.ts` ×2、`routes/agent-notifications.ts`、`routes/agent-events.ts` ×2）——v4 要求键类型，须改 `z.record(z.string(), z.unknown())`；
- `z.string().datetime()` **1 处**（`lib/request-validation.ts` 的 `modifiedAt`）——v4 改走 `z.iso.datetime()`，旧写法弃用；
- `ZodError` 相关 30 处引用、`safeParse` 6 处、`z.infer` 3 处，v4 保留 `.issues`（我们没用到已移除的 `.errors`，那 4 处 `.errors` 是领域对象字段）；
- `errorMap` / `required_error` / `invalid_type_error` 0 处（不用改）。

验证要点：`pnpm test` 全量（校验错误文案会变，`describeZodError` 的断言与前端 toast 文案要一起看），外加 4 个 store schema 的读写回环。

### #30　dev-dependencies group（17 个包）　**混合**　→ 关掉重开，按下表拆

| 包                          | 从 → 到           | 档               | 理由 / 动作                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @testing-library/user-event | 14.6.7 → 14.6.8   | 低               | patch，合                                                                                                                                                                                                                                                                                                                        |
| postcss                     | 8.5.28 → 8.5.30   | 低               | patch，合                                                                                                                                                                                                                                                                                                                        |
| vite                        | 8.3.0 → 8.3.4     | 低               | patch，合                                                                                                                                                                                                                                                                                                                        |
| @vitejs/plugin-react        | 6.1.1 → 6.1.2     | 低               | patch，合                                                                                                                                                                                                                                                                                                                        |
| @playwright/test            | 1.63.0 → 1.64.1   | 低               | minor，e2e 前跑一次，合                                                                                                                                                                                                                                                                                                          |
| eslint                      | 10.11.0 → 10.12.0 | 低               | minor，engines 要 `^20.19                                                                                                                                                                                                                                                                                                        |     | ^22.13 |     | >=24`，CI 用最新 20.x/22.x 满足，合 |
| typescript-eslint           | 8.70.0 → 8.71.2   | 低               | minor，合（但注意它的 TS peer 上限见下方 typescript 行）                                                                                                                                                                                                                                                                         |
| globals                     | 17.12.0 → 17.13.0 | 低               | minor，合                                                                                                                                                                                                                                                                                                                        |
| lint-staged                 | 17.5.1 → 17.6.0   | 低               | minor，合                                                                                                                                                                                                                                                                                                                        |
| prettier                    | 3.9.8 → 3.9.10    | 低               | patch，合                                                                                                                                                                                                                                                                                                                        |
| @testing-library/react      | 14.3.1 → 16.3.3   | 中               | 72 个文件在用；peer 要求显式 `@testing-library/dom ^10`，与 `act` 行为变化一起验证                                                                                                                                                                                                                                               |
| typescript                  | 5.9.3 → 7.0.2     | 高（收益也最大） | 原生编译器（依赖按平台分发的二进制包）。实测见 §3；阻塞点：`typescript-eslint@8.71.2` peer 是 `typescript >=4.8.4 <6.1.0`                                                                                                                                                                                                        |
| tailwindcss                 | 3.4.19 → 4.3.3    | 高               | v4 换 CSS-first 配置：`@tailwind base/components/utilities` → `@import "tailwindcss"`，插件改 `@plugin`，还要新增 `@tailwindcss/postcss`；我们 54 行 `tailwind.config.ts` 里颜色全是 `rgb(var(--x) / <alpha-value>)` 这套 token，v4 的默认值变更（ring 宽 3→1、border 默认 currentColor、`outline-none` 语义）会带来全站视觉回归 |
| @types/node                 | 20.10.0 → 26.6.5  | 不该升           | 类型面比运行时不符：我们最低支持 Node 20，26 的 `@types/node` 会放行 Node 20/22 不存在的 API，把运行时炸点推迟到线上                                                                                                                                                                                                             |
| vitest                      | 4.1.10 → 5.0.5    | 不该升           | engines `^22.12 \|\| ^24 \|\| >=26`，直接砍掉 Node 20 测试矩阵                                                                                                                                                                                                                                                                   |
| jsdom                       | 29.1.1 → 30.1.3   | 不该升           | engines `^22.22.2 \|\| ^24.15 \|\| >=26`，同上                                                                                                                                                                                                                                                                                   |
| @testing-library/jest-dom   | 6.4.8 → 7.0.1     | 不该升           | engines `node >=22`，同上                                                                                                                                                                                                                                                                                                        |

## 3. typescript 7 实测（唯一「升了能解锁能力」的高风险项）

用隔离目录装 `typescript@7.0.2`，不碰仓库依赖，直接对现有 tsconfig 跑：

| 目标            | tsc 5.9.3 | tsc 7.0.2          | 结果                    |
| --------------- | --------- | ------------------ | ----------------------- |
| `apps/gateway`  | 3.18 s    | **0.55 s（5.8×）** | 零报错通过              |
| `apps/frontend` | 1.44 s    | 0.78 s             | 1 处配置 + 3 处类型要改 |

frontend 的两类报错都具体可修：

- `TS5102: Option 'baseUrl' has been removed` —— 删 `baseUrl`，`paths` 已是相对写法，直接可用；
- 2 处 `Uint8Array<ArrayBufferLike>` 不能赋给 `BufferSource`（`hooks/useWebSocket.ts`、`lib/vnc-tuning.ts`），新 lib.dom 收紧了 `ArrayBuffer` 家族，改类型标注或 `as BufferSource` 即可。

阻塞点是 lint 栈而不是编译器：`typescript-eslint@8.71.2` 的 peer 是 `typescript >=4.8.4 <6.1.0`。两条出路——(a) 等 typescript-eslint 放宽；(b) 仓库内双 TS：`tsc`/CI 用 7 做类型检查，eslint 的 parser 用 5.x（pnpm 可并存，但要接受 `lint-staged` 与编辑器插件各用一版）。收益明确：本地类型检查从秒级降到亚秒，CI `lint-typecheck` 这一段能显著瘦身。

## 4. 建议执行顺序

- **P0（今天可做）**：合 `#21`、`#22`；`#24` 改成 target `v7` 再合。三个都是 patch/运行时换版，本地跑 `pnpm test` + 前端全量即可。
- **P1（一批低风险）**：把 `#30` 里 10 个低风险包摘出来合成一个 `chore(deps)` 分支（`patch`/`minor` 为主，lockfile 小步可回滚），关掉 `#30`；同时给 dependabot 加分组规则，major 单独成组、不再混进 dev group。
- **P2（各开独立票）**：zod 4（6 处改动 + 全量测试）、xterm addon 0.12（手点验证）、RTL 16 + `@testing-library/dom@10`（测试栈联动）。
- **P3（要决策）**：① 是否 drop Node 20 —— 决定 `vitest 5` / `jsdom 30` / `jest-dom 7` 能不能升；② typescript 7 —— 先解决 typescript-eslint 的 TS peer 上限（双 TS 或等插件），收益已量化到 5.8×。
- **缓**：tailwindcss 4 单独开分支做，必须带视觉回归（e2e 截图对比 + 逐屏过一遍），不要和别的升级混在一起。

## 5. 未验证 / 需要执行时补的

- `@xterm/addon-web-links@0.12` 去掉 `@xterm/xterm` peer 后的真实耦合方式（是否内联一份 xterm 类型）——只能装上去看；
- `tailwindcss@4.3.3` 的 changelog 未逐条核，档位依据是 v4 的已知迁移面（配置形态 + 默认值/类名变更）；
- `upload-artifact@v7` release notes 未逐条核；
- 所有 PR 的 CI 结论都受 §0-1 的基线红灯污染，合前一律本地复跑。
