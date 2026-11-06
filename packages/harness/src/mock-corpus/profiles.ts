// The `mock` policy slice for each recording profile, used to run the mocking corpus (T4.1) through
// `@provino/mock` (B13a). The Jest profile is the Jest dialect's own, so this corpus checks the
// dialect's values. Vitest's stand in for `@provino/dialect-vitest` until B14 (T1.8) builds it; the
// corpus goldens back the values they exercise, and T1.7 verifies every one, so each stays marked
// unverified (CLAUDE.md non-negotiable 2). Messages are `@vitest/spy` 5.0.5's dist text.
import { jestMockPolicy } from '@provino/dialect-jest'
import type { MockPolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

/**
 * Vitest 5.0's `mock` slice. Moves to `@provino/dialect-vitest` with T1.8 (B14a).
 * @public
 */
export const vitestMockPolicy: MockPolicy = {
  // unverified: track-01 L198, track-04 L256 (mock corpus `fn-clear-reset-restore` agrees)
  resetTo: 'original-impl',
  // unverified: track-01 L199, track-04 L253
  defaultName: 'vi.fn()',
  // unverified: track-01 L200, track-04 L275 (mock corpus `config-default` and `config-no-clear`
  // agree on `clear`; `config-reset`, `config-restore`, `config-unstub-envs` and
  // `config-unstub-globals` on their flags. `order` has no corpus backing: no case tells one order
  // from another)
  between: {
    order: ['restore', 'reset', 'clear', 'unstubEnvs', 'unstubGlobals'],
    clear: true,
    reset: false,
    restore: false,
    unstubEnvs: false,
    unstubGlobals: false,
  },
  // unverified: track-01 L201, track-04 L261 (mock corpus `fn-new` agrees)
  classMockPrototype: 'chain-to-impl',
  // unverified: track-04 L254
  spyNameFromMethod: true,
  // unverified: track-04 L255
  functionName: 'impl-or-Mock',
  // unverified: track-04 L257
  newCall: 'construct',
  // unverified: track-04 L258
  valueShorthandsThrowOnNew: true,
  // unverified: track-04 L259
  fnOfMockReturnsSame: true,
  // unverified: track-04 L260
  copyStaticProps: true,
  // unverified: track-04 L262
  settledResults: true,
  // unverified: track-04 L263
  lastCallKey: 'always',
  // unverified: track-04 L264
  clearReplacesStateObject: false,
  // unverified: track-04 L265
  mockPropertyWritable: false,
  // unverified: track-04 L266
  withImplementationReturnsMock: true,
  // unverified: track-04 L267
  getImplPrefersOnce: true,
  // unverified: track-04 L268
  spyReportsBridgeImpl: false,
  // unverified: track-04 L269
  isMockAcceptsObjects: false,
  // unverified: track-04 L270
  spyInstall: 'define',
  // unverified: track-04 L271 (`@vitest/spy` 5.0.5 dist text)
  messages: {
    'spy-nullish':
      'The vi.spyOn() function could not find an object to spy upon. The first argument must be defined.',
    'spy-define-primitive': 'Vitest cannot spy on a primitive value.',
    'spy-define-missing': 'The property "{key}" is not defined on the {type}.',
    'spy-define-not-a-function': 'vi.spyOn() can only spy on a function. Received {type}.',
    'spy-namespace':
      'Cannot spy on export "{key}". Module namespace is not configurable in ESM. See: https://vitest.dev/guide/mocking/modules#mocking-a-module',
    'new-shorthand':
      'Cannot use `{name}` when called with `new`. Use `mockImplementation` with a `class` keyword instead. See https://vitest.dev/api/mock#class-support for more information.',
    'new-not-a-constructor':
      "[vitest] The {name} mock did not use 'function' or 'class' in its implementation, see https://vitest.dev/api/vi#vi-spyon for examples.",
  },
}

/** The `mock` policy a recording profile stands for. */
export const mockPolicyFor: Readonly<Record<FixtureProfile, MockPolicy>> = {
  jest: jestMockPolicy,
  vitest: vitestMockPolicy,
  'vitest-list': vitestMockPolicy,
}
