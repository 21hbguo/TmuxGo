# 编辑区渲染补强（Batch R1）

> 状态：已实现（R1）· 2026-10-30 · 相关代码：`apps/frontend/src/lib/{markdown,markdown-assets,markdown-image-cache,csv,file-preview,raw-url,cm6/*}`、
> `apps/frontend/src/components/{MarkdownPreview,MarkdownPreviewHost,CmMarkdownEditor,LiveMarkdownSurface,CsvTable,PdfPreview,MediaPreview}.tsx`、
> `apps/gateway/src/{routes/files.ts,lib/files/{raw-range,raw-mime,raw-stream}.ts}`

## 1. 症状与根因

| 症状 | 根因（代码位置） | 处置 |
|---|---|---|
| md 里 `![](./a.png)` 裂图 | `renderMarkdown` 没有 image renderer，`src` 原样进 DOM，浏览器按应用源解析 → 404；`<img>` 带不上 Bearer | 自定义 image renderer 输出 `data-md-src/-path` + 透明占位；`MarkdownPreview` 用 blob 预取换 `src` |
| 预览模式不能编辑 | 预览是 `dangerouslySetInnerHTML` 的只读 HTML，没有源码模型；Monaco 只是被 `hidden` | markdown 新增 `live` 模式：CM6 源码 + 装饰器隐藏标记（Obsidian 式）；双击只读预览跳到 live 对应行 |
| CSV 不能复制 | 表格无选区/复制模型；`whitespace-pre-wrap` 破坏矩形选择；`Math.max(...rows)` 对十万行栈溢出 | `CsvTable` 重写：矩形选区 + Ctrl+C/Ctrl+A/右键菜单（TSV/CSV/Markdown/列/整表）+ 排序/筛选 + 行列表头固定 |
| `.tsv` / `;` 分隔 / BOM 识别错 | 解析器只认逗号、不剥 BOM、丢尾空行 | `detectDelimiter` + BOM 剥离 + 只丢末尾换行产生的单空行 |
| PDF 打不开 | `.pdf` 无语言映射 → `plaintext` → `/files/content` 二进制 → 「二进制不可编辑」错误卡 | 网关 `/files/raw` 路径式流 + 前端 `PdfPreview` iframe 原生 viewer |
| 音视频/HTML 内嵌资源弱 | 无 raw 路由，只能下载 | 同上；HTML 走 raw 时附 `CSP: sandbox` |

## 2. Markdown 图片链路

```
renderMarkdownDocument(content, {asset})       # marked + DOMPurify，image renderer 注入 data-md-*
  └─ <img data-md-src="./pic.png" data-md-path="docs/pic.png" data-md-kind="relative" src="data:image/gif;base64,...">
MarkdownPreview                                # 扫描 img[data-md-src]
  └─ createMarkdownImageLoader(ctx).load(src)  # fetchApiBlob(imageUrl) → objectURL，LRU/并发 3，dispose revoke
       └─ 成功：src=blob:…；失败/越界：占位卡（不出现裂图图标）
```

规则：
- `http(s)://`、`data:image/*` 直接使用；`javascript:` 等 unsafe scheme 被 DOMPurify 剥除；
- `/abs/x.png` 按 **root 相对** 处理（与后端 `normalizeRelativePath` 一致）；`../` 逃出 root → 占位；
- 中文/空格文件名先 `decodeURIComponent`，URL 段编码交给 `api.files.imageUrl`；
- 同一个 `src` 只取一次；组件卸载 `dispose()` 统一 revoke。

## 3. Markdown live preview（CM6）

- 触发：`language === 'markdown'`、非 compare、非 `git-diff?`、`viewPrefs.markdownLivePreview === true`；
- 结构：`CmMarkdownEditor`（React）→ CM6 `EditorView` + `StateField`（装饰器）+ `@lezer/markdown`（GFM）语法树；
- 规则：光标/选区所在行整行展开源码；其余行用 `Decoration.replace` 隐藏 `#`、`**`、反引号、`[]()`、`-`、`>`、任务框，
  图片整段替换为 widget，标题/引用加行级样式；任务框点击改写源码 `[ ]`/`[x]`；
- 数据：与 Monaco 共用 `editor.content`（zustand），`onChange` 走同一 dirty/save 管线；`value` 外部变化不重建 view；
- 回退：偏好关掉 → markdown 默认仍是只读预览 + 源码编辑（旧行为）；工具栏四态：实时 / 源码 / 预览 / 分栏；
- 明确不做（P1）：表格 WYSIWYG、mermaid/katex、代码高亮主题库、撤销跨引擎共享。

