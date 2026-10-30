import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { CsvTable } from './CsvTable'

const csv = 'name,city\nAlice,Beijing\nBob,Shanghai\nCara,Shenzhen'

function setup(props: Partial<React.ComponentProps<typeof CsvTable>> = {}) {
  const copyText = vi.fn()
  render(<CsvTable content={csv} emptyLabel="empty" copyText={copyText} {...props} />)
  return { copyText, grid: screen.getByRole('grid') }
}

describe('CsvTable', () => {
  it('renders header, body and row numbers', () => {
    setup()
    expect(screen.getByText('name')).toBeInTheDocument()
    expect(screen.getByText('Shanghai')).toBeInTheDocument()
    expect(screen.getByTestId('csv-table-summary')).toHaveTextContent('3')
  })
  it('shows the empty label for blank content', () => {
    render(<CsvTable content="" emptyLabel="nothing here" />)
    expect(screen.getByText('nothing here')).toBeInTheDocument()
  })
  it('copies the whole table as TSV including header', () => {
    const { copyText } = setup()
    fireEvent.click(screen.getByTestId('csv-copy-table'))
    expect(copyText).toHaveBeenCalledWith('name\tcity\nAlice\tBeijing\nBob\tShanghai\nCara\tShenzhen')
  })
  it('copies a rectangular selection as TSV', () => {
    const { copyText, grid } = setup()
    fireEvent.pointerDown(screen.getByTestId('csv-cell-0-0'), { button: 0 })
    fireEvent.pointerDown(screen.getByTestId('csv-cell-1-1'), { button: 0, shiftKey: true })
    fireEvent.keyDown(grid, { key: 'c', ctrlKey: true })
    expect(copyText).toHaveBeenCalledWith('Alice\tBeijing\nBob\tShanghai')
  })
  it('does not intercept Ctrl+C without a selection', () => {
    const { copyText, grid } = setup()
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
    grid.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(copyText).not.toHaveBeenCalled()
  })
  it('selects all body cells and copies them on Ctrl+A then Ctrl+C', () => {
    const { copyText, grid } = setup()
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(grid, { key: 'c', ctrlKey: true })
    expect(copyText).toHaveBeenCalledWith('Alice\tBeijing\nBob\tShanghai\nCara\tShenzhen')
  })
  it('sorts ascending then descending from the header', () => {
    setup({ content: 'n\n10\n9\n2' })
    fireEvent.click(screen.getByTestId('csv-header-0'))
    const cells = () => screen.getAllByTestId(/csv-cell-\d+-0/).map((node) => node.textContent)
    expect(cells()).toEqual(['2', '9', '10'])
    fireEvent.click(screen.getByTestId('csv-header-0'))
    expect(cells()).toEqual(['10', '9', '2'])
    fireEvent.click(screen.getByTestId('csv-header-0'))
    expect(cells()).toEqual(['10', '9', '2'])
  })
  it('filters rows case-insensitively', () => {
    setup()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bei' } })
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })
  it('caps rendered rows and reports truncation', () => {
    const rows = ['n', ...Array.from({ length: 20 }, (_, index) => String(index))]
    setup({ content: rows.join('\n'), maxRows: 3 })
    expect(screen.getAllByTestId(/csv-cell-\d+-0/)).toHaveLength(3)
    expect(screen.getByTestId('csv-truncated')).toHaveTextContent('Only first 3 of 20 rows')
  })
  it('offers a context menu that copies a column', () => {
    const { copyText } = setup()
    fireEvent.contextMenu(screen.getByTestId('csv-cell-1-1'), { clientX: 10, clientY: 20 })
    const menu = screen.getByTestId('csv-context-menu')
    fireEvent.click(within(menu).getByText('Copy column'))
    expect(copyText).toHaveBeenCalledWith('Beijing\nShanghai\nShenzhen')
    expect(screen.queryByTestId('csv-context-menu')).not.toBeInTheDocument()
  })
  it('copies markdown table from the context menu', () => {
    const { copyText } = setup()
    fireEvent.contextMenu(screen.getByTestId('csv-cell-0-0'), { clientX: 10, clientY: 20 })
    fireEvent.click(within(screen.getByTestId('csv-context-menu')).getByText('Copy table as Markdown'))
    expect(copyText).toHaveBeenCalledWith(
      '| name | city |\n| --- | --- |\n| Alice | Beijing |\n| Bob | Shanghai |\n| Cara | Shenzhen |',
    )
  })
})
