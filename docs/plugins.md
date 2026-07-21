# TmuxGo 插件开发

插件目录必须包含 `tmuxgo-plugin.json`。本地开发在“设置 -> 插件”中输入绝对路径并链接，修改 manifest 后重新启用插件即可重新读取。

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "example.tools",
  "name": "Example Tools",
  "version": "0.1.0",
  "minTmuxGoVersion": "0.1.0",
  "platforms": ["linux", "macos", "windows"],
  "contributes": {
    "actions": [{ "id": "run", "title": "Run", "command": ["node", "action.mjs"] }],
    "events": [{ "on": "session.created", "command": ["node", "event.mjs"] }],
    "views": [{ "id": "main", "title": "Tools", "entry": "ui/index.html", "placement": "activity" }]
  }
}
```

Action 和 Event 以插件目录为工作目录运行。宿主注入 `TMUXGO_PLUGIN_ID`、`TMUXGO_PLUGIN_ROOT`、`TMUXGO_PLUGIN_DATA_DIR`、`TMUXGO_PLUGIN_CONFIG_DIR`、`TMUXGO_PLUGIN_STATE_DIR`、`TMUXGO_CONTEXT_JSON`、`TMUXGO_API_URL`、`TMUXGO_HOST_ID`、`TMUXGO_SESSION_ID` 和 `TMUXGO_PANE_ID`。

当前事件包括 `session.created`、`session.renamed`、`session.deleted`、`file.saved`、`file.uploaded` 和 `git.commit.completed`。

## View Bridge

View 在不具备同源权限的 sandbox iframe 中运行。HTML 引入宿主脚本：

```html
<script src="/api/plugins/runtime.js"></script>
```

可用接口：

```js
await tmuxgo.context.get()
await tmuxgo.storage.get('key')
await tmuxgo.storage.set('key', value)
await tmuxgo.storage.delete('key')
await tmuxgo.storage.list()
await tmuxgo.actions.invoke('action-id', { extra: 'context' })
await tmuxgo.ui.notify('message', 'info')
```

View 的 CSP 禁止直接联网。需要访问网络、文件或 tmux 时，通过声明的 Action 执行。完整示例位于 `examples/plugins/hello-tmuxgo`。
