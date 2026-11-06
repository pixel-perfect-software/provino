import { who as called } from './src/called.ts'
import { who as untouched } from './src/untouched.ts'

vi.mock('./src/called.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('an adjacent __mocks__ file is not used without a mock call', () => ({ untouched }))

c('mock(path) with no factory uses the adjacent __mocks__ file', () => ({ called }))

c('requireMock uses the adjacent __mocks__ file for a module that was not mocked', async () => {
  const asked = await vi.importMock<{ who: string }>('./src/asked.ts')
  const real = await vi.importActual<{ who: string }>('./src/asked.ts')
  return { mock: asked.who, actual: real.who }
})
