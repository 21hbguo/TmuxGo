import { afterEach, describe, expect, it } from 'vitest'
import {
  describeElement,
  elementLabel,
  getCssPath,
  insertText,
  resolvePickTarget,
  PICKER_UI_ATTR,
} from './element-picker'

describe('getCssPath', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('short-circuits on a document-unique id', () => {
    document.body.innerHTML = '<div><section><span id="target">x</span></section></div>'
    expect(getCssPath(document.getElementById('target')!)).toBe('#target')
  })

  it('uses a document-unique locator attribute and stops climbing', () => {
    document.body.innerHTML = '<div><div><button data-testid="save">s</button></div></div>'
    expect(getCssPath(document.querySelector('button')!)).toBe('button[data-testid="save"]')
  })

  it('keeps a unique class combination without nth-of-type', () => {
    document.body.innerHTML = '<div><span class="a b"></span><span class="a"></span></div>'
    expect(getCssPath(document.querySelector('.b')!)).toBe('body > div > span.a.b')
  })

  it('falls back to nth-of-type among same-tag siblings, capped at body', () => {
    document.body.innerHTML = '<ul><li>a</li><li>b</li></ul>'
    expect(getCssPath(document.querySelectorAll('li')[1])).toBe('body > ul > li:nth-of-type(2)')
  })

  it('prefers nth-of-type when the class combination is ambiguous', () => {
    document.body.innerHTML = '<div><span class="a"></span><span class="a"></span></div>'
    expect(getCssPath(document.querySelectorAll('span')[1])).toBe('body > div > span.a:nth-of-type(2)')
  })

  it('climbs past a non-unique locator attribute instead of stopping', () => {
    document.body.innerHTML =
      '<section id="wrap"><button data-testid="x">1</button><button data-testid="x">2</button></section>'
    expect(getCssPath(document.querySelectorAll('button')[1])).toBe('#wrap > button:nth-of-type(2)')
  })

  it('escapes ids that are not valid bare CSS identifiers', () => {
    document.body.innerHTML = '<div id="a.b:c">x</div>'
    const path = getCssPath(document.querySelector('div')!)
    expect(path.startsWith('#')).toBe(true)
    expect(document.querySelector(path)?.id).toBe('a.b:c')
  })
})

describe('elementLabel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders tag#id plus at most three classes', () => {
    document.body.innerHTML = '<div id="x" class="a b c d">x</div>'
    expect(elementLabel(document.querySelector('div')!)).toBe('div#x.a.b.c')
  })
})

describe('resolvePickTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('rejects picker UI, body and documentElement', () => {
    document.body.innerHTML = `<div ${PICKER_UI_ATTR}><button>x</button></div>`
    expect(resolvePickTarget(document.querySelector('button'))).toBeNull()
    expect(resolvePickTarget(document.body)).toBeNull()
    expect(resolvePickTarget(document.documentElement)).toBeNull()
    expect(resolvePickTarget(null)).toBeNull()
  })

  it('hoists xterm internals to the [data-terminal] container', () => {
    document.body.innerHTML = '<div data-terminal><div class="xterm"><canvas></canvas></div></div>'
    expect(resolvePickTarget(document.querySelector('canvas'))).toBe(document.querySelector('[data-terminal]'))
  })

  it('hoists bare .xterm hits to the xterm root', () => {
    document.body.innerHTML = '<div class="xterm"><canvas></canvas></div>'
    expect(resolvePickTarget(document.querySelector('canvas'))).toBe(document.querySelector('.xterm'))
  })

  it('returns ordinary elements untouched', () => {
    document.body.innerHTML = '<button id="b">x</button>'
    const button = document.querySelector('button')!
    expect(resolvePickTarget(button)).toBe(button)
  })
})

describe('describeElement', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('collects selector, label and attributes excluding class/style', () => {
    document.body.innerHTML = '<button class="a" style="color:red" role="tab" data-x="1">x</button>'
    const info = describeElement(document.querySelector('button')!)
    expect(info.selector).toBe('body > button.a')
    expect(info.label).toBe('button.a')
    expect(info.componentName).toBeNull()
    expect(info.attributes.map((a) => a.name)).toEqual(['role', 'data-x'])
    expect(info.terminal).toBe(false)
  })

  it('marks terminal containers', () => {
    document.body.innerHTML = '<div data-terminal><div class="xterm"></div></div>'
    const info = describeElement(document.querySelector('[data-terminal]')!)
    expect(info.terminal).toBe(true)
  })
})

describe('insertText', () => {
  it('keeps component name plus last two selector segments', () => {
    expect(
      insertText({
        selector: '#root > main > div.panel > button.a:nth-of-type(2)',
        label: '',
        tagName: 'button',
        componentName: 'QuickActions',
        attributes: [],
        rect: { x: 0, y: 0, width: 0, height: 0 },
        terminal: false,
      }),
    ).toBe('QuickActions > div.panel > button.a:nth-of-type(2)')
  })
  it('falls back to selector tail without component', () => {
    expect(
      insertText({
        selector: '#pick-me',
        label: '',
        tagName: 'button',
        componentName: null,
        attributes: [],
        rect: { x: 0, y: 0, width: 0, height: 0 },
        terminal: false,
      }),
    ).toBe('#pick-me')
  })
})
