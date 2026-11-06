// The Jest dialect's `mock` slice (T4.2), the whole slice as `jestExpectPolicy` is. Every value is
// checked against Jest 30.5.2 by T1.7 (B14); "mock corpus X agrees" is a claim `mock-corpus.test.ts`
// makes true, because flipping the value fails that fixture.
import type { MockPolicy } from '@provino/types'

/**
 * Jest 30.5's mock policy.
 * @public
 */
export const jestMockPolicy: MockPolicy = {
  // unverified: track-01 L198, track-04 L256 (mock corpus `fn-clear-reset-restore` agrees)
  resetTo: 'empty',
  // unverified: track-01 L199, track-04 L253 (mock corpus `fn-shape` agrees)
  defaultName: 'jest.fn()',
  // unverified: track-01 L200, track-04 L275. The mock corpus `config-default` agrees on `clear`,
  // `reset` and `restore` (the `config-*` goldens show their effect when on or off). `order` has no
  // corpus backing: no case tells one order from another (permuting it changes no observation).
  // `unstubEnvs` and `unstubGlobals` are Jest-has-none, off by definition, with no corpus backing
  // either: Jest cannot record them (an `unstub*` key under `jest` is a fixture error).
  between: {
    order: ['clear', 'reset', 'restore'],
    clear: false,
    reset: false,
    restore: false,
    unstubEnvs: false,
    unstubGlobals: false,
  },
  // unverified: track-01 L201, track-04 L261 (mock corpus `fn-new` agrees)
  classMockPrototype: 'own',
  // unverified: track-04 L254 (mock corpus `spy-methods` agrees)
  spyNameFromMethod: false,
  // unverified: track-04 L255 (mock corpus `fn-shape` agrees)
  functionName: 'mockConstructor',
  // unverified: track-04 L257 (mock corpus `fn-new` agrees)
  newCall: 'apply',
  // unverified: track-04 L258. No "agrees": with `newCall: 'apply'` a shorthand never sees
  // `new.target`, so flipping this alone changes nothing.
  valueShorthandsThrowOnNew: false,
  // unverified: track-04 L259 (mock corpus `fn-shape` agrees)
  fnOfMockReturnsSame: false,
  // unverified: track-04 L260 (mock corpus `fn-shape` agrees)
  copyStaticProps: false,
  // unverified: track-04 L262 (mock corpus `fn-recording` agrees)
  settledResults: false,
  // unverified: track-04 L263 (mock corpus `fn-shape` agrees)
  lastCallKey: 'after-first-call',
  // unverified: track-04 L264 (mock corpus `fn-clear-reset-restore` agrees)
  clearReplacesStateObject: true,
  // unverified: track-04 L265 (mock corpus `fn-shape` agrees)
  mockPropertyWritable: true,
  // unverified: track-04 L266 (mock corpus `fn-implementations` agrees)
  withImplementationReturnsMock: false,
  // unverified: track-04 L267 (mock corpus `fn-implementations` agrees)
  getImplPrefersOnce: false,
  // unverified: track-04 L268 (mock corpus `spy-methods` agrees)
  spyReportsBridgeImpl: true,
  // unverified: track-04 L269 (mock corpus `fn-shape` agrees)
  isMockAcceptsObjects: true,
  // unverified: track-04 L270 (mock corpus `spy-methods` agrees)
  spyInstall: 'assign',
  // unverified: track-04 L271. The text is jest-mock 30.5.2's `src/index.ts`, line noted per entry;
  // `{key}` and `{type}` are what it interpolates. `spy-*` for `spyInstall: 'define'` and
  // `new-shorthand` can't be reached under this policy, so they aren't here.
  messages: {
    // L1279
    'spy-primitive': 'Cannot use spyOn on a primitive value; {type} given',
    // L1284
    'spy-no-key': 'No property name supplied',
    // L1295, L1385
    'spy-missing': 'Property `{key}` does not exist in the provided object',
    // L1304-L1308
    'spy-not-a-function':
      'Cannot spy on the `{key}` property because it is not a function; {type} given instead.',
    // L1304-L1313
    'spy-not-a-function-primitive':
      "Cannot spy on the `{key}` property because it is not a function; {type} given instead. If you are trying to mock a property, use `jest.replaceProperty(object, '{key}', value)` instead.",
    // L1393
    'spy-not-configurable': 'Property `{key}` is not declared configurable',
    // L1399
    'spy-no-access-type': 'Property `{key}` does not have access type {type}',
    // Not jest-mock's: V8's text for L1354's assignment, as it prints an object from Jest's vm
    // context (mock corpus `hazard-frozen-spy` agrees).
    'spy-read-only': "Cannot assign to read only property '{key}' of object '{tag}'",
    // L1458
    'replace-primitive': 'Cannot use replaceProperty on a primitive value; {type} given',
    // L1465
    'replace-no-key': 'No property name supplied',
    // L1476
    'replace-missing': 'Property `{key}` does not exist in the provided object',
    // L1483
    'replace-not-configurable': 'Property `{key}` is not declared configurable',
    // L1489
    'replace-getter':
      "Cannot replace the `{key}` property because it has a getter. Use `jest.spyOn(object, '{key}', 'get').mockReturnValue(value)` instead.",
    // L1499
    'replace-setter':
      "Cannot replace the `{key}` property because it has a setter. Use `jest.spyOn(object, '{key}', 'set').mockReturnValue(value)` instead.",
    // L1509
    'replace-function':
      "Cannot replace the `{key}` property because it is a function. Use `jest.spyOn(object, '{key}')` instead.",
  },
}
