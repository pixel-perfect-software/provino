// The two ends of the policy space, for this package's tests: `neutralPolicy.mock`, and a policy
// with every key flipped the other way. This package's dev dependency doesn't include a dialect, and
// the shape below isn't a claim about any runner: `@provino/dialect-jest` and the corpus check own
// that (dialect.test.ts, mock-corpus.test.ts).
import { neutralPolicy } from '@provino/policy'
import type { MockPolicy } from '@provino/types'

export const neutral: MockPolicy = neutralPolicy.mock

export const flipped: MockPolicy = {
  resetTo: 'empty',
  defaultName: 'flipped.fn()',
  between: {
    order: ['clear', 'reset', 'restore'],
    clear: false,
    reset: false,
    restore: false,
    unstubEnvs: false,
    unstubGlobals: false,
  },
  classMockPrototype: 'own',
  spyNameFromMethod: false,
  functionName: 'mockConstructor',
  newCall: 'apply',
  valueShorthandsThrowOnNew: false,
  fnOfMockReturnsSame: false,
  copyStaticProps: false,
  settledResults: false,
  lastCallKey: 'after-first-call',
  clearReplacesStateObject: true,
  mockPropertyWritable: true,
  withImplementationReturnsMock: false,
  getImplPrefersOnce: false,
  spyReportsBridgeImpl: true,
  isMockAcceptsObjects: true,
  spyInstall: 'assign',
  messages: { 'spy-missing': 'flipped text for `{key}`' },
}

export const policies: ReadonlyArray<readonly [name: string, policy: MockPolicy]> = [
  ['neutral', neutral],
  ['flipped', flipped],
]
