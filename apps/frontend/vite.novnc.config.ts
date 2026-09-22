import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

// 独立 lib 构建：仅产出 dist/novnc-rfb.js（IIFE 单文件），emptyOutDir:false 不能清掉
// 主构建产物；必须在主 build 之后跑（package.json build 顺序保证）。
// iife/lib 模式 codeSplitting=false 天然单文件，动态 import 全部 inline，不需额外选项
export default defineConfig({
  plugins: [
    tsconfigPaths(),
    {
      name: 'novnc-iife-tla-fix',
      // @novnc/novnc core/util/browser.js 用顶层 await 做 WebCodecs H264 探测，
      // IIFE 不支持 TLA。等价改写为 then 回填：唯一消费点（rfb.js 帧解码分支）
      // 在远端首帧到达时才读取该值，届时 promise 早已 settle
      transform(code, id) {
        if (!/novnc.*browser\.js$/.test(id)) return null
        const tla = /supportsWebCodecsH264Decode\s*=\s*await\s+_checkWebCodecsH264DecodeSupport\(\s*\)/
        if (!tla.test(code)) return null
        return code.replace(tla, '_checkWebCodecsH264DecodeSupport().then((v) => { supportsWebCodecsH264Decode = v })')
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    // fileName 固定 novnc-rfb.js：loader 按裸路径 /novnc-rfb.js 注入 script，无 hash
    lib: { entry: 'src/novnc-iife.ts', formats: ['iife'], name: 'TMUXGO_NOVNC', fileName: () => 'novnc-rfb.js' },
  },
})
