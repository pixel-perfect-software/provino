// The larger file, so a runner with no history runs it first.
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.get('https://api.example.invalid/x', () => HttpResponse.json({ name: 'x' })),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('msw/node', () => {
  it('intercepts the global fetch', async () => {
    const response = await fetch('https://api.example.invalid/x')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'x' })
  })

  it('takes a runtime handler from server.use', async () => {
    server.use(
      http.get('https://api.example.invalid/x', () => new HttpResponse(null, { status: 503 })),
    )
    expect((await fetch('https://api.example.invalid/x')).status).toBe(503)
  })

  it('is back to the initial handler after resetHandlers', async () => {
    expect(await (await fetch('https://api.example.invalid/x')).json()).toEqual({ name: 'x' })
  })

  it('errors on an unhandled request', async () => {
    await expect(fetch('https://api.example.invalid/unhandled')).rejects.toThrow()
  })
})
