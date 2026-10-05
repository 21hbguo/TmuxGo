# TmuxGo Session Policy 计划

- 日期：2026-07-23
- 状态：已实施
- 范围：尊重老用户 tmux 配置，同时照顾无配置新用户的可用性
- 相关代码：
  - `apps/agent/src/tmux.ts`（`enableMouse` / `createSession`）
  - `apps/gateway/src/lib/tmux-policy.ts`（`prepareSessionAttach`）
  - `apps/gateway/src/routes/sessions.ts` / `stream.ts`

---

## 1. 背景与问题

TmuxGo 建立在真实 tmux 之上，而不是替代用户的 `tmux.conf`。

当前矛盾：

1. **老用户**：已有完整 `~/.tmux.conf`（插件、主题、resurrect、自定义 key/index），不希望被 app 破坏。
2. **新用户**：几乎没有 conf 时，鼠标、history、会话存活等体验差，不方便上手。

现有实现已在创建/attach 时设置：

- `destroy-unattached off`
- `mouse on`

但写法是：

```bash
tmux set-option -t <session> -g mouse on
```

其中 `-g` 表示**全局**选项，可能污染整个 tmux server，与「尊重老用户」目标冲突。

---

## 2. 目标与非目标

### 2.1 目标

- 新用户无 conf 时，用 TmuxGo 基本顺手（鼠标、Web 断开不丢 session 等）。
- 老用户已有 conf / 插件 / 主题时：**不改 conf、不全局污染**。
- 策略可解释、可关、可回滚。
- 与现有 `session-templates`、UI preferences 边界清晰。

### 2.2 非目标

- 不内置 / 不安装 TPM、主题、resurrect 等插件链。
- 默认不写 `~/.tmux.conf` 或 `~/.config/tmux/tmux.conf`。
- 不做完整 conf 编辑器。
- 不默认改 `prefix`、`key-table`、status 主题、`default-shell`、窗口/窗格编号基准。

---

## 3. 概念模型

| 名称 | 是什么 | 存放位置 |
|------|--------|----------|
| **Session Policy** | 创建/attach session 时要设置哪些 tmux 选项 | 代码内置白名单 + 用户模式开关 |
| **用户 conf** | 真正的 tmux 配置文件 | 用户 home，TmuxGo 默认只读 |
| **Session Template** | 窗口 / 分屏 / 命令布局 | 已有 `~/.tmuxgo/session-templates.json` |
| **UI Preferences** | 前端主题 / 字体等 | 已有 `~/.tmuxgo/preferences` |

结论：

- Policy **不是**配置文件。
- Policy 是 app 侧的「会话增强策略」。
- 用户 conf 仍由用户自己管理；TmuxGo 最多在后续版本提供「导出片段」（opt-in）。

---

## 4. 选项分层（白名单）

### 4.1 L0 — 功能必需

默认始终对「本次操作的 session」生效。

| 选项 | 建议值 | 作用 |
|------|--------|------|
| `destroy-unattached` | `off` | 避免 Web 断开后 session 被销毁 |
| `mouse` | `on` | Web 终端交互可用 |

失败策略：单条 `set-option` 失败只记日志，不阻断创建 session / attach。

### 4.2 L1 — 舒适默认

仅在 bootstrap / 用户明确开启时生效。

| 选项 | 建议策略 | 默认是否开启 |
|------|----------|--------------|
| `history-limit` | 仅当当前值低于阈值时提高到 `50000` | `auto` 且无用户 conf 时 |
| `set-clipboard` | `on` | 可选；远程差异大，v1 可不做 |
| `renumber-windows` | `on` | 可选；v1 可不做 |

### 4.3 L2 — 明确禁止默认修改

- `prefix` / `prefix2`
- `status-*` 主题与内容
- `@plugin` 及任何插件变量
- `default-shell` / `default-command`
- `base-index` / `pane-base-index`
- `key-table`
- continuum / resurrect 相关路径与开关

原则：会影响老用户肌肉记忆、编号习惯、主题外观的，一律不默认动。

---

## 5. 用户模式

| 模式 | 行为 |
|------|------|
| **`auto`（推荐默认）** | 检测到用户 conf → 只做 L0；无用户 conf → L0 + L1 |
| **`required-only`** | 永远只做 L0 |
| **`bootstrap`** | 永远 L0 + L1 |

