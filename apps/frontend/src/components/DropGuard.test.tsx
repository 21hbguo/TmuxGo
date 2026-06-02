import { cleanup, render } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { DropGuard } from './DropGuard'
import { clearActiveDraggedFile, setActiveDraggedFile } from '@/lib/editor-drag'

function createDragEvent(type: 'dragover' | 'drop', target: Element, types: string[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'target', { value: target })
  Object.defineProperty(event, 'dataTransfer', { value: { types, dropEffect: 'copy' } })
  return event as DragEvent
}

describe('DropGuard', () => {
  afterEach(() => {
    clearActiveDraggedFile()
    cleanup()
    document.body.innerHTML = ''
  })

  it('allows internal file drags inside the editor workbench', () => {
    render(React.createElement(DropGuard))
    setActiveDraggedFile({
      id: 'editor-1',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.ts',
      name: 'index.ts',
      absolutePath: '/workspace/src/index.ts',
    })
    const root = document.createElement('section')
    root.setAttribute('data-editor-drop', '')
    const child = document.createElement('div')
    root.appendChild(child)
    document.body.appendChild(root)
    const event = createDragEvent('dragover', child)
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('blocks non-terminal drags outside allowed drop zones', () => {
    render(React.createElement(DropGuard))
    const target = document.createElement('div')
    document.body.appendChild(target)
    const event = createDragEvent('dragover', target)
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(event.dataTransfer?.dropEffect).toBe('none')
  })
})
