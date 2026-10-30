import { z } from 'zod'

// 任务号唯一校验源：会写进 tmux user-option `@tmuxgo_task`，并被 pane 列表按行解析。
// 换行/控制字符会把 `#{@tmuxgo_task}` 的取值拆成多行，后续 pane 字段整体错位，
// 所以在入口就拒绝，而不是写进去再靠 trim 兜底。
export const paneTaskValueSchema = z
  .string()
  .max(120)
  // 这里就是要匹配控制字符，规则本身的告警在此处无意义
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'task must not contain control characters',
  })
