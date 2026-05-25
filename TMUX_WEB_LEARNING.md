# 从 tmux_web 值得学习的功能
## P0
1. 文件面板全链路
- 目录浏览+面包屑+文件预览+行号跳转
- 文件名搜索与内容搜索分离
- 路径一键插入终端
- 最近文件与多工作区根目录切换
2. 文件系统安全边界(配合文件面板使用)
- 根目录白名单约束
- 路径穿越拦截(`Path.resolve()` + `relative_to()` 阻断符号链接逃逸)
- 二进制与大文件预览保护
- 搜索资源保护：扫描上限(8000目录/4000文件)、结果上限(200条)、大文件跳过(>512KB)
3. 会话访问控制
- `TMUX_WEB_ALLOWED_SESSIONS` 白名单
- attach 前自动关闭 `destroy-unattached` 选项，防止 Web 断连后会话被 tmux 销毁
4. 移动端浏览器兼容补丁
- Edge Android: UA 检测 + 绕过自定义 viewport 处理 + 自动开启键盘事件日志
- iOS: `navigator.virtualKeyboard.overlaysContent=true` + `geometrychange` 监听
## P1
1. 粘贴降级对话框
- clipboard API 失败后弹出辅助对话框，含权限重试按钮
- 用户可手动粘贴到对话框 textarea 再确认
2. 日志自动裁剪(若无外部日志轮转)
- 后台任务定时裁剪，`deque(maxlen)` 保留最近 N 行
- 阈值/间隔均可环境变量配置
## P2
1. Drop Guard + 拖拽插入路径
- 三层防御：内联脚本(页面加载前) + drop_guard.js(双阶段捕获) + 主处理逻辑
- 拖拽文件到终端自动插入路径：支持 file://、vscode-remote:// 协议自动解码，shell quote 路径
- 拖入终端区域时显示高亮反馈样式
## 对当前项目的直接收益
1. 补齐文件工作流后，Web 端可替代大量本地文件跳转操作
2. 安全边界清晰后，可安全开放给更多设备访问
3. 粘贴降级补齐后，移动端剪贴板操作不再卡死
4. Drop Guard 补齐后，防止误拖文件破坏终端会话
## 建议落地顺序
1. 先做会话白名单+destroy-unattached保护(安全基建，改动小)
2. 再做粘贴降级对话框+Drop Guard(体验修复，独立可交付)
3. 最后做文件面板+安全边界(大功能，需前后端联动)
