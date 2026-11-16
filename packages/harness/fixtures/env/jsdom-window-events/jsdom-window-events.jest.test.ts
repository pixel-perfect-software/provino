test('window.dispatchEvent reaches a listener added with window.addEventListener', () => {
  const seen: number[] = []
  const handler = (event: Event): void => {
    seen.push((event as MouseEvent).clientX)
  }
  window.addEventListener('mousemove', handler)
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5 }))
  expect(seen).toEqual([5])
  window.removeEventListener('mousemove', handler)
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 6 }))
  expect(seen).toEqual([5])
})

test('globalThis is the window and dispatches to its own listeners', () => {
  const seen: string[] = []
  const handler = (event: Event): void => {
    seen.push(event.type)
  }
  expect(globalThis === window).toBe(true)
  globalThis.addEventListener('ping', handler)
  expect(globalThis.dispatchEvent(new Event('ping'))).toBe(true)
  window.dispatchEvent(new Event('ping'))
  globalThis.removeEventListener('ping', handler)
  globalThis.dispatchEvent(new Event('ping'))
  expect(seen).toEqual(['ping', 'ping'])
})

test('document.dispatchEvent reaches document listeners and bubbles to the window', () => {
  const onDocument: string[] = []
  const onWindow: string[] = []
  const documentHandler = (event: Event): void => {
    onDocument.push(event.type)
  }
  const windowHandler = (event: Event): void => {
    onWindow.push(event.type)
  }
  document.addEventListener('custom', documentHandler)
  window.addEventListener('custom', windowHandler)
  document.dispatchEvent(new Event('custom', { bubbles: true }))
  expect(onDocument).toEqual(['custom'])
  expect(onWindow).toEqual(['custom'])
  document.removeEventListener('custom', documentHandler)
  window.removeEventListener('custom', windowHandler)
})

test('a window listener fires for an event dispatched on document.defaultView', () => {
  const seen: string[] = []
  const handler = (event: Event): void => {
    seen.push(event.type)
  }
  window.addEventListener('resize', handler)
  expect(document.defaultView === window).toBe(true)
  document.defaultView?.dispatchEvent(new Event('resize'))
  expect(seen).toEqual(['resize'])
  window.removeEventListener('resize', handler)
})

test('window.getComputedStyle reads an element style', () => {
  const element = document.createElement('div')
  element.style.display = 'none'
  document.body.appendChild(element)
  expect(window.getComputedStyle(element).display).toBe('none')
  expect(getComputedStyle(element).display).toBe('none')
  element.remove()
})

test('requestAnimationFrame is defined as jsdom defines it and runs its callback', () => {
  expect(typeof window.requestAnimationFrame).toBe(typeof globalThis.requestAnimationFrame)
  if (typeof window.requestAnimationFrame !== 'function') return
  return new Promise<void>((resolve) => {
    const id = window.requestAnimationFrame(() => resolve())
    expect(typeof id).toBe('number')
  })
})
