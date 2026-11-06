import { EOL } from 'node:os'
import autoLib from 'auto-lib'
import * as manualLib from 'manual-lib'
import { compute as keptCompute } from './kept.ts'
import { compute as localCompute } from './local.ts'

jest.enableAutomock()
jest.unmock('./kept.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('enableAutomock mocks a local module, and an unmocked path stays real', () => ({
  local: localCompute(),
  localIsMock: jest.isMockFunction(localCompute),
  kept: keptCompute(),
  keptIsMock: jest.isMockFunction(keptCompute),
}))

c(
  'enableAutomock mocks an installed package, uses its root __mocks__ file, and leaves core alone',
  () => ({
    auto: autoLib.run(),
    autoIsMock: jest.isMockFunction(autoLib.run),
    manual: manualLib.run(),
    manualIsMock: jest.isMockFunction(manualLib.run),
    coreEol: EOL,
  }),
)
