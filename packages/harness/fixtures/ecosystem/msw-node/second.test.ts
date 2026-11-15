import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.get('https://api.example.invalid/y', () => HttpResponse.text('second')),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

it('intercepts with the second file’s own server', async () => {
  expect(await (await fetch('https://api.example.invalid/y')).text()).toBe('second')
  await expect(fetch('https://api.example.invalid/x')).rejects.toThrow()
})
