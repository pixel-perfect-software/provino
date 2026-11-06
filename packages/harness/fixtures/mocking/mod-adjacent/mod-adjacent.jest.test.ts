import { who as called } from './src/called.ts'
import { who as untouched } from './src/untouched.ts'

jest.mock('./src/called.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('an adjacent __mocks__ file is not used without a mock call', () => ({ untouched }))

c('mock(path) with no factory uses the adjacent __mocks__ file', () => ({ called }))

c('requireMock uses the adjacent __mocks__ file for a module that was not mocked', () => {
  const asked = jest.requireMock('./src/asked.ts') as { who: string }
  const real = jest.requireActual('./src/asked.ts') as { who: string }
  return { mock: asked.who, actual: real.who }
})
