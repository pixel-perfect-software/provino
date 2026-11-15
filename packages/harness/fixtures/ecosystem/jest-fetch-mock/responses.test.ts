// The larger file, so a runner with no history runs it first.
import type { FetchMock } from 'jest-fetch-mock'

const fetchMock = (globalThis as unknown as { fetchMock: FetchMock }).fetchMock

// The package's documented answer to `resetMocks: true`: re-arm its defaults before each test.
beforeEach(() => fetchMock.resetMocks())

describe('fetchMock responses', () => {
  it('serves mockResponseOnce, then mockReject', async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ id: 1 }), { status: 201 })
    const first = await fetch('https://api.example.invalid/users/1')
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ id: 1 })
    fetchMock.mockReject(new Error('offline'))
    await expect(fetch('https://api.example.invalid/users/2')).rejects.toThrow('offline')
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.example.invalid/users/1',
      'https://api.example.invalid/users/2',
    ])
  })

  it('starts each test with no calls and the default response', async () => {
    expect(fetchMock.mock.calls).toHaveLength(0)
    expect(await (await fetch('https://api.example.invalid/plain')).text()).toBe('')
  })

  it('serves mockResponses in order', async () => {
    fetchMock.mockResponses('one', 'two')
    const one = await fetch('https://api.example.invalid/a')
    const two = await fetch('https://api.example.invalid/b')
    expect([await one.text(), await two.text()]).toEqual(['one', 'two'])
  })
})
