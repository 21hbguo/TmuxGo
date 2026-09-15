import { DELETE_PREV_WORD_SEQUENCE } from './terminal-keys'
const DELETE_WORD_REPEAT_DELAY = 420
const DELETE_WORD_REPEAT_SECOND_DELAY = 109
const DELETE_WORD_REPEAT_THIRD_DELAY = 78
const DELETE_WORD_REPEAT_FOURTH_DELAY = 56
const DELETE_WORD_REPEAT_MIN_DELAY = 30
interface DeleteWordRepeatOptions {
  send: (data: string) => void
  isDisposed: () => boolean
}
export function createDeleteWordRepeat(options: DeleteWordRepeatOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = false
  const stop = () => {
    active = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const start = () => {
    stop()
    active = true
    let delay = DELETE_WORD_REPEAT_DELAY
    let repeatCount = 0
    const tick = () => {
      if (options.isDisposed() || !active) return
      options.send(DELETE_PREV_WORD_SEQUENCE)
      repeatCount += 1
      delay =
        repeatCount === 1
          ? DELETE_WORD_REPEAT_SECOND_DELAY
          : repeatCount === 2
            ? DELETE_WORD_REPEAT_THIRD_DELAY
            : repeatCount === 3
              ? DELETE_WORD_REPEAT_FOURTH_DELAY
              : DELETE_WORD_REPEAT_MIN_DELAY
      timer = setTimeout(tick, delay)
    }
    timer = setTimeout(tick, delay)
  }
  return {
    start,
    stop,
    isActive: () => active,
  }
}
