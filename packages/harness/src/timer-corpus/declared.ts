// The timer corpus's declared divergences (B17a): the cases whose observation differs from the
// golden. `timer-corpus.test.ts` holds a run to this allowance, as the mock corpus does to its own.
import type { Declared } from '../mock-corpus/compare.ts'

/** Provino has no legacy fake timers (Q4.1, B17a gap 2): the install reports `unsupported`. */
const LEGACY = {
  divergence: 'DV-B17a-legacy-timers',
  line: (id: string): string =>
    `{"id":"${id}","threw":{"$":"error","name":"Error","message":"Provino does not implement legacy fake timers (\`legacyFakeTimers: true\`). Use the modern fake timers: drop the option, or \`doNotFake\` the globals you need real."}}`,
}

/**
 * The cases whose observation differs from the golden, by `fixture (profile) case`. The check fails
 * on a difference not listed here, on a listed case that now matches the golden, and on a listed
 * case whose line is not the one pinned here, so an entry cannot go stale or widen.
 */
export const TIMER_DECLARED: Readonly<Record<string, Declared>> = {
  'mocking/timers-legacy (jest) useFakeTimers({ legacyFakeTimers: true }) installs this implementation':
    {
      divergence: LEGACY.divergence,
      line: LEGACY.line('useFakeTimers({ legacyFakeTimers: true }) installs this implementation'),
    },
  'mocking/timers-legacy (jest) a legacy install does not stop a later modern one': {
    divergence: LEGACY.divergence,
    line: LEGACY.line('a legacy install does not stop a later modern one'),
  },
}
