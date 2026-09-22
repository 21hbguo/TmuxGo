import * as mod from '@novnc/novnc'

// IIFE 经典脚本入口：挂 window 供 novnc-loader 的 <script src> 注入级取回，
// 完全绕开 module loader（个别移动浏览器动态 import() 整体死锁，但经典 script 正常）。
// 名字用 __TMUXGO_ 前缀防通用名冲突
;(window as any).__TMUXGO_NOVNC__ = mod
