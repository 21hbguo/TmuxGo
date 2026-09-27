// 必须作为测试文件的首个 import：agentManager 单例与 auth 等在模块级解析 TMUXGO_CONFIG_DIR，
// 不设会先写真实 ~/.tmuxgo（曾导致测试往真实 agent-history.json 写入 58 条假 agent）
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TMUXGO_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-test-'))
// 上传/文件路由测试落盘目标隔离到临时 workspace root（rootSpec 在模块加载时解析）
process.env.TMUX_WEB_FILE_ROOTS = `workspace=${mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-root-'))}`
