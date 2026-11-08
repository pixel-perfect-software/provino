import * as plain from './plain.ts'
import * as spied from './spied.ts'

vi.mock('./spied.ts', { spy: true })
vi.mock('./plain.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('spy: true keeps the real values, not the adjacent __mocks__ file', () => ({
  who: spied.who,
  call: spied.call(),
  isMock: vi.isMockFunction(spied.call),
}))

c('a bare mock uses the adjacent __mocks__ file', () => ({
  who: plain.who,
  call: plain.call(),
  isMock: vi.isMockFunction(plain.call),
}))
