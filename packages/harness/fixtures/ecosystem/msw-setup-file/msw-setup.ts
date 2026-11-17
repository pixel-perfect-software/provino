// The server every test file shares, made in a setupFilesAfterEnv module.
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.get('https://api.example.invalid/user', () => HttpResponse.json({ name: 'ada' })),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
