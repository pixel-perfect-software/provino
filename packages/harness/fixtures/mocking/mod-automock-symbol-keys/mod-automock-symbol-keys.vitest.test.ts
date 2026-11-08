import { tools } from './tools.ts'

vi.mock('./tools.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const TOOL = Symbol.for('mod-automock-symbol-keys.tool')
const symbolic = tools as unknown as Record<symbol, () => unknown>

c('the plain method is a mock', () => ({
  isMock: vi.isMockFunction(tools.plain),
  result: tools.plain(),
}))

c('the symbol-keyed method', () => ({
  present: TOOL in tools,
  isMock: vi.isMockFunction(symbolic[TOOL]),
}))

c('the symbols the object holds', () => ({
  count: Object.getOwnPropertySymbols(tools).length,
}))
