// T6.7: shared examples and shared context. A group adds a key with `.let` and reads the caller's
// override; `itBehavesLike` opens a nested describe, `includeExamples` and `includeContext` register
// into the current one.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LazyError } from './errors.ts'
import { createWorld } from './internal/test-support.ts'

function code(error: unknown): string | undefined {
  return error instanceof LazyError ? error.code : undefined
}

describe('shared examples', () => {
  test('a group adds a key with .let and reads the caller override', async () => {
    const world = createWorld()
    const seen: Array<[string, number, number]> = []
    const group = world.runtime.sharedExamples<{ subject: number }, [label: string]>(
      'a number',
      ($, label) => {
        const $g = $.let('double', ({ subject }) => subject * 2)
        world.test(`${label} doubles`, () => {
          seen.push([label, $g.subject, $g.double])
        })
      },
    )
    const outcome = await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('subject', () => 1)
      world.runtime.itBehavesLike(group, $, 'plain')
      world.describe('overridden', () => {
        $.override('subject', () => 5)
        world.runtime.itBehavesLike(group, $, 'big')
      })
    })
    assert.equal(outcome.collectError, undefined)
    assert.deepEqual(
      outcome.tests.map((t) => t.error),
      [undefined, undefined],
    )
    assert.deepEqual(seen, [
      ['plain', 1, 2],
      ['big', 5, 10],
    ])
  })

  test('itBehavesLike nests a describe named "behaves like <name>"', async () => {
    const world = createWorld()
    const suites: Array<string | undefined> = []
    const group = world.runtime.sharedExamples<{ a: number }>('thing', () => {
      suites.push(world.host.collecting()?.name)
    })
    await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('a', () => 1)
      world.runtime.itBehavesLike(group, $)
      world.runtime.includeExamples(group, $)
    })
    assert.deepEqual(suites, ['behaves like thing', 'a.test.ts'])
  })

  test('includeExamples registers into the current describe, so the group sees its override', async () => {
    const world = createWorld()
    const seen: number[] = []
    const group = world.runtime.sharedExamples<{ n: number }>('n', ($) => {
      world.test('reads', () => {
        seen.push($.n)
      })
    })
    await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('n', () => 1)
      world.runtime.includeExamples(group, $)
      world.describe('d', () => {
        $.override('n', () => 2)
        world.runtime.includeExamples(group, $)
      })
    })
    assert.deepEqual(seen, [1, 2])
  })

  test('a key the group adds twice in one describe is LAZY_DUPLICATE', async () => {
    const world = createWorld()
    const group = world.runtime.sharedExamples<{ n: number }>('n', ($) => {
      $.let('extra', () => 1)
    })
    const outcome = await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('n', () => 1)
      world.runtime.includeExamples(group, $)
      world.runtime.includeExamples(group, $)
    })
    assert.equal(code(outcome.collectError), 'LAZY_DUPLICATE')
  })

  test('a value that is not a group is LAZY_INVALID', async () => {
    const world = createWorld()
    const outcome = await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('n', () => 1)
      world.runtime.itBehavesLike({ name: 'fake' } as never, $)
    })
    assert.equal(code(outcome.collectError), 'LAZY_INVALID')
  })

  test('using a group inside a test throws LAZY_NOT_COLLECTING', async () => {
    const world = createWorld()
    const group = world.runtime.sharedExamples<{ n: number }>('n', () => {})
    let thrown: unknown
    await world.runFile('a.test.ts', () => {
      const $ = world.lazy.let('n', () => 1)
      world.test('t', () => {
        try {
          world.runtime.includeExamples(group, $)
        } catch (error) {
          thrown = error
        }
      })
    })
    assert.equal(code(thrown), 'LAZY_NOT_COLLECTING')
  })

  test('a group made by another runtime still runs (the body sits under a Symbol.for key)', async () => {
    const world = createWorld()
    const other = createWorld()
    const seen: number[] = []
    const group = other.runtime.sharedExamples<{ n: number }>('n', ($) => {
      world.test('t', () => {
        seen.push($.n)
      })
    })
    await world.runFile('a.test.ts', () => {
      world.runtime.includeExamples(
        group,
        world.lazy.let('n', () => 7),
      )
    })
    assert.deepEqual(seen, [7])
  })
})

describe('shared context', () => {
  test('includeContext adds keys that read the caller keys and its overrides', async () => {
    const world = createWorld()
    const seen: Array<[number, number]> = []
    const context = world.runtime.sharedContext<{ db: number }, { repo: number }>('repo', ($) =>
      $.let('repo', ({ db }) => db + 100),
    )
    await world.runFile('a.test.ts', () => {
      const $db = world.lazy.let('db', () => 1)
      const $ = world.runtime.includeContext($db, context)
      world.test('base', () => {
        seen.push([$.db, $.repo])
      })
      world.describe('d', () => {
        $db.override('db', () => 2)
        world.test('over', () => {
          seen.push([$.db, $.repo])
        })
      })
    })
    assert.deepEqual(seen, [
      [1, 101],
      [2, 102],
    ])
  })

  test('a context body that returns no handle is LAZY_INVALID', async () => {
    const world = createWorld()
    const context = world.runtime.sharedContext('bad', () => undefined as never)
    const outcome = await world.runFile('a.test.ts', () => {
      world.runtime.includeContext(
        world.lazy.let('db', () => 1),
        context as never,
      )
    })
    assert.equal(code(outcome.collectError), 'LAZY_INVALID')
  })
})
