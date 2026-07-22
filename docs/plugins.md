# TmuxGo 插件开发

插件目录必须包含 `tmuxgo-plugin.json`。本地开发在“设置 -> 插件”中输入绝对路径并链接，修改 manifest 后重新启用插件即可重新读取。

插件的 Build、Action 和 Event 是可信本地代码，以运行 TmuxGo 的系统用户身份执行并继承当前环境。安装 GitHub 插件前，预览页会展示固定 commit 以及所有可执行命令；只安装可信来源。View 与这些命令的信任边界不同，View 始终运行在不具备同源权限的 sandbox iframe 中。

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

View 的 `entry` 必须是插件目录内的 `.html` 文件，不能使用绝对路径或 `..` 跳出插件目录。

Action 和 Event 以插件目录为工作目录运行。宿主注入 `TMUXGO_PLUGIN_ID`、`TMUXGO_PLUGIN_ROOT`、`TMUXGO_PLUGIN_DATA_DIR`、`TMUXGO_PLUGIN_CONFIG_DIR`、`TMUXGO_PLUGIN_STATE_DIR`、`TMUXGO_CONTEXT_JSON`、`TMUXGO_API_URL`、`TMUXGO_HOST_ID`、`TMUXGO_SESSION_ID` 和 `TMUXGO_PANE_ID`。

当前事件包括 `session.created`、`session.renamed`、`session.deleted`、`file.saved`、`file.uploaded` 和 `git.commit.completed`。

## 安装与更新

GitHub 来源使用 `owner/repo[/subdir]`，可选填写 branch、tag 或 commit 作为 ref。预览会解析为完整 commit，安装时只拉取并校验该 commit，构建后再次校验 manifest。对同一插件再次安装即为更新，原版本在注册表写入成功前保留，插件数据目录不会随更新删除。

卸载 GitHub 插件会删除受管源码和插件数据；卸载本地链接不会删除源目录。两种来源都可通过 `keepData=true` 的 API 参数保留数据。

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