## 4. CSV

- 解析：RFC4180 简版；`detectDelimiter` 前 5 个非空行在引号外计数 `, ; \t |`；`.tsv/.tab` 默认制表符；BOM 剥离并记录；
- 展示：只截 DOM（默认 5000 行 × 256 列），数据保留完整供复制；`sliceTable` 用 reduce 统计列数，杜绝 `Math.max(...spread)`；
- 交互：单击定位、Shift+单击扩选、方向键移动、Ctrl/Cmd+A 全选、Esc 清除、Ctrl/Cmd+C 复制选区（TSV）；
  无选区时不拦截原生复制；右键菜单：复制选区/本列/整表 TSV/CSV/Markdown；
- 排序/筛选：点表头三态（升/降/取消），筛选对全列大小写不敏感；两者只改视图，复制取当前视图；
- 可访问性：`role=grid`、`aria-sort`、tabIndex 键盘可操作；移动端恢复 `-webkit-touch-callout`。

## 5. `/files/raw`

```
GET|HEAD /api/hosts/:hostId/files/raw/:rootId/*
```

- 路径式（不是 `?path=`）：HTML 预览的相对资源（`a.png`、`style.css`）要靠目录层级解析；
- 单段 Range（多段回落 200）+ 416 + `Content-Range`；ETag/Last-Modified/304/If-Range；
- mime 白名单，`.svg` 一律 415（inline SVG 存储型 XSS）；HTML/XHTML 附 `Content-Security-Policy: sandbox`，PDF 不加；
- 远程 host：`getDownloadStream(offset)` + `limitBytes(length)` 截断；断连 `AbortController` 掐掉 SSH/agent 子进程；
- 鉴权：沿用 Bearer + access cookie（`<iframe>/<video>` 无法带 header）；Bearer-only/跨站场景 401 列入已知限制，票据 P1。

## 6. 性能预算

| 场景 | 预算 | 落点 |
|---|---|---|
| `renderMarkdown` 200KB（jsdom） | ≤ 2000ms（存量） | `lib/editor-perf.test.ts` |
| markdown live 单键（3k 块/375KB，含装饰重建） | p95 < 60ms（实测 avg 1.5ms / max 5.6ms） | `lib/cm6/perf.test.ts` |
| markdown live 扫描（3k 块/375KB） | ≤ 600ms（实测 117ms，node 二次运行） | 同上 |
| markdown live 扫描（10k 块/1.2MB） | ≤ 2500ms（实测 225ms；vitest/jsdom 首跑 456ms） | 同上 |
| 预览输入 → HTML（≥16KB） | p95 ≤ 350ms | 同上 |
| CSV 130k 行切片/排序 | 切片 ≤ 50ms，不抛 RangeError | `lib/csv.test.ts` |

## 7. 已知限制

1. CM6 live 的表格/代码块只做样式，不做 widget 编辑；IME 组合输入需真机验证；
2. `/files/raw` 的远程 Range 与断连取消只用本地流 + 单测覆盖，SSH 真机未验；
3. Bearer-only（无 cookie）时 iframe/video 会 401；票据签名下一批；
4. Office 文档不做内嵌渲染（下载/元信息卡）；
5. `IMAGE_MIME_BY_EXT` 与 `RAW_MIME_BY_EXT` 两份表暂存，后续合并；
6. 标题 id 由内容 slug 生成：同一篇 md 在多面板同时渲染会出现重复 id（只影响锚点定位）；
7. live 模式的图片缓存按 `host:root` 分域、卸载即清空；blob URL 与预览组件不共享（各自 loader 生命周期）；
8. 代码块复制按钮是 `<pre>` 的子节点，手动全选代码时可能带上按钮文字；
9. HTML 预览仍走 `srcDoc`，相对资源（css/png）不会加载；改用 raw URL 需要单独的 `base` 方案（P1）。

## 8. 下一批（P1）

- PDF 自绘（pdfjs-dist + 文本层/搜索），仅在需要「页内搜索/标注」时引入；
- HTML 预览 raw 化 + `<base>`；
- CSV 虚拟滚动（>5000 行仍可浏览）；
- markdown 表格 widget、代码高亮、mermaid/katex；
- raw 短票（Bearer-only / 跨站 iframe）；`/files/image` 下线评估。
