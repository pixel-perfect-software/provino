import { who as gone } from './gone.ts'

jest.mock('./gone.ts', () => ({ who: 'mock-gone' }))
jest.unmock('./gone.ts')
jest.mock('./later.ts', () => ({ who: 'mock-later' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('mock then unmock of one path leaves the real module', () => ({ gone }))

c('a non-hoisted unmock then resetModules loads the real module again', () => {
  const mocked = require('./later.ts') as { who: string }
  jest.dontMock('./later.ts')
  jest.resetModules()
  const real = require('./later.ts') as { who: string }
  return { mocked: mocked.who, real: real.who }
})
