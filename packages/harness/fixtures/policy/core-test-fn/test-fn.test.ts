// What a test function is given and may be. Each `observe` id is the policy key it shows; the
// value is computed here, from what the real runner did.
let generatorRan = false
// biome-ignore lint/correctness/useYield: the test is a generator, whatever it yields
test('a generator function', function* () {
  generatorRan = true
} as unknown as () => void)

let argumentCount = -1
test('a function that declares no parameter', function () {
  // biome-ignore lint/complexity/noArguments: what the runner passed, whatever the function declares
  argumentCount = arguments.length
})

test('a function that returns a value', () => 42 as unknown as undefined)

describe('outer', () => {
  describe('inner', () => {
    test('t', () =>
      observe('core.nameSeparator', () => {
        const name = String(expect.getState().currentTestName)
        return name.slice('outer'.length, name.indexOf('inner'))
      }))
  })
})

const LONG = 'x'.repeat(60)
test.each([{ value: LONG }])('each $value', () =>
  observe('core.eachTitleTruncate', () => {
    const name = String(expect.getState().currentTestName)
    const shown = name.slice('each '.length).replace(/^["']|["']$/g, '')
    return shown === LONG ? null : shown.length
  }),
)

afterAll(async () => {
  await observe('core.allowGeneratorFns', () => generatorRan)
  await observe('core.firstArg', () => (argumentCount === 0 ? 'done-if-arity' : 'context'))
})
