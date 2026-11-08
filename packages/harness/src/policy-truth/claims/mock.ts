// The evidence for the `mock` slice (T1.7). The mock corpus (B13a) runs `@provino/mock` under each
// value against the `fixtures/mocking/` goldens recorded from both runners; a flip that changes a
// case is caught there. `policy/defaults` records the per-test cleanup defaults.
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'

const mock = (...fixtures: readonly string[]) =>
  corpus('mock', ...fixtures.map((name) => `mocking/${name}`))

export const mockClaims: Claims = {
  'mock.resetTo': mock('config-all', 'fn-clear-reset-restore'),
  'mock.defaultName': mock('fn-shape'),
  'mock.between.order': pending(
    'Tyler',
    'no case tells one order of clear, reset and restore from another: they commute in both runners, so a reversed order changes no observation',
  ),
  'mock.between.clear': [mock('config-default'), golden('defaults')],
  'mock.between.reset': each(
    [mock('config-clear', 'config-reset'), golden('defaults')],
    [mock('config-default'), golden('defaults')],
  ),
  'mock.between.restore': each(
    [mock('config-clear', 'config-restore'), golden('defaults')],
    [mock('config-default'), golden('defaults')],
  ),
  'mock.between.unstubEnvs': each(
    own(
      'packages/dialect-jest/src/runtime/globals.test.ts',
      'stubEnv',
      'Jest has no stubEnv, so nothing is ever unstubbed: false says only that',
    ),
    [mock('config-unstub-envs'), golden('defaults')],
  ),
  'mock.between.unstubGlobals': each(
    own(
      'packages/dialect-jest/src/runtime/globals.test.ts',
      'stubGlobal',
      'Jest has no stubGlobal, so nothing is ever unstubbed: false says only that',
    ),
    [mock('config-unstub-globals'), golden('defaults')],
  ),
  'mock.classMockPrototype': mock('fn-new'),
  'mock.spyNameFromMethod': mock('spy-methods'),
  'mock.functionName': mock('fn-shape'),
  'mock.newCall': mock('fn-implementations', 'fn-new'),
  'mock.valueShorthandsThrowOnNew': each(
    inert(
      'mock.newCall',
      'apply',
      'under apply a value shorthand never sees new.target, so the key has nothing to decide',
    ),
    mock('fn-implementations'),
  ),
  'mock.fnOfMockReturnsSame': mock('fn-shape'),
  'mock.copyStaticProps': mock('fn-shape'),
  'mock.settledResults': mock('fn-recording'),
  'mock.lastCallKey': mock('fn-shape', 'fn-recording'),
  'mock.clearReplacesStateObject': mock('fn-clear-reset-restore'),
  'mock.mockPropertyWritable': mock('fn-shape'),
  'mock.withImplementationReturnsMock': mock('fn-implementations'),
  'mock.getImplPrefersOnce': mock('fn-implementations'),
  'mock.spyReportsBridgeImpl': mock('spy-methods', 'config-reset'),
  'mock.isMockAcceptsObjects': mock('fn-shape'),
  'mock.spyInstall': mock('hazard-frozen-spy'),
  'mock.messages': each(
    mock('spy-methods', 'spy-accessors', 'spy-errors', 'jest-extras', 'hazard-frozen-spy'),
    mock('spy-methods', 'spy-accessors', 'spy-errors', 'fn-implementations'),
  ),
  // A spy on a module namespace is refused only by real ESM namespaces.
  'mock.messages.spy-namespace': pending(
    'B13c',
    "the fake loader's namespaces can be spied on, so no run reaches Vitest's refusal; the shipped loader's cannot",
  ),
}