可选体验：

- `auto` 首次进入 bootstrap 时轻提示一次：「已启用会话级基础增强」。
- 用户可一键改为 `required-only`。

v1 UI 可极简：设置页一个三选一即可。  
「导出 conf 片段」放到后续版本。

---

## 6. 作用域规则（关键）

### 6.1 目标行为

```bash
# session 级，禁止 -g
tmux set-option -t <session> mouse on
tmux set-option -t <session> destroy-unattached off
```

### 6.2 约束

| 项 | 策略 |
|----|------|
| 作用对象 | 仅当前 session |
| 是否写 conf | 否 |
| 是否改全局 server 选项 | 否（移除 `-g`） |
| 非 TmuxGo 创建的 session | attach 时只对该 session 做 policy，不扫描全 server |

### 6.3 现状修复点

- `apps/agent/src/tmux.ts` 的 `enableMouse`
- `apps/gateway/src/lib/tmux-policy.ts` 的 `prepareSessionAttach`

两处都应统一为 session 级语义。

---

## 7. `auto` 检测规则

### 7.1 判定「有用户 conf」

任一存在即视为老用户环境（建议 v1 只看用户 conf，不解析内容）：

- `~/.tmux.conf`
- `$XDG_CONFIG_HOME/tmux/tmux.conf` 或 `~/.config/tmux/tmux.conf`

`/etc/tmux.conf`：

- v1 **不作为**「老用户」判定依据（很多机器只有空系统包）。
- 仅用户 conf 存在时走 `required-only` 语义下的 L0。

### 7.2 检测位置

- **local**：在 gateway 所在机器检测 `$HOME`。
- **remote**：在目标 host 的 agent 侧检测该 host 的 `$HOME`，**不能**用本机 conf 推断远程。

### 7.3 缓存

- 按 host 进程内缓存检测结果即可。
- conf 变更后：重启 gateway/agent，或后续提供手动刷新。

---

## 8. 应用时机

| 时机 | 现有入口 | 动作 |
|------|----------|------|
| 创建 session | agent `createSession`；gateway `POST /hosts/:hostId/sessions` | `applySessionPolicy` |
| attach / 打开流 | gateway `prepareSessionAttach`（local） | 同上 |
| 已有 session 重入 | create 发现已存在；stream attach | 同上 |
| rename 后 | sessions rename 路径 | 对新 session 名再 apply 一次（保持幂等） |

统一入口建议：

```text
applySessionPolicy(sessionName, { mode, hasUserConfig })
```

替换：

- `enableMouse(...)`
- `prepareSessionAttach(...)` 内硬编码 set-option

### 8.1 Local vs Remote

| Host | v1 计划 |
|------|---------|
| local | 完整 policy |
| remote + agent | 与 local 同语义（agent 内同一套规则） |
| remote 无对应能力 | 跳过并记日志，不假装已增强 |

现状：`safePrepareSessionAttach` 仅 local 调用。Phase 1 应让 remote create/attach 路径也能走 agent 侧 policy。

---

## 9. 存储与 API

### 9.1 存储字段

```ts
tmuxSessionPolicyMode: 'auto' | 'required-only' | 'bootstrap'
```

- 默认：`auto`
- 存放：与现有 preferences 一致（如 `~/.tmuxgo/preferences`）
- **不**持久化具体 option 明细（明细内置代码，避免用户改出不安全组合）

### 9.2 API

v1：

- 复用现有 preferences 读写即可。
- 可用环境变量过渡：`TMUXGO_SESSION_POLICY=auto|required-only|bootstrap`

可选（非必须）：

```http
GET /api/hosts/:hostId/tmux-env
```

返回示例：

```json
{
  "hasUserConfig": true,
  "mode": "auto",
  "appliedTier": "L0",
  "applied": ["mouse=on", "destroy-unattached=off"]
}
```

### 9.3 前端

- 设置页：「Tmux 会话增强」三选一 + 一行说明。
- v1 不做 conf 编辑器、不做大预览。
- v2 可增加「导出 conf 片段」。

---

## 10. 与其它能力的边界

