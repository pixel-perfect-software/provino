// Two hooks of each kind on one level, A slower than B. Declaration order runs A then B, reverse
// order B then A, parallel starts both before either ends.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Kind = 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll'
const KINDS: readonly Kind[] = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll']
const log: Record<Kind, string[]> = { beforeAll: [], beforeEach: [], afterEach: [], afterAll: [] }

const orderOf = (steps: readonly string[]): string => {
  const text = steps.join(', ')
  if (text === 'start A, end A, start B, end B') return 'declaration'
  if (text === 'start B, end B, start A, end A') return 'reverse'
  if (steps[0]?.startsWith('start') === true && steps[1]?.startsWith('start') === true) {
    return 'parallel'
  }
  return text
}

const hooks = { beforeAll, beforeEach, afterEach, afterAll }

describe('two hooks of each kind', () => {
  for (const kind of KINDS) {
    hooks[kind](async () => {
      log[kind].push('start A')
      await sleep(40)
      log[kind].push('end A')
    })
    hooks[kind](() => {
      log[kind].push('start B')
      log[kind].push('end B')
    })
  }
  test('t', () => {})
})

let nestedRan = false
describe('a failing beforeAll', () => {
  beforeAll(() => {
    throw new Error('beforeAll failed')
  })
  describe('nested', () => {
    beforeAll(() => {
      nestedRan = true
    })
    beforeEach(() => {
      nestedRan = true
    })
    test('t', () => {})
  })
})

afterAll(async () => {
  for (const kind of KINDS) {
    await observe(`core.hookOrder.${kind}`, () => orderOf(log[kind]))
  }
  await observe('core.hooks.nestedHooksAfterBeforeAllError', () => (nestedRan ? 'run' : 'skip'))
})
