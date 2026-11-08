// A setupFiles module: which of the runner's globals exist here. `typeof` of a name nothing declares
// is 'undefined', so the list is every name, Jest's and Vitest's, that something does declare.
{
  const kinds: Record<string, string> = {
    afterAll: typeof afterAll,
    afterEach: typeof afterEach,
    aroundAll: typeof aroundAll,
    aroundEach: typeof aroundEach,
    assert: typeof assert,
    assertType: typeof assertType,
    beforeAll: typeof beforeAll,
    beforeEach: typeof beforeEach,
    chai: typeof chai,
    describe: typeof describe,
    expect: typeof expect,
    expectTypeOf: typeof expectTypeOf,
    fdescribe: typeof fdescribe,
    fit: typeof fit,
    it: typeof it,
    jest: typeof jest,
    onTestFailed: typeof onTestFailed,
    onTestFinished: typeof onTestFinished,
    suite: typeof suite,
    test: typeof test,
    vi: typeof vi,
    vitest: typeof vitest,
    xdescribe: typeof xdescribe,
    xit: typeof xit,
    xtest: typeof xtest,
  }
  const defined = Object.keys(kinds).filter((name) => kinds[name] !== 'undefined')
  trace(JSON.stringify({ id: 'globals in a setupFiles module', value: defined }))
}
