jest.mock('./above.ts', () => ({ who: 'mock-above' }))

const above = require('./above.ts') as { who: string }
const below = require('./below.ts') as { who: string }
const helper = require('./helper.ts') as { depWho: string }
const dep = require('./dep.ts') as { who: string }

jest.mock('./below.ts', () => ({ who: 'mock-below' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('jest.mock written above the require applies', () => above)

c('jest.mock written below the require is hoisted above it', () => below)

c("a helper's own jest.mock hoists above its require, and applies to the test file too", () => ({
  seenByHelper: helper.depWho,
  seenByTestFile: dep.who,
}))