| 能力 | 归属 | 本次 |
|------|------|------|
| mouse / destroy-unattached | Session Policy L0 | 做 |
| history 等舒适项 | Session Policy L1 | 可选 |
| 窗口布局 | Session Template | 已有，不动 |
| 主题 / 字体 / 语言 | UI Preferences | 已有，不动 |
| 用户 conf 安装 / 合并 | 导出工具 | v2 可选 |

---

## 11. 分阶段落地

### Phase 0 — 止血（优先，改动最小）

- 去掉 `mouse` 的 `-g`，改为 session 级。
- 保留 `destroy-unattached off`（session 级）。
- 统一 gateway + agent 两处行为。
- **不改用户 conf，不引入模式 UI。**

验收：

- 打开 TmuxGo 不再把 mouse 设成全局。
- 老用户全局主题 / prefix / index 不被改。

### Phase 1 — Policy 骨架

- 实现 `applySessionPolicy(session, mode)`。
- 内置 L0；`mode` 可先读 env，或默认 `auto` 但 L1 仍关闭。
- local + agent 侧用户 conf 检测。
- 单测：
  - 有 / 无 conf
  - session 级 set（命令参数不含 `-g`）
  - 单条失败不抛死

### Phase 2 — 产品化

- preferences 字段 + 设置页三选一。
- `auto` 启用 L1（如 history-limit 条件提升）。
- 可选：首次 bootstrap 轻提示。

### Phase 3 — 可选增值

- 「导出 conf 片段」（用户手动粘贴，永不静默写盘）。
- 诊断 API。
- 设置页展示远程 host 检测结果。

**推荐顺序：先做 Phase 0，再视需求推进 1/2。**  
很多场景下 Phase 0 已能显著降低对老用户的破坏风险。

---

## 12. 风险与应对

| 风险 | 应对 |
|------|------|
| session 级 `mouse` 在部分 tmux 版本与 `-g` 行为不同 | 以本机 tmux 3.x 验证；失败仅 log |
| 每次 attach 都 set 是否烦人 | 幂等 set；用户无感 |
| 远程 conf 检测路径 / HOME 不一致 | agent 侧明确 HOME；失败视为未知 → 仅 L0 |
| 与用户 conf 中 `mouse off` 冲突 | 开 TmuxGo 时 L0 强制是产品选择；提供 `required-only`，后续可加细开关 |
| gateway / agent 逻辑分叉 | 强制同表、同顺序、同作用域 |
| 过度产品化配置系统 | 只做一个 mode 旋钮，不暴露 option 编辑器 |

---

## 13. 验收标准

1. 有完整 `~/.tmux.conf` 的用户：全局 options / 主题 / prefix / index **不变**；仅被 TmuxGo 打开的 session 上 L0 生效。
2. 无 conf 用户：新建 session 可鼠标操作；Web 断开不因 `destroy-unattached` 丢 session。
3. 默认不产生、不修改任何 conf 文件。
4. 模式切换后，后续 apply 行为符合模式；不要求「撤销已写入的 session 选项」（新 session 不再强化即可）。
5. 测试覆盖 policy 分层，并断言不再出现对 mouse 的全局 `-g` 设置。

---

## 14. 推荐决策（拍板表）

| 项 | 建议 |
|----|------|
| 是否内置完整 conf | **否** |
| 是否引入 Session Policy | **是，但很薄** |
| 默认模式 | `auto` |
| 默认作用域 | **仅 session，禁止 -g** |
| 默认写 conf | **永不** |
| 第一刀 | **Phase 0 去掉 -g** |
| UI | Phase 2；Phase 1 可用 env |
| L1 内容 | 谨慎；v1 可只做 history 条件提升或先不做 |

---

## 15. 一句话总结

不维护配置文件，只维护「会话增强策略」：默认不写盘、不碰全局；老用户几乎只感到 L0 功能补丁；新用户在无 conf 时用 session 级 L1 补体验；设置里一个模式旋钮收口。

---

## 16. 建议的下一步

1. 评审并确认拍板表（第 14 节）。
2. 实施 Phase 0（gateway + agent 去 `-g`，统一 session 级）。
3. 补最小测试后，再决定是否进入 Phase 1。
