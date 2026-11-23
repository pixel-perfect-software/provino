// `matcherCallStack` against the real engine: the frame names it cuts at are the ones
// `createExpect` calls a matcher through, so a rename in `expect.ts` fails here.
import assert from 'node:assert/strict'
import { describe, test } from 'provino'
import { matcherCallStack } from './call-stack.ts'
import { createExpect } from './expect.ts'
import { manualCurrentTest, testPolicy, testTable } from './internal/test-support.ts'
import { createMatcherRegistry } from './slot.ts'
import { createStateSource } from './state.ts'

function engine() {
  const source = createStateSource(manualCurrentTest(), { nameSeparator: ' ', expand: false })
  return createExpect({
    policy: testPolicy,
    table: testTable(),
    source,
    registry: createMatcherRegistry(),
  })
}

type Custom = Record<'taken' | 'nested', () => void>

describe('matcherCallStack', () => {
  test('a custom matcher runs inside the frames the helper cuts at', () => {
    const expect = engine()
    let raw = ''
    expect.extend({
      taken() {
        raw = new Error().stack ?? ''
        return { pass: true, message: () => '' }
      },
    })
    ;(expect(1) as unknown as Custom).taken()
    assert.match(raw, /at __EXTERNAL_MATCHER_TRAP__ /)
    assert.match(raw, /at (?:Proxy\.)?throwingMatcher /)
  })

  test('the first frame is the user`s call, and through `expect` in a matcher, its body', () => {
    const expect = engine()
    const stacks: string[] = []
    const passed = { pass: true, message: () => '' }
    expect.extend({
      taken() {
        stacks.push(matcherCallStack(undefined)())
        return passed
      },
      nested() {
        ;(expect(1) as unknown as Custom).taken()
        return passed
      },
    })
    function usersCall() {
      ;(expect(1) as unknown as Custom).taken()
    }
    function usersNestedCall() {
      ;(expect(1) as unknown as Custom).nested()
    }
    usersCall()
    usersNestedCall()
    const [direct, nested] = stacks.map((stack) => stack.split('\n')[0] ?? '')
    assert.match(direct ?? '', /at usersCall .*call-stack\.test\.ts/)
    assert.match(
      nested ?? '',
      /at Object\.nested .*call-stack\.test\.ts|at nested .*call-stack\.test\.ts/,
    )
  })

  test('under `.resolves`/`.rejects` it is the error made at the call', () => {
    const error = new Error('at the call')
    assert.equal(matcherCallStack(error)(), error.stack)
  })
})
