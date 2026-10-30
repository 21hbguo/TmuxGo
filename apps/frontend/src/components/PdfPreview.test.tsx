import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfPreview } from './PdfPreview'

const labels = {
  loading: 'Loading preview',
  failed: 'Preview did not open',
  openNew: 'Open in new tab',
  download: 'Download',
  large: 'Large file, click to load',
}

const url = 'http://localhost:3001/api/hosts/local/files/raw/root-0/doc.pdf'

describe('PdfPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mounts the iframe with the raw url and clears the loading hint on load', () => {
    render(<PdfPreview name="doc.pdf" url={url} labels={labels} />)
    const frame = screen.getByTestId('pdf-frame')
    expect(frame.getAttribute('src')).toBe(url)
    expect(frame.getAttribute('title')).toBe('doc.pdf')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.getByTestId('pdf-loading').textContent).toBe('Loading preview')
    fireEvent.load(frame)
    expect(screen.queryByTestId('pdf-loading')).toBeNull()
  })

  it('shows the gate for oversized files and only mounts the iframe after a click', () => {
    render(<PdfPreview name="huge.pdf" url={url} size={70 * 1024 * 1024} labels={labels} />)
    expect(screen.queryByTestId('pdf-frame')).toBeNull()
    const gate = screen.getByTestId('pdf-gate')
    expect(gate.textContent).toBe('Large file, click to load')
    fireEvent.click(gate)
    expect(screen.getByTestId('pdf-frame').getAttribute('src')).toBe(url)
  })

  it('keeps the iframe and shows the fallback bar when load never fires', () => {
    render(<PdfPreview name="doc.pdf" url={url} labels={labels} />)
    expect(screen.queryByTestId('pdf-fallback')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(8000)
    })
    const fallback = screen.getByTestId('pdf-fallback')
    expect(fallback.textContent).toContain('Preview did not open')
    expect(screen.getByTestId('pdf-frame')).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(
      links.some((link) => link.getAttribute('target') === '_blank' && link.textContent === 'Open in new tab'),
    ).toBe(true)
    const download = links.find((link) => link.textContent === 'Download')
    expect(download?.getAttribute('download')).toBe('doc.pdf')
  })

  it('does not show the fallback when the document loads in time', () => {
    render(<PdfPreview name="doc.pdf" url={url} labels={labels} />)
    fireEvent.load(screen.getByTestId('pdf-frame'))
    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(screen.queryByTestId('pdf-fallback')).toBeNull()
  })

  it('resets the gate state when the url changes', () => {
    const { rerender } = render(<PdfPreview name="a.pdf" url={url} labels={labels} />)
    fireEvent.load(screen.getByTestId('pdf-frame'))
    rerender(<PdfPreview name="b.pdf" url={`${url}?v=2`} labels={labels} />)
    expect(screen.getByTestId('pdf-loading').textContent).toBe('Loading preview')
    expect(screen.getByTestId('pdf-frame').getAttribute('src')).toBe(`${url}?v=2`)
  })
})
