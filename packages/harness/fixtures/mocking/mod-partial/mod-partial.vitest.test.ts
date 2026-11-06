import defaultExport, * as everything from './actual.ts'
import { named, other } from './actual.ts'

vi.mock('./actual.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
