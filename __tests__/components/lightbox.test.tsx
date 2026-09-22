import { fireEvent, render, screen } from '@testing-library/react'
import { Lightbox, useLightbox } from '@/components/Lightbox'

// Lift-not-redesign guard: this is the exact zoom EvalDetailPanel already had inline
// (a useState + createPortal block), pulled out so a second screen (the Individual
// review table) can open the same full-size view. These tests pin the contract:
// closed renders nothing, open renders the image via a portal, backdrop click and
// Escape close it, and clicking the image itself does not.

describe('Lightbox', () => {
  it('renders nothing when url is null', () => {
    const { container } = render(<Lightbox url={null} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    expect(document.querySelector('.lightbox-backdrop')).toBeNull()
  })

  it('renders the image when open, as a portal into document.body', () => {
    const { container } = render(<Lightbox url="https://example.com/shot.png" onClose={() => {}} />)
    // Nothing renders in the component's own subtree -- it's a portal.
    expect(container).toBeEmptyDOMElement()
    const img = document.querySelector('.lightbox-backdrop img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.src).toBe('https://example.com/shot.png')
  })

  it('closes on backdrop click', () => {
    const onClose = jest.fn()
    render(<Lightbox url="https://example.com/shot.png" onClose={onClose} />)
    const backdrop = document.querySelector('.lightbox-backdrop') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const onClose = jest.fn()
    render(<Lightbox url="https://example.com/shot.png" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Parity with EvalDetailPanel's own key handler, which skips its shortcuts when the
  // event came from a form field: a field owns its own Escape before this does.
  it('leaves Escape to a focused form field rather than closing over it', () => {
    const onClose = jest.fn()
    render(
      <>
        <input aria-label="a field" />
        <Lightbox url="https://example.com/shot.png" onClose={onClose} />
      </>,
    )
    fireEvent.keyDown(screen.getByLabelText('a field'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    // ...and still closes for an Escape from anywhere else
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when the image itself is clicked', () => {
    const onClose = jest.fn()
    render(<Lightbox url="https://example.com/shot.png" onClose={onClose} />)
    const img = document.querySelector('.lightbox-backdrop img') as HTMLImageElement
    fireEvent.click(img)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('useLightbox', () => {
  function Harness() {
    const { open, node } = useLightbox()
    return (
      <div>
        <button onClick={() => open('https://example.com/from-hook.png')}>open</button>
        {node}
      </div>
    )
  }

  it('starts closed, then open() renders the image, and the returned node can close itself', () => {
    render(<Harness />)
    expect(document.querySelector('.lightbox-backdrop')).toBeNull()

    fireEvent.click(screen.getByText('open'))
    const img = document.querySelector('.lightbox-backdrop img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.src).toBe('https://example.com/from-hook.png')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.lightbox-backdrop')).toBeNull()
  })
})
