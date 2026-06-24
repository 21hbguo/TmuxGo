# TmuxGo 技术栈收口总结

## 总体判断

- 当前技术栈不算失控，也不是明显选型错误。
- 现阶段的问题主要不是“技术太多”，而是“边界如果不收紧，后续会越来越散”。
- 目前还没到必须大改的程度，但已经到了需要开始收口的阶段。

## 当前主要技术栈

### 前端

- Next.js
- React
- xterm.js
- Monaco Editor
- TanStack Query
- Zustand

### 后端与运行层

- Fastify gateway
- agent
- node-pty
- tmux
- SSH
- Git
- systemd / launchd
- shell 脚本

## 当前主要问题

### 1. 状态边界不够硬

当前同时使用：

- localStorage
- preferences API
- Zustand
- TanStack Query

问题：

- 同一类信息容易多处存放
- 刷新前后、本地与远端之间容易出现覆盖关系不清
- 后续功能继续增加时最容易失控

是否有必要修改：

- 有必要
- 这是最值得优先处理的点

建议：

- TanStack Query 只放服务端资源状态
- Zustand 只放页面/UI 瞬时状态
- localStorage 只放本机习惯与设备本地偏好
- preferences API 只放跨设备同步偏好

### 2. antd 半依赖风险已收口

问题：

- 此前不是完整基于 antd 设计体系
- 但又在零散使用 antd 组件

风险：

- 包体和依赖继续增长
- UI 风格和实现方式不统一
- 维护心智负担提高

是否有必要修改：

- 有必要，但不需要立刻重构

建议：

- 新功能不要重新引入 antd 使用面
- 保持自定义组件路线

### 3. agent 定位偏重

问题：

- 如果产品核心是本机 tmux 管理，agent 会增加部署和理解复杂度
- 如果产品核心是多主机远端能力，agent 又是合理的

是否有必要修改：

- 有必要先明确定位

建议：

- 明确 agent 是默认必装，还是按需启用
- 更推荐收口成可选组件，而不是默认把所有用户都拉进多机复杂度

### 4. 启动与部署链路偏工程化

当前依赖：

- bootstrap.sh
- start.sh
- systemd / launchd

问题：

- 对开发者友好
- 对普通用户仍然偏工程化

是否有必要修改：

- 有必要，但属于产品化优化，不是架构救火

建议：

- 后续统一成单一安装入口
- 用户层只暴露 install/start/restart 这种固定入口

### 5. 终端周边逻辑开始变厚

核心终端本身没有问题，但围绕它的逻辑已经越来越多：

- 移动端键盘
- 手势
- resize
- scroll
- copy/paste
- 恢复与重绘

问题：

- 终端组件后续继续膨胀的风险较高

是否有必要修改：

- 有必要控制
- 但不需要推倒重写

建议：

- 继续把终端相关能力集中在终端模块和相关 hooks 内
- 不要把终端逻辑继续扩散到全局层

## 哪些暂时不建议动

这些虽然不轻，但职责明确，当前不是主要问题源头：

- xterm.js
- Monaco
- Fastify gateway
- tmux + node-pty

## 最值得优先收口的三项

1. 状态存储边界
2. antd 使用面（已收口）
3. agent 的产品定位

## 本次修复落点

- 状态边界：active host/session 与 editor workspace 的浏览器本机持久化集中到 `console-device-state`，Zustand 继续只承载当前 UI 状态。
- antd 使用面：`FilePanel` 已改为本地文件树渲染，移除 `antd` 与 `@ant-design/icons` 依赖。
- agent 定位：安装与 `start.sh` 默认只启动 Frontend/Gateway，Agent 改为通过 `TMUXGO_ENABLE_AGENT=1` 显式启用。

## 结论

- 当前项目不是“技术栈错误”，而是“需要约束和收口”。
- 最有必要尽快处理的是状态边界，不是换技术栈。
- 如果继续扩功能而不收口，后面复杂度会明显上升。
- 当前最合理的策略是：保留核心栈，减少扩散，明确边界，逐步可选化重模块。
