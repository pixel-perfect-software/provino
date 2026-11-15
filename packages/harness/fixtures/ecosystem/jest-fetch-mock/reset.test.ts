import type { FetchMock } from 'jest-fetch-mock'

const fetchMock = (globalThis as unknown as { fetchMock: FetchMock }).fetchMock

describe('resetMocks in the second file', () => {
  it('has no default implementation', () => {
    expect(fetchMock.getMockImplementation()).toBeUndefined()
    expect(fetch('https://api.example.invalid/x')).toBeUndefined()
  })

  it('counts this test’s calls only', async () => {
    fetchMock.mockResponseOnce('ok')
    expect(await (await fetch('https://api.example.invalid/y')).text()).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
