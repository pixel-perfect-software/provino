import { kept } from './keep-real-util.ts'
import { other } from './other.ts'

jest.enableAutomock()

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a module matching the pattern stays real', () => ({
  isMock: jest.isMockFunction(kept),
  result: kept(),
}))

c('a module that does not match is automocked', () => ({
  isMock: jest.isMockFunction(other),
  result: other(),
}))
