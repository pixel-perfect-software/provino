import defaultExport, * as everything from './actual.ts'
import { named, other } from './actual.ts'

jest.mock('./actual.ts', () => ({
  ...jest.requireActual('./actual.ts'),
  named: 'mock-named',
}))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c(
  'a spread of the actual module: overridden and kept named exports, and the default import',
  () => ({
    named,
    other,
    defaultExport,
    keys: Object.keys(everything),
  }),
)
