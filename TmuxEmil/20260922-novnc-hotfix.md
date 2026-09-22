# noVNC 移动端仍连不上 —— blob import 兜底失效，改直导 API URL（来自 devin@TmuxGo:1.1 回:%556）

完成回执 `DONE` + 改动清单 + 验证结果。

## 新证据（journal 实锤）
08:40:25 移动端 `GET /api/vnc/client-module` → **200**（路由修复生效），同秒 `ws-ticket` 也成功；但**之后没有任何 `/api/vnc?` WS upgrade**——对照昨天成功的连接（15:20 起多条 `vnc ws accepted`），说明卡在 `loadNovnc()` 里的 `import(blobUrl)`：fetch 拿到文本了，blob 模块导入挂了（不 resolve 不 reject，被外层 15s connect timeout 兜成"连接超时"）。

## 改动（只动 apps/frontend/src/lib/novnc-loader.ts）

1. **新增首选路径**：`import(/* @vite-ignore */ \`${getApiBase()}/api/vnc/client-module\`)`——
   毒化是 module map 按 URL 记的条目，这个 URL 是全新条目天然绕开；比 blob 兼容面大（同源、自带 cookie、MIME text/javascript、无 CSP/blob: 坑）。vite 16140 类 bug 证明生产构建下 blob: import 本身不可靠。
2. **每一级都包超时**（现在 `fetchModule` 的 `import(blob)` 没有超时，挂起只能等外层 connect timeout）：每步 `Promise.race(step, timeout ~5s)`，挂起→reject→进下一级。
3. **加载顺序**：
   - 移动端：`import(apiUrl)` → `fetch→blob import` → 静态 chunk `import('@novnc/novnc')`
   - 桌面端：静态 chunk（原 5s 竞速不变）→ `import(apiUrl)` → `fetch→blob`
4. **错误信息带阶段**：最终 throw 时标明哪一级失败（如 `novnc load failed: api-import=HTTP 401, blob=<err>, chunk=timeout`），下次排障不用猜。

## 注意
- `import(apiUrl)` 是同源模块加载，cookie 随请求走（same-origin credentials），未登录 401 → reject → 走下一级，行为正确。
- rfb chunk 自包含无相对导入，走哪个 URL import 都安全。
- `pnpm --filter frontend build` 重建 dist（index.html no-cache，移动端刷新即拿新包）。gateway 无改动不用重启。
- 顺带看一眼编译产物确认 `import(/* @vite-ignore */)` 没被 rolldown 的 `Ml` preload helper 改坏 URL（dist 里应看到 `import(t)`/`import("...client-module")` 原样）。
