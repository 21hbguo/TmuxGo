# 自定义快捷键导入/导出规范（tmuxgo.shortcuts v1）

快捷键栏（dock）里的自定义快捷键现在可整包导出/导入。文件只有一个事实源：
`apps/frontend/src/lib/shortcut-bundle.ts`（格式、校验、去重）+
`apps/frontend/src/lib/shortcut-keys.ts`（按键记法与终端编码）。
录制、执行宏、导入导出共用同一套规则，改口径只改这两个文件。

## 1. 文件格式

```json
{
  "kind": "tmuxgo.shortcuts",
  "version": 1,
  "exportedAt": "2026-10-31T02:00:00.000Z",
  "shortcuts": [
    {
      "label": "均匀布局",
      "repeat": false,
      "steps": [
        { "type": "keys", "keys": "Ctrl+B" },
        { "type": "wait", "ms": 50 },
        { "type": "keys", "keys": "Alt+5" }
      ]
    }
  ]
}
```

| 字段                 | 必填           | 约束                                                              |
| -------------------- | -------------- | ----------------------------------------------------------------- |
| `kind`               | 否（缺省接受） | 出现时必须等于 `tmuxgo.shortcuts`                                 |
| `version`            | 否（缺省接受） | 出现时必须为 `1`                                                  |
| `exportedAt`         | 否             | ISO 时间戳，仅用于人看                                            |
| `shortcuts[].label`  | 是             | 去空白后 1–64 字符，同一 label 可配不同步骤                       |
| `shortcuts[].repeat` | 否             | 布尔，缺省 `false`（长按持续触发）                                |
| `shortcuts[].steps`  | 是             | 1–32 步，按顺序执行                                               |
| `steps[].type=keys`  | —              | `keys` 为按键规范串，且必须能编码成终端字节                       |
| `steps[].type=text`  | —              | `text` 去空白后非空、≤4096 字符；`appendEnter` 布尔，缺省 `false` |
| `steps[].type=wait`  | —              | `ms` 为 1–60000 的整数毫秒                                        |

导入也接受裸数组 `[{ "label": …, "steps": […] }]`（手抄清单）。导出永远写完整头部。

## 2. 按键记法

- 修饰符固定四个名字，**顺序固定** `Ctrl` → `Alt` → `Shift` → `Meta`；
  输入侧大小写不敏感，别名 `control/ctl`、`option/opt`、`cmd/command/super/win` 会被归一。
- 主键名（规范写法）：`Esc` `Enter` `Tab` `Space` `Backspace` `Delete` `Insert`
  `Home` `End` `PageUp` `PageDown` `Up` `Down` `Left` `Right` `F1`–`F12`；
  单字符键原样写，加号写作 `Plus`（因为 `+` 是分隔符）。
- 字母大小写归一：`Ctrl+字母` 记大写（`Ctrl+B`）；`Alt/Meta+字母` 记小写（`Alt+k`，
  终端里是 `ESC k`）；裸字母保留原样——`a` 与 `A` 是两个不同字节。
- 编码规则（`keysToEscape`）：

| 记法                    | 终端字节        | 说明                                                                      |
| ----------------------- | --------------- | ------------------------------------------------------------------------- |
| `Ctrl+A`–`Ctrl+Z`       | `0x01`–`0x1A`   | 传统控制字符                                                              |
| `Ctrl+Space`            | `0x00`          | NUL                                                                       |
| `Alt+X` / `Meta+X`      | `ESC` + X       | xterm 惯例；tmux 侧即 `M-x`（如 `Alt+5` = `M-5` = `select-layout tiled`） |
| `Shift+Tab`             | `ESC [ Z`       | 反序 Tab                                                                  |
| `Shift+方向/Home/End/…` | `ESC [ 1;2X` 等 | CSI 修饰位变体                                                            |
| `Ctrl+数字` 等          | 无              | 没有标准编码，导入/录制会被拒绝                                           |

## 3. 导入语义

- **合并**（默认）：以「label 去空白 + 规范化后的步骤序列」作为身份去重，已存在的跳过，
  其余追加；导入后仍可在编辑弹窗里改。
- **覆盖**：清空现有自定义快捷键，整体替换为导入内容；不影响内置按键与布局。
- 单条不合格只跳过该条并列出原因（第几条、哪种问题），整包 JSON 合法就仍然导入有效条目；
  `kind`/`version` 不对或 JSON 解析失败才整体拒绝。
- 导入落盘走 `useCustomShortcuts().importShortcuts()`：一次写 localStorage 并发一次偏好同步，
  不逐条触发。

## 4. 版本演进

- 新增可选字段不算破坏性变更；删除/改义字段或改步骤语义时 `version` 加一，
  导入端对未知版本直接报错（不猜）。
- 导出会丢掉运行期 `id` 和 legacy 字段（`mode`/`keys`/`text`/`appendEnter` 已展开进 `steps`），
  导入端按新结构重建 id。

## 5. 验收

- `apps/frontend/src/lib/shortcut-bundle.test.ts`：归一化、导出/回读、裸数组、坏条目、去重身份
- `apps/frontend/src/components/ShortcutBundleDialog.test.tsx`：导出 JSON、粘贴导入、问题列表
- `apps/frontend/src/hooks/useCustomShortcuts.sync.test.tsx`：合并去重、覆盖
- 手动：快捷键栏管理面板 →「导入/导出」→ 导出一份改两台设备导入，确认重复条目被跳过
