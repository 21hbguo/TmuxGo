// 导出正式协议 JSON Schema 到 docs/agent-control/control-protocol.<version>.schema.json
// （无 gateway 的第三方客户端的静态入口）。tests/control-schema-contract.test.ts
// 断言该文件与运行时生成结果一致——协议变更后重跑本脚本刷新。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_PROTOCOL_VERSION } from '../apps/gateway/src/lib/control-protocol.js'
import { buildControlProtocolSchema } from '../apps/gateway/src/lib/control-schema.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'docs/agent-control', `control-protocol.${CONTROL_PROTOCOL_VERSION}.schema.json`)
writeFileSync(target, `${JSON.stringify(buildControlProtocolSchema(), null, 2)}\n`)
console.log(`wrote ${target}`)
