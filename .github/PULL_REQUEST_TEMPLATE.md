## 改动说明 / Summary

做了什么、为什么；关联 Issue：#。
What and why. Related issue: #

## 复现 / 验证步骤 / How verified

```bash
# 验证命令与实际结果 / commands and results
```

## 检查项 / Checklist

- [ ] `npm test` / `npm run test:frontend` 按范围 as relevant
- [ ] e2e：`npm run test:e2e`（涉及终端/交互行为时 when touching terminal/interactive behavior）
- [ ] `npm run lint` 与 `npm run typecheck` 通过，未新增 eslint warning / pass, no new warnings
- [ ] 仅格式化改动文件，未全仓格式化 / only changed files formatted
- [ ] 前端改动已 `npm run build`；gateway 改动已验证 `http://127.0.0.1:3001/` / frontend rebuilt; gateway verified on :3001
- [ ] 中英文文档措辞一致 / Chinese & English docs consistent

## 截图 / 兼容性 / Screenshots & compatibility

UI 改动附截图或录屏。涉及协议、tmux 行为、安装路径或 `@21hbguo/tmuxgo` 包名时，说明对现有 npx 用户的兼容性。
Attach screenshots/recordings for UI changes. For protocol, tmux behavior, install path, or package-name changes, state compatibility with existing npx users.
