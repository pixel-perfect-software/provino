// Vitest 5.0.5's words for the definition table's errors (`core.definitions.messages`, T5.9),
// copied from `packages/vitest/src/runtime/runner/fixture.ts` (and `suite.ts` for the builder's
// `onCleanup`) at v5.0.5, MIT, © Vitest's authors. Core finds each error and names it by `code`;
// this gives Vitest's class name and message. The line after each text is where it is upstream.
import type { DefinitionErrorInfo, FormatDefinitionError } from '@provino/types'

const DEPENDENCY = 'FixtureDependencyError'

/**
 * Vitest 5.0.5's name and message for a definition error: `FixtureParseError`,
 * `FixtureDependencyError`, `FixtureAccessError`, or a plain `Error` where Vitest throws one.
 * @public
 */
export const vitestFixtureMessages: FormatDefinitionError = (error) => {
  const p = error.params
  const name = error.key
  switch (error.code) {
    case 'scope-conflict':
      // fixture.ts L157
      return dependency(`The "${name}" fixture was already registered with a "${p.scope}" scope.`)
    case 'auto-conflict':
      // fixture.ts L164
      return dependency(`The "${name}" fixture was already registered as { auto: ${p.auto} }.`)
    case 'unknown-scope':
      // fixture.ts L185
      return dependency(`The "${name}" fixture has unknown scope "${p.scope}".`)
    case 'scope-in-describe':
      // fixture.ts L191
      return dependency(
        `The "${name}" fixture cannot be defined with a ${p.scope} scope${p.inherited === 'true' ? ' (inherited from the base fixture)' : ''} inside the describe block. Define it at the top level of the file instead.`,
      )
    case 'unknown-dependency':
      // fixture.ts L229
      return dependency(`The "${name}" fixture depends on unknown fixture "${p.dependency}".`)
    case 'self-without-parent':
      // fixture.ts L237
      return dependency(
        `The "${name}" fixture depends on itself, but does not have a base implementation.`,
      )
    case 'narrower-dependency':
      // fixture.ts L249
      return dependency(
        `The ${p.scope} "${name}" fixture cannot depend on a ${p.dependencyScope} fixture "${p.dependency}".`,
      )
    case 'many':
      // fixture.ts L261
      return {
        name: 'AggregateError',
        message: 'Cannot resolve user fixtures. See errors for more information.',
      }
    case 'test-scoped-in-suite-hook':
      // fixture.ts L399
      return dependency(
        `Test-scoped fixtures cannot be used inside ${p.hook} hook. ` +
          `The following fixtures are test-scoped: ${p.keys}. ` +
          `Use { scope: 'file' } or { scope: 'worker' } fixtures instead, or move the logic to ${p.alternative} hook.`,
      )
    case 'use-not-called':
      // fixture.ts L554
      return plain(
        `Fixture "${name}" returned without calling "use". Make sure to call "use" in every code path of the fixture function.`,
      )
    case 'cycle':
      // fixture.ts L594
      return plain(`Circular fixture dependency detected: ${p.cycle}`)
    case 'suite-hook-no-context':
      // fixture.ts L622
      return {
        name: 'FixtureAccessError',
        message:
          `The ${p.hook} hook uses fixtures "${p.keys}", but has no access to context. ` +
          `Did you forget to call it as "test.${p.hook}()" instead of "${p.hook}()"?\n` +
          `If you used internal "suite" task as the first argument previously, access it in the second argument instead. ` +
          `See https://vitest.dev/guide/test-context#suite-level-hooks`,
      }
    case 'not-destructured':
      // fixture.ts L698
      return {
        name: 'FixtureParseError',
        message:
          `The ${p.position} argument inside a fixture must use object destructuring pattern, e.g. ({ task } => {}). ` +
          `Instead, received "${p.received}".` +
          `${p.suiteHook === undefined ? '' : ` If you used internal "suite" task as the ${p.position} argument previously, access it in the ${p.next} argument instead.`}`,
      }
    case 'rest-element':
      // fixture.ts L716
      return {
        name: 'FixtureParseError',
        message: `Rest parameters are not supported in fixtures, received "${p.received}".`,
      }
    case 'cleanup-twice':
      // suite.ts L879
      return plain(
        'onCleanup can only be called once per fixture. ' +
          'Define separate fixtures if you need multiple cleanup functions.',
      )
    default:
      return unknownCode(error)
  }
}

function dependency(message: string): { readonly name: string; readonly message: string } {
  return { name: DEPENDENCY, message }
}

function plain(message: string): { readonly name: string; readonly message: string } {
  return { name: 'Error', message }
}

/** A code this table doesn't know (a newer core): core's own words, under Vitest's class name. */
function unknownCode(error: DefinitionErrorInfo): {
  readonly name: string
  readonly message: string
} {
  const names = { parse: 'FixtureParseError', dependency: DEPENDENCY, access: 'FixtureAccessError' }
  return { name: names[error.kind], message: error.message }
}
