import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isModuleRef } from './module-ref.ts'
import { neutralPolicy } from './neutral.ts'

// The neutral policy is Provino's own (no ground truth applies), so its choices are pinned here.
// Changing one is a behaviour change for every project with no dialect: say why in the commit.
const pinned: Readonly<Record<string, unknown>> = {
  'core.hookOrder': {
    beforeAll: 'declaration',
    beforeEach: 'declaration',
    afterEach: 'reverse',
    afterAll: 'reverse',
  },
  'core.firstArg': 'context',
  'core.nameSeparator': ' > ',
  'core.allowGeneratorFns': false,
  'core.missingTestFn': 'todo',
  'core.asyncDescribe': 'throw',
  'core.nonPromiseReturn': 'fail',
  'core.allowOnly': 'not-in-ci',
  'core.unawaitedAsyncAssertion': 'fail',
  'core.injectGlobals': false,
  'core.hooks.beforeAllError': 'attach-to-tests',
  'core.focus.insideSkip': 'skipped',
  'mock.resetTo': 'original-impl',
  'mock.between': {
    order: ['restore', 'reset', 'clear', 'unstubEnvs', 'unstubGlobals'],
    clear: true,
    reset: false,
    restore: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
  'timers.toFakeDefault': 'all-but-microtasks',
  'module.factoryShape': 'namespace',
  'module.missingFactoryExport': 'throw',
  'module.rootMocksAutoApply': false,
  // No text of its own: `@provino/mock` supplies the neutral wording for every module message code.
  'module.messages': {},
  'snapshot.header': '// Provino Snapshot v1',
  'expect.errorShape': 'assertion-error',
  'orchestrator.isolationDefault': {
    default: 'registry',
    byEnvironment: { jsdom: 'realm', 'happy-dom': 'realm' },
  },
  'orchestrator.bail': { checkAfter: 'test' },
  // B23c: no neutral changed-files provider; the lexer reads the graph; a change to the project's
  // own inputs reruns it; a recorded graph beats a rescan (all ours).
  'orchestrator.changedFiles': null,
  'orchestrator.affected': {
    extractor: null,
    mockEdges: { dir: '__mocks__', adjacent: true, byName: false },
    invalidateAll: 'project-inputs',
    graph: 'recorded-then-static',
    conditions: 'environment',
  },
  // B23b: V8 coverage goes through the AST converter (built in B25) and counts no calls.
  'coverage.v8Conversion': 'ast',
  'coverage.v8HitCounts': false,
  'coverage.istanbulVariable': '__coverage__',
  'coverage.thresholdMessages': {
    belowMinimum:
      'Coverage for {metric} ({actual}%) does not meet "{name}" threshold ({threshold}%)',
    aboveMaximumUncovered:
      'Uncovered count for {metric} ({actual}) exceeds {name} threshold ({threshold})',
    notFound: 'Coverage data for {path} was not found.',
  },
}

function read(path: string): unknown {
  let value: unknown = neutralPolicy
  for (const key of path.split('.')) value = (value as Readonly<Record<string, unknown>>)[key]
  return value
}

test('the pinned neutral choices hold', () => {
  for (const [path, expected] of Object.entries(pinned))
    assert.deepEqual(read(path), expected, path)
})

test('every behaviour key is an absolute ModuleRef into @provino/policy/behaviours or null', () => {
  const behaviours = [
    neutralPolicy.core.formatEachTitle,
    neutralPolicy.snapshot.key,
    neutralPolicy.orchestrator.environmentConditions,
  ]
  for (const ref of behaviours) {
    assert.ok(isModuleRef(ref))
    // D21: absolute, so a worker needs no package resolution to load it.
    assert.equal(ref.module, import.meta.resolve('@provino/policy/behaviours'))
    assert.match(ref.module, /^file:\/\//)
  }
  assert.equal(neutralPolicy.core.orderHooks, null)
  assert.equal(neutralPolicy.snapshot.resolvePath, null)
  assert.equal(neutralPolicy.expect.matcherTable, null)
})

test('it is deeply frozen', () => {
  const frozen = (value: unknown): boolean =>
    value === null ||
    typeof value !== 'object' ||
    value instanceof RegExp ||
    (Object.isFrozen(value) && Object.values(value).every(frozen))
  assert.ok(frozen(neutralPolicy))
})
