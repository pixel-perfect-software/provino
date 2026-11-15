const { any, anyString, mock } =
  require('jest-mock-extended') as typeof import('jest-mock-extended')

interface Store {
  get(key: string): number | undefined
  put(key: string, value: number): void
}

describe('mock<T>()', () => {
  it('answers calledWith on a literal and nothing else', () => {
    const store = mock<Store>()
    store.get.calledWith('a').mockReturnValue(1)
    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBeUndefined()
    expect(store.get).toHaveBeenCalledTimes(2)
  })

  it('answers calledWith on any() and anyString()', () => {
    const store = mock<Store>()
    store.get.calledWith(anyString()).mockReturnValue(7)
    store.put.calledWith(any(), any()).mockImplementation(() => undefined)
    store.put('x', 1)
    expect(store.get('anything')).toBe(7)
    expect(store.put).toHaveBeenCalledWith('x', 1)
  })

  it('fails toHaveBeenCalledWith on a member', () => {
    const store = mock<Store>()
    store.put('a', 1)
    expect(store.put).toHaveBeenCalledWith('a', 2)
  })
})
