import { beforeEach, describe, expect, it } from 'vitest'
import { useElementPickerStore } from './useElementPickerStore'

describe('useElementPickerStore', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    useElementPickerStore.setState({ active: false, selected: null })
  })

  it('toggles active state and clears selection on start/stop', () => {
    const store = useElementPickerStore.getState()
    store.start()
    expect(useElementPickerStore.getState().active).toBe(true)
    useElementPickerStore.getState().selectElement(document.body.appendChild(document.createElement('div')))
    expect(useElementPickerStore.getState().selected).not.toBeNull()
    useElementPickerStore.getState().stop()
    expect(useElementPickerStore.getState().active).toBe(false)
    expect(useElementPickerStore.getState().selected).toBeNull()
    useElementPickerStore.getState().toggle()
    expect(useElementPickerStore.getState().active).toBe(true)
    useElementPickerStore.getState().toggle()
    expect(useElementPickerStore.getState().active).toBe(false)
  })

  it('start resets a stale selection', () => {
    document.body.innerHTML = '<p id="a">x</p>'
    useElementPickerStore.getState().start()
    useElementPickerStore.getState().selectElement(document.getElementById('a'))
    expect(useElementPickerStore.getState().selected?.selector).toBe('#a')
    useElementPickerStore.getState().start()
    expect(useElementPickerStore.getState().selected).toBeNull()
  })

  it('selectElement resolves targets and ignores unselectable hits', () => {
    document.body.innerHTML = '<div data-terminal><div class="xterm"><canvas></canvas></div></div>'
    useElementPickerStore.getState().start()
    useElementPickerStore.getState().selectElement(document.querySelector('canvas'))
    const selected = useElementPickerStore.getState().selected
    expect(selected?.terminal).toBe(true)
    expect(selected?.selector).toBe('body > div')
    useElementPickerStore.getState().selectElement(document.body)
    expect(useElementPickerStore.getState().selected?.selector).toBe('body > div')
  })
})
