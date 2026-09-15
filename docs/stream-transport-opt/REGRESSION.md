# 回归清单

> 状态：参考（手工回归 checklist）

## 必测
- [ ] attach 本地 session
- [ ] resize 终端
- [ ] 多 web 同时看同一 session
- [ ] 断线重连 / 后台恢复
- [ ] resync / 全屏刷新
- [ ] 中文显示与输入回显
- [ ] 颜色 / SGR
- [ ] Agent 会话打开与滚动输出
- [ ] 关闭 compress flag 行为与旧路径一致
- [ ] 关闭 cell flag 行为与旧路径一致

## 压缩专项
- [ ] 未协商 caps 不收 type 3/4
- [ ] resync 走 gzip 且可正确解压显示
- [ ] 小包不压缩
- [ ] 压缩失败可降级

## Cell 专项
- [ ] flag 关零变化
- [ ] flag 开 + caps：纯文本/颜色/清屏正确
- [ ] parser 失败 fallback ANSI
- [ ] 多 web cell 模式可同时工作
