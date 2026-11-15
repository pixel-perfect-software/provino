type JestWhen = typeof import('jest-when')

// Loaded in the first test, so jest-when's load-time trick (`__capture_equals__`, then
// `state.assertionCalls = 0`) lands inside a test that counts its assertions.
const load = (): JestWhen => require('jest-when') as JestWhen

describe('when(fn)', () => {
  it('counts one assertion after the load-time reset', () => {
    expect.assertions(1)
    expect(1).toBe(1)
    const { when } = load()
    const fn = jest.fn()
    when(fn).calledWith(1).mockReturnValue('one')
    expect(fn(1)).toBe('one')
  })

  it('drops the capture matcher from the matchers object, not its asymmetric form', () => {
    load()
    const slot = (globalThis as unknown as Record<symbol, { matchers: object }>)[
      Symbol.for('$$jest-matchers-object')
    ]
    expect(Object.hasOwn(slot?.matchers ?? {}, '__capture_equals__')).toBe(false)
    expect(typeof (expect(1) as unknown as Record<string, unknown>).__capture_equals__).toBe(
      'undefined',
    )
    expect(typeof (expect as unknown as Record<string, unknown>).__capture_equals__).toBe(
      'function',
    )
  })

  it('answers calledWith on a literal and on expect.anything()', () => {
    const { when } = load()
    const fn = jest.fn()
    when(fn).calledWith(1).mockReturnValue('one')
    when(fn).calledWith(expect.anything(), 'b').mockReturnValue('any-b')
    expect(fn(1)).toBe('one')
    expect(fn({ x: 1 }, 'b')).toBe('any-b')
    expect(fn(2)).toBeUndefined()
  })

  it('falls through to mockImplementation', () => {
    const { when } = load()
    const fn = jest.fn().mockImplementation((value: number) => `default ${value}`)
    when(fn).calledWith(1).mockReturnValue('one')
    expect(fn(1)).toBe('one')
    expect(fn(5)).toBe('default 5')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('leaves one when-mock uncalled for the module registry', () => {
    const { when } = load()
    const unused = jest.fn()
    when(unused).expectCalledWith('never').mockReturnValue('x')
    expect(unused).not.toHaveBeenCalled()
  })
})
