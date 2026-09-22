# noVNC 移动端 import() 全死 —— 上 IIFE 经典脚本兜底（来自 devin@TmuxGo:1.1 回:%556）

完成回执 `DONE` + 改动清单 + 验证结果。

## 新证据
真机实测报 `novnc load failed: api-import=timeout, blob=timeout, chunk=timeout`——三级全挂。
结论：不是单 URL 毒化，**该浏览器运行时动态 import() 整体死锁**（静态 module 图正常——app 本体就是 script type=module 起来的）。动态 import 这条路在这台机器上没有挽救价值，换完全不依赖 module loader 的经典脚本。

## 方案：IIFE bundle + `<script src>` 注入

### 1. 新增入口 `apps/frontend/src/novnc-iife.ts`
```ts
import * as mod from '@novnc/novnc'
// 挂到 window 供 loader 取回；名字别用通用名防冲突
;(window as any).__TMUXGO_NOVNC__ = mod
```

### 2. 独立 vite lib 构建产出 IIFE
新增 `apps/frontend/vite.novnc.config.ts`（独立 config，不动主构建）：
```ts
// 仅产出 dist/novnc-rfb.js；emptyOutDir:false 不能清主构建产物
export default defineConfig({
  plugins: [tsconfigPaths()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: { entry: 'src/novnc-iife.ts', formats: ['iife'], name: 'TMUXGO_NOVNC' },
    rollupOptions: { output: { inlineDynamicImports: true } },  // 关键：动态 import 全部 inline 成单文件
  },
})
```
package.json build 改为 `vite build && vite build --config vite.novnc.config.ts`（主构建先跑清空 dist，iife 后跑追加文件；顺序不能反）。
产出 `dist/novnc-rfb.js`，gateway 静态服务自动覆盖（prefix '/'，无需新路由）。

### 3. novnc-loader.ts 加 script 注入级
```ts
function injectScript(): Promise<NovncModule> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    // ?v=buildId 防 CDN/浏览器缓存旧文件（文件名无 hash）
    script.src = `${getApiBase()}/novnc-rfb.js?v=${import.meta.env.VITE_APP_BUILD_ID}`
    script.onload = () => {
      const mod = (window as any).__TMUXGO_NOVNC__
      mod ? resolve(mod as NovncModule) : reject(new Error('no global'))
    }
    script.onerror = () => reject(new Error('script error'))
    document.head.appendChild(script)
  })
}
```
继续走 withStepTimeout 包超时（script.onload 也可能永不触发）。

### 4. 降级顺序（每级仍 5s，移动端只留 3 级以贴住外层 15s connect timeout）
- 移动端：`script-iife` → `api-import` → `chunk`
- 桌面端：`chunk` → `api-import` → `script-iife`（blob 级整条删了——api-import 已覆盖它的用途且更可靠）
- 末级错误照旧带阶段名。

### 注意
- dev（vite 5199）下 `/novnc-rfb.js` 不存在（文件只产在 dist），script 级会 onerror 落下一级——dev 浏览器本来就能走 import，无影响。
- `import.meta.env.VITE_APP_BUILD_ID` 已在 define 里存在，直接用。
- `pnpm --filter frontend build` 后确认 `dist/novnc-rfb.js` 存在且首行是 `(function`/`var TMUXGO_NOVNC` 形态（IIFE），不是 `import`/`export`。
- 提交只 stage 本次文件（src/novnc-iife.ts、vite.novnc.config.ts、package.json、novnc-loader.ts、可能的测试）。
- 验证：vitest 相关用例 + tsc + eslint + prettier + build 产物检查；`curl dist` 路径不通就本地 `node -e` 或直接看文件头。
