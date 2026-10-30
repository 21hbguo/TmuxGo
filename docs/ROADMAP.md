# TmuxGo Roadmap — 核心与外围的边界

一句话定位：**浏览器里的 tmux 工作区 + agent 可观测**。
所有功能用这个闸过一遍：它是不是让「在任何设备上接管/驱动 tmux」更强？

## 核心层（持续投入，护城河）

这些是别人抄不走、也是本项目的存在理由：

- **终端保真**：xterm 渲染、snapshot/diff 传输、滚动/选区/宽字符/IME 边界行为
- **会话拓扑**：session/window/pane 管理、attach 持久化、断线重连续传（session continuity）
- **multi-host**：SSH 远端 host、sshconfig 导入、agent 桥接、凭据不出本机
- **agent 可观测 + 可指挥**：pane 内 AI agent 状态聚合、inbox/通知、任务视角；控制面（机队读面 + 任务号 + 等待），
  让 agent 也能寻址整支机队（见 `docs/design/fleet-orchestration.md`）
- **PWA/移动端**：安装体验、触控手势、横滚、移动键盘适配
- **协议与运维**：WS 多客户端仲裁、gateway 稳定性、可观测性（metrics/diagnostics）

## 服务层（做到「够用」就停）

存在合理性 = 服务终端工作流：终端里看到日志 → 点开文件 → 回终端继续。

- **files / editor**：浏览、编辑、保存、Monaco 基本体验、编辑器内跳转（够用深度的 code navigation）
- **preview**：markdown/HTML 预览、跟随滚动（够用即可）
- **git panel**：status/diff/commit/常用操作，面向「顺手看一眼」
- **settings/preferences/i18n**：跟随核心功能，不为外围功能膨胀配置面

服务层的深度红线：

- editor 不做 IDE：不接全量 LSP、不做 debug、不做项目管理面板、不做扩展宿主
  （2026-10 例外已定界：只补「编辑人体工学」——命令/键位、状态栏、面包屑、大纲、标签管理、视图开关，
  全部基于 Monaco 内置 API，零新增依赖；见 `docs/design/editor-vscode-ux.md`）
- git panel 不长成 Git GUI：交互式 rebase、stage hunk、merge 工具 → 回终端做
- preview 不做浏览器：外链跳转回真浏览器，不内嵌导航

## 越界信号（出现就该砍需求）

- 功能讨论里出现「像 VSCode / JetBrains 那样…」，且需求指向语义/调试/插件生态——那是 code-server 的地盘
  （仅指编辑行为与键位则属于已定界的编辑人体工学范围）
- 外围功能的代码量增速超过核心层
- 新需求无法在两句话内说清「它怎么服务 tmux 工作流」

## 当前方向性 backlog

- [x] **P0 机队读面 + 任务号**（2026-10）：`fleet.list` / `panes.task` 控制面方法、MCP 工具、CLI、契约与测试
- [ ] **P1 集合等待**：`agent.wait` 支持多目标/按任务收口（fan-out 的唯一正确收口方式）
- [ ] **P1 结果信封**：`push result` = `{status, summary, artifacts[], verdict?}`，人侧可批量裁决
- [ ] **P1 清场**：`panes.kill`（显式 confirm）+ `sessions.create`
- [ ] **P2 任务实体化**：任务生命周期/验收态/产物关联（等 C/D 落地后再做，避免先造一张会过期的表）
- [ ] gateway/frontend 全仓 `any` 清零后 `no-explicit-any` 升 `error`，测试文件纳入
- [ ] agent 状态聚合的协议化（非轮询拼装）
- [ ] session continuity 的服务端 resume 体验打磨
- [ ] mobile 触控细节继续收集真实痛点（沿用横滚/捏合的方向）
- [x] window tab 关闭确认弹窗（2026-10，防误关）
- [x] API 边界类型化（`api.ts`/`useApi.ts`，2026-10）
