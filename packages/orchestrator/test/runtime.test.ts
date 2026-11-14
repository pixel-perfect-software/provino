// The real runtime behind `worker/main`, over an inline worker (the transports are B09's, and
// `runtime-transports.test.ts` runs the real entry over each kind). The fixtures stand in for what
// a project supplies by ref: an environment that records its calls, a matcher table, and a globals
// factory. They write to `globalThis.__trace`, which an inline worker shares with the test.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MATCHERS_SLOT } from '@provino/expect'
import { createDepsTable } from '@provino/orchestrator'
import { moduleRef } from '@provino/policy'
import type {
  FileJob,
  GlobalsFactory,
  ModuleMapperFactory,
  PolicyOverrides,
  RuntimeEventOf,
  TaskId,
  WorkerEvent,
} from '@provino/types'
import {
  eventsOf,
  fixture,
  runJobs,
  runtimeConfig,
  runtimeJob,
  runtimePolicy,
  trackedProjects,
} from './support.ts'

const project = trackedProjects()

/** `test-end` results by test name (the last path segment of the full name). */
function resultsByName(events: readonly WorkerEvent[]): Map<string, RuntimeEventOf<'test-end'>> {
  const names = new Map<TaskId, string>()
  for (const event of eventsOf(events, 'file-collect-end')) {
    for (const task of event.tasks) if (task.type === 'test') names.set(task.id, task.name)
  }
  return new Map(
    eventsOf(events, 'test-end').map((event) => [names.get(event.id) ?? event.id, event]),
  )
}

const states = (events: readonly WorkerEvent[]): Record<string, string> =>
  Object.fromEntries([...resultsByName(events)].map(([name, event]) => [name, event.result.state]))

describe('setup order', () => {
  const files = {
    'setup.js': "__trace.push('setupFiles: describe is ' + typeof describe)",
    'after-env.js': [
      "__trace.push('setupFilesAfterEnv: expect is ' + typeof expect)",
      "beforeEach(() => { __trace.push('beforeEach from setupFilesAfterEnv') })",
    ].join('\n'),
    'a.test.js': ["__trace.push('file a')", "test('one', () => { __trace.push('test one') })"].join(
      '\n',
    ),
    'b.test.js': ["__trace.push('file b')", "test('two', () => {})"].join('\n'),
  }

  it('prepares the environment once, builds the globals once, then per file: setup, setupFiles, setupFilesAfterEnv, the file, the tests, teardown', async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir, {
      environmentOptions: { label: 'x' },
      setupFiles: [p.path('setup.js')],
      setupFilesAfterEnv: [p.path('after-env.js')],
    })
    const trace: string[] = []
    const run = await runJobs({
      config,
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    assert.deepEqual(trace, [
      'env:prepare {"label":"x"}',
      'globals:factory',
      'env:setup file a.test.js {"prepared":true}',
      'setupFiles: describe is function',
      'setupFilesAfterEnv: expect is function',
      'file a',
      'beforeEach from setupFilesAfterEnv',
      'test one',
      'env:teardown matchers=toBe',
      'env:setup file b.test.js {"prepared":true}',
      'setupFiles: describe is function',
      'setupFilesAfterEnv: expect is function',
      'file b',
      'beforeEach from setupFilesAfterEnv',
      'env:teardown matchers=toBe',
    ])
    assert.deepEqual(states(run.events), { one: 'pass', two: 'pass' })
  })

  // B14a's `core-globals-at-setup`: Jest 30.5's setupFiles see only `jest`; jest-circus installs
  // the rest before setupFilesAfterEnv. The policy names the globals that come first.
  it('installs only the globals core.globalsBeforeSetupFiles lists before setupFiles, the rest after them', async () => {
    const p = await project({
      'setup.js':
        "__trace.push('setupFiles: test is ' + typeof test + ', expect is ' + typeof expect)",
      'after-env.js': "__trace.push('setupFilesAfterEnv: test is ' + typeof test)",
      'a.test.js': ["__trace.push('file: test is ' + typeof test)", "test('one', () => {})"].join(
        '\n',
      ),
    })
    const base = runtimeConfig(p.dir, {
      setupFiles: [p.path('setup.js')],
      setupFilesAfterEnv: [p.path('after-env.js')],
    })
    const config = runtimeConfig(p.dir, {
      setupFiles: [p.path('setup.js')],
      setupFilesAfterEnv: [p.path('after-env.js')],
      policy: {
        ...base.policy,
        core: { ...base.policy.core, globalsBeforeSetupFiles: ['expect'] },
      },
    })
    const trace: string[] = []
    const run = await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    assert.deepEqual(
      trace.filter((line) => line.includes(' is ')),
      [
        'setupFiles: test is undefined, expect is function',
        'setupFilesAfterEnv: test is function',
        'file: test is function',
      ],
    )
    assert.deepEqual(states(run.events), { one: 'pass' })
  })

  // Jest adds the config's `snapshotSerializers` when the test framework starts (jestAdapterInit):
  // after `setupFiles` and the globals the framework installs, before `setupFilesAfterEnv`.
  it('imports the project`s snapshot serializers after setupFiles and the late globals, before setupFilesAfterEnv', async () => {
    const p = await project({
      'setup.js': "__trace.push('setupFiles: test is ' + typeof test)",
      'serializer.js': [
        "__trace.push('snapshotSerializers: test is ' + typeof test)",
        'module.exports = { test: () => false, serialize: () => "" }',
      ].join('\n'),
      'after-env.js': "__trace.push('setupFilesAfterEnv: test is ' + typeof test)",
      'a.test.js': "test('one', () => {})",
    })
    const base = runtimeConfig(p.dir)
    const config = runtimeConfig(p.dir, {
      setupFiles: [p.path('setup.js')],
      setupFilesAfterEnv: [p.path('after-env.js')],
      policy: {
        ...base.policy,
        core: { ...base.policy.core, globalsBeforeSetupFiles: ['expect'] },
        snapshot: { ...base.policy.snapshot, serializers: [p.path('serializer.js')] },
      },
    })
    const trace: string[] = []
    const run = await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    assert.deepEqual(
      trace.filter((line) => line.includes(' is ')),
      [
        'setupFiles: test is undefined',
        'snapshotSerializers: test is function',
        'setupFilesAfterEnv: test is function',
      ],
    )
    assert.deepEqual(states(run.events), { one: 'pass' })
  })

  // Deliberate: `none` keeps the environment, and so the late globals, for the next file. Jest has
  // no `none` to match, and removing them per file would cost the tier its point.
  it('under none, a later file`s setupFiles see the late globals an earlier file installed', async () => {
    const p = await project({
      'setup.js': "__trace.push('setupFiles: test is ' + typeof test)",
      'a.test.js': "test('a', () => {})",
      'b.test.js': "test('b', () => {})",
    })
    const base = runtimeConfig(p.dir, { setupFiles: [p.path('setup.js')] })
    const config = runtimeConfig(p.dir, {
      setupFiles: [p.path('setup.js')],
      policy: {
        ...base.policy,
        core: { ...base.policy.core, globalsBeforeSetupFiles: ['expect'] },
      },
    })
    const jobs = ['a', 'b'].map((name) => runtimeJob(config, p.path(`${name}.test.js`)))
    const traceOf = async (isolation: 'none' | 'registry'): Promise<string[]> => {
      const trace: string[] = []
      const run = await runJobs({ config, isolation, trace, jobs })
      assert.deepEqual(states(run.events), { a: 'pass', b: 'pass' })
      return trace.filter((line) => line.startsWith('setupFiles:'))
    }
    assert.deepEqual(await traceOf('none'), [
      'setupFiles: test is undefined',
      'setupFiles: test is function',
    ])
    // Under registry each file has its own environment, so neither file's setupFiles sees `test`.
    assert.deepEqual(await traceOf('registry'), [
      'setupFiles: test is undefined',
      'setupFiles: test is undefined',
    ])
  })
})

describe("an environment that listens (Jest's handleTestEvent)", () => {
  const files = {
    'a.test.js': "test('one', () => { __trace.push('test one') })",
  }

  it("gets the file's lifecycle events between its set-up and its teardown, in the file's order", async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir, { environmentOptions: { listen: true } })
    const trace: string[] = []
    const run = await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    const steps = trace.filter((step) => /^(event:|test one|env:)/.test(step))
    const events = steps.filter((step) => step.startsWith('event:'))
    assert.deepEqual(events.slice(0, 3), [
      'event:file-setup',
      'event:define-test',
      'event:run-start',
    ])
    assert.ok(events.includes('event:test-start one'))
    assert.equal(events.at(-1), 'event:file-teardown')
    // The body runs between the listener's fn-start and test-done; the teardown comes last.
    assert.ok(steps.indexOf('test one') > steps.indexOf('event:fn-start'))
    assert.ok(steps.indexOf('test one') < steps.indexOf('event:test-done one'))
    assert.ok(steps.indexOf('event:file-teardown') < steps.indexOf('env:teardown matchers=toBe'))
  })

  it('has none of it when the environment has no onTestEvent', async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.deepEqual(
      trace.filter((step) => step.startsWith('event:')),
      [],
    )
  })
})

describe('the file id (D23)', () => {
  it('is the job’s: every event of the file, and every task in it, carries the id the coordinator gave', async () => {
    const p = await project({
      'a.test.js': [
        "describe('suite', () => {",
        '  beforeEach(() => {})',
        "  test('one', () => {})",
        '})',
        "test('two', () => {})",
      ].join('\n'),
    })
    const config = runtimeConfig(p.dir)
    const given = 'from-coord' as TaskId
    const job: FileJob = { ...runtimeJob(config, p.path('a.test.js')), fileId: given }
    assert.notEqual(job.fileId, runtimeJob(config, p.path('a.test.js')).fileId)
    const run = await runJobs({ config, jobs: [job] })
    assert.deepEqual(states(run.events), { one: 'pass', two: 'pass' })
    const ids = run.events.flatMap((event): TaskId[] => {
      switch (event.type) {
        case 'file-collect-start':
        case 'file-collect-end':
        case 'file-end':
          return [event.fileId]
        case 'suite-start':
        case 'suite-end':
        case 'test-start':
        case 'test-attempt-start':
        case 'test-attempt-end':
        case 'test-end':
          return [event.id]
        default:
          return []
      }
    })
    assert.ok(ids.length >= 10, `${ids.length} ids`)
    for (const id of ids) assert.ok(id === given || id.startsWith(`${given}_`), id)
    const [collected] = eventsOf(run.events, 'file-collect-end')
    assert.ok(collected !== undefined)
    for (const task of collected.tasks) assert.equal(task.fileId, given)
  })
})

describe('the deps event (U5)', () => {
  const files = {
    'leaf.js': 'module.exports = 1',
    'mid.js': "module.exports = require('./leaf.js') + 1",
    'setup.js': '',
    'a.test.js': "const mid = require('./mid.js')\ntest('a', () => { expect(mid).toBe(2) })",
    'b.test.js': "test('b', () => {})",
    'c.test.js': "const mid = require('./mid.js')\ntest('c', () => { expect(mid).toBe(2) })",
  }

  for (const isolation of ['registry', 'none'] as const) {
    it(`sends one per file, under ${isolation}: the modules the file loaded, before its fileDone`, async () => {
      const p = await project(files)
      const config = runtimeConfig(p.dir, { setupFiles: [p.path('setup.js')] })
      const jobs = [
        runtimeJob(config, p.path('a.test.js')),
        runtimeJob(config, p.path('b.test.js')),
        runtimeJob(config, p.path('c.test.js')),
      ]
      const run = await runJobs({ config, isolation, jobs })
      const deps = eventsOf(run.events, 'deps')
      assert.deepEqual(
        deps.map((event) => event.fileId),
        jobs.map((job) => job.fileId),
        'one per file, in order',
      )
      // The coordinator's table for this worker turns each event back into the file's list.
      const table = createDepsTable()
      const [first, second, third] = deps.map((event) => table.resolve(event))
      assert.deepEqual(first?.toSorted(), [
        p.path('a.test.js'),
        p.path('leaf.js'),
        p.path('mid.js'),
        p.path('setup.js'),
      ])
      assert.deepEqual(second?.toSorted(), [p.path('b.test.js'), p.path('setup.js')])
      assert.deepEqual(third?.toSorted(), [
        p.path('c.test.js'),
        p.path('leaf.js'),
        p.path('mid.js'),
        p.path('setup.js'),
      ])
      for (const event of deps) assert.equal(typeof event.t, 'number')
    })

    it(`names each path once per worker, under ${isolation}, then sends its id`, async () => {
      const p = await project(files)
      const config = runtimeConfig(p.dir, { setupFiles: [p.path('setup.js')] })
      const jobs = [
        runtimeJob(config, p.path('a.test.js')),
        runtimeJob(config, p.path('b.test.js')),
        runtimeJob(config, p.path('c.test.js')),
      ]
      const run = await runJobs({ config, isolation, jobs })
      const [first, second, third] = eventsOf(run.events, 'deps')
      assert.equal(first?.added.length, 4, 'the first file names all of its modules')
      assert.equal(first?.ids.length, 4)
      assert.deepEqual(second?.added, [p.path('b.test.js')], 'the setup file is not named again')
      assert.equal(second?.ids.length, 2)
      assert.deepEqual(third?.added, [p.path('c.test.js')], 'nor mid.js and leaf.js')
      assert.equal(third?.ids.length, 4)
      const named = [first, second, third].flatMap((event) => event?.added ?? [])
      assert.equal(new Set(named).size, named.length, 'no path crosses twice')
      assert.ok(
        [first, second, third].every((event) => event?.ids.every((id) => id < named.length)),
        'an id is one of the named paths',
      )
    })
  }
})

describe('setup files are fresh for every file', () => {
  const files = {
    'dep.js': "__trace.push('dep evaluated')",
    'setup.js': "require('./dep.js')\n__trace.push('setup evaluated')",
    'a.test.js': "test('a', () => {})",
    'b.test.js': "test('b', () => {})",
    'c.test.js': "test('c', () => {})",
  }
  const names = ['a', 'b', 'c']

  for (const isolation of ['registry', 'none'] as const) {
    it(`evaluates the setup file once per file under ${isolation}; its dependency once per ${isolation === 'none' ? 'worker' : 'file'}`, async () => {
      const p = await project(files)
      const config = runtimeConfig(p.dir, { setupFilesAfterEnv: [p.path('setup.js')] })
      const trace: string[] = []
      const run = await runJobs({
        config,
        isolation,
        trace,
        jobs: names.map((name) => runtimeJob(config, p.path(`${name}.test.js`))),
      })
      assert.deepEqual(states(run.events), { a: 'pass', b: 'pass', c: 'pass' })
      const count = (step: string) => trace.filter((entry) => entry === step).length
      assert.equal(count('setup evaluated'), 3)
      assert.equal(count('dep evaluated'), isolation === 'none' ? 1 : 3)
    })
  }

  it('is collected inside the file: a failing setup file fails that file with no tests', async () => {
    const p = await project({
      'bad-setup.js': "throw new Error('setup blew up')",
      'a.test.js': "test('a', () => {})",
    })
    const config = runtimeConfig(p.dir, { setupFilesAfterEnv: [p.path('bad-setup.js')] })
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    const [collected] = eventsOf(run.events, 'file-collect-end')
    assert.deepEqual(
      collected?.errors.map((error) => error.message),
      ['setup blew up'],
    )
    assert.equal(eventsOf(run.events, 'test-end').length, 0)
    assert.equal(eventsOf(run.events, 'file-end')[0]?.result.state, 'fail')
  })
})

describe('invalidating a module before importing it', () => {
  // `invalidate` has to forget the module whichever way it was loaded. A package's `exports` can
  // map `import` and `require` to different files, so it resolves the specifier once as an
  // `import` and once as a `require` (the loader's `invalidate`, B10 review round 1). Under `none`
  // it is needed (the shared registry caches). Under `registry` the registry is new, so the worker
  // never calls it: that would be a wasted resolver call per module per file.
  const resolutions = async (isolation: 'registry' | 'none') => {
    const p = await project({
      'setup.js': '',
      'a.test.js': "test('a', () => {})",
    })
    const config = runtimeConfig(p.dir, {
      setupFilesAfterEnv: [p.path('setup.js')],
      loader: {
        ...runtimeConfig(p.dir).loader,
        mappers: [
          {
            factory: moduleRef<ModuleMapperFactory>(
              fixture('runtime-mapper.ts').href,
              'recordingMapper',
            ),
            options: null,
          },
        ],
      },
    })
    const trace: string[] = []
    const run = await runJobs({
      config,
      isolation,
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js'))],
    })
    assert.deepEqual(states(run.events), { a: 'pass' })
    return trace.filter((step) => step.startsWith('resolve '))
  }

  it('resolves the setup file and the test file once each under registry', async () => {
    assert.deepEqual(await resolutions('registry'), ['resolve setup.js', 'resolve a.test.js'])
  })

  it('resolves each of them three times under none: invalidate as import and as require, then the import', async () => {
    assert.deepEqual(await resolutions('none'), [
      'resolve setup.js',
      'resolve setup.js',
      'resolve setup.js',
      'resolve a.test.js',
      'resolve a.test.js',
      'resolve a.test.js',
    ])
  })

  it('resolves more under none than under registry, because only none calls invalidate', async () => {
    const registry = await resolutions('registry')
    const none = await resolutions('none')
    assert.ok(
      none.length > registry.length,
      `${none.length} resolves under none, ${registry.length} under registry`,
    )
  })
})

describe('the globals', () => {
  it('serve the running file’s registry to the dialect', async () => {
    const p = await project({
      'a.test.js': "test('a', () => { __trace.push('registry ' + currentRegistryFile()) })",
      'b.test.js': "test('b', () => { __trace.push('registry ' + currentRegistryFile()) })",
    })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      trace,
      jobs: ['a', 'b'].map((name) => runtimeJob(config, p.path(`${name}.test.js`))),
    })
    assert.deepEqual(
      trace.filter((step) => step.startsWith('registry')),
      [`registry ${p.path('a.test.js')}`, `registry ${p.path('b.test.js')}`],
    )
  })

  it('are not installed when the policy injects none, and the factory never runs', async () => {
    const p = await project({
      'a.test.js': "__trace.push('describe is ' + typeof describe)",
    })
    const base = runtimeConfig(p.dir)
    const config = runtimeConfig(p.dir, {
      policy: { ...base.policy, core: { ...base.policy.core, injectGlobals: false } },
    })
    const trace: string[] = []
    const run = await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.ok(trace.includes('describe is undefined'))
    assert.ok(!trace.includes('globals:factory'))
    assert.equal(eventsOf(run.events, 'test-end').length, 0)
  })
})

describe('a matcher the globals factory adds', () => {
  const files = {
    'a.test.js': "test('a', () => { expect('factory').toBeFromFactory() })",
    'b.test.js': [
      "test('b', () => {",
      "  expect('factory').toBeFromFactory()",
      "  expect(typeof expect.toBeFromFactory).toBe('function')",
      '})',
    ].join('\n'),
  }

  for (const isolation of ['registry', 'none'] as const) {
    it(`is still there for the second file under ${isolation}: the restore keeps it`, async () => {
      const p = await project(files)
      const config = runtimeConfig(p.dir, {
        globals: moduleRef<GlobalsFactory>(fixture('runtime-globals.ts').href, 'extendingGlobals'),
      })
      const run = await runJobs({
        config,
        isolation,
        jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
      })
      assert.deepEqual(states(run.events), { a: 'pass', b: 'pass' })
    })
  }
})

describe('per-file filters', () => {
  const file = (prefix: string) =>
    [
      `test('${prefix} keep one', () => {})`,
      `test('${prefix} skip me', () => {})`,
      `test('${prefix} keep two', () => {})`,
    ].join('\n')

  it('runs only the tests the job’s testNamePattern matches, and the next job has none', async () => {
    const p = await project({ 'a.test.js': file('a'), 'b.test.js': file('b') })
    const config = runtimeConfig(p.dir)
    const run = await runJobs({
      config,
      jobs: [
        { ...runtimeJob(config, p.path('a.test.js')), testNamePattern: 'keep' },
        runtimeJob(config, p.path('b.test.js')),
      ],
    })
    assert.deepEqual(states(run.events), {
      'a keep one': 'pass',
      'a skip me': 'skip',
      'a keep two': 'pass',
      'b keep one': 'pass',
      'b skip me': 'pass',
      'b keep two': 'pass',
    })
  })

  it('fails a file whose collectOnly is not exactly true, instead of running it', async () => {
    const p = await project({ 'a.test.js': file('a') })
    const config = runtimeConfig(p.dir)
    const run = await runJobs({
      config,
      jobs: [{ ...runtimeJob(config, p.path('a.test.js')), collectOnly: 'yes' as never }],
    })
    const [ended] = eventsOf(run.events, 'file-end')
    assert.equal(ended?.result.state, 'fail')
    assert.equal(ended?.result.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
    assert.match(ended?.result.errors[0]?.message ?? '', /collectOnly/)
    assert.deepEqual(states(run.events), {})
  })

  it('runs only the job’s testIds', async () => {
    const p = await project({ 'a.test.js': file('a') })
    const config = runtimeConfig(p.dir)
    const first = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    const ids = eventsOf(first.events, 'file-collect-end')[0]
      ?.tasks.filter((task) => task.type === 'test')
      .map((task) => task.id)
    assert.equal(ids?.length, 3)
    const second = await runJobs({
      config,
      jobs: [{ ...runtimeJob(config, p.path('a.test.js')), testIds: [ids?.[1] as TaskId] }],
    })
    assert.deepEqual(states(second.events), {
      'a keep one': 'skip',
      'a skip me': 'pass',
      'a keep two': 'skip',
    })
  })
})

describe('assertion counts', () => {
  it('reach test-end: calls made and calls that passed, of the deciding attempt', async () => {
    const p = await project({
      'a.test.js': [
        "test('two pass', () => { expect(1).toBe(1); expect(2).toBe(2) })",
        "test('one fails', () => { expect(1).toBe(1); expect(1).toBe(2); expect(3).toBe(3) })",
        "test('none', () => {})",
        "test.skip('skipped', () => { expect(1).toBe(1) })",
      ].join('\n'),
    })
    const config = runtimeConfig(p.dir)
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    const counts = Object.fromEntries(
      [...resultsByName(run.events)].map(([name, event]) => [
        name,
        [event.result.state, event.result.assertions, event.result.passingAssertions],
      ]),
    )
    assert.deepEqual(counts, {
      'two pass': ['pass', 2, 2],
      'one fails': ['fail', 2, 1],
      none: ['pass', 0, 0],
      skipped: ['skip', 0, 0],
    })
  })
})

describe('the end of a test (T7.8)', () => {
  const file = [
    "test('assertions(2) missed', () => { expect.assertions(2); expect(1).toBe(1) })",
    "test('assertions(1) met', () => { expect.assertions(1); expect(1).toBe(1) })",
    "test('hasAssertions none', () => { expect.hasAssertions() })",
    "test('soft failure', () => { if (expect.soft) expect.soft(1).toBe(2); expect(1).toBe(1) })",
    "test('unawaited', () => { expect(Promise.resolve(1)).resolves.toBe(1) })",
    "test('awaited', async () => { await expect(Promise.resolve(1)).resolves.toBe(1) })",
    "test('no assertion', () => {})",
  ].join('\n')

  /** Each test's state and error messages. */
  async function outcomes(policy: PolicyOverrides): Promise<Record<string, unknown>> {
    const p = await project({ 'a.test.js': file })
    const config = runtimeConfig(p.dir, { policy: runtimePolicy(policy) })
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    return Object.fromEntries(
      [...resultsByName(run.events)].map(([name, event]) => [
        name,
        [event.result.state, ...event.result.errors.map((error) => error.message)],
      ]),
    )
  }

  it('fails a test on a missed count, a soft failure, an unawaited assertion and a missing one', async () => {
    const results = await outcomes({
      core: { unawaitedAsyncAssertion: 'fail' },
      expect: { soft: true, requireAssertions: true },
    })
    assert.deepEqual(results, {
      'assertions(2) missed': ['fail', 'expected 2 assertions, made 1'],
      'assertions(1) met': ['pass'],
      'hasAssertions none': ['fail', 'expected an assertion, made none'],
      'soft failure': ['fail', 'expected 1 to be 2'],
      unawaited: ['fail', 'toBe was not awaited'],
      awaited: ['pass'],
      'no assertion': ['fail', 'every test must make an assertion'],
    })
  })

  it('with the policies off, only the counts apply: no soft, and an unawaited assertion passes', async () => {
    const results = await outcomes({
      core: { unawaitedAsyncAssertion: 'ignore' },
      expect: { soft: false, requireAssertions: false },
    })
    assert.deepEqual(results, {
      'assertions(2) missed': ['fail', 'expected 2 assertions, made 1'],
      'assertions(1) met': ['pass'],
      'hasAssertions none': ['fail', 'expected an assertion, made none'],
      'soft failure': ['pass'],
      unawaited: ['pass'],
      awaited: ['pass'],
      'no assertion': ['pass'],
    })
  })
})

describe('assertion counts of a test with repeats', () => {
  it('are those of the repeat that failed, not of a later repeat that passed', async () => {
    const p = await project({
      'a.test.js': [
        'let run = 0',
        "test('flaky', { repeats: 2 }, () => {",
        '  run++',
        // Repeat 0 makes one call, and it fails; repeats 1 and 2 make three that pass.
        '  if (run === 1) return expect(1).toBe(2)',
        '  expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3)',
        '})',
      ].join('\n'),
    })
    const config = runtimeConfig(p.dir)
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    const flaky = resultsByName(run.events).get('flaky')
    assert.equal(flaky?.result.state, 'fail')
    assert.equal(flaky?.result.assertions, 1)
    assert.equal(flaky?.result.passingAssertions, 0)
  })
})

describe('teardown', () => {
  const file = [
    'expect.extend({ toBeEven: () => ({ pass: true, message: () => "" }) })',
    'probeRegistry()',
    "test('t', () => {})",
  ].join('\n')

  it('tears the environment down, then restores the matchers, then disposes the registry', async () => {
    const p = await project({ 'a.test.js': file })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    // The environment goes first, with the file’s matcher still registered; by the time the
    // registry is disposed, the matcher is gone.
    assert.deepEqual(
      trace.filter((step) => /^(env:teardown|registry:dispose)/.test(step)),
      ['env:teardown matchers=toBe+toBeEven', 'registry:dispose matchers=toBe'],
    )
  })

  it('charges a throwing teardown to the file, runs the rest of the teardown, and still sends fileDone', async () => {
    const p = await project({ 'a.test.js': file, 'b.test.js': "test('b', () => {})" })
    const config = runtimeConfig(p.dir, { environmentOptions: { failTeardown: true } })
    const trace: string[] = []
    const jobs = [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))]
    const run = await runJobs({ config, trace, jobs })
    assert.equal(run.done.length, 2)
    const unhandled = eventsOf(run.events, 'unhandled-error')
    assert.deepEqual(
      unhandled.map((event) => [event.ownerId, event.error.message]),
      jobs.map((job) => [job.fileId, 'teardown failed']),
    )
    // The tests ran and ended first; the matchers were restored and the registry disposed anyway.
    const kinds = run.events.map((event) => event.type)
    assert.ok(kinds.indexOf('file-end') < kinds.indexOf('unhandled-error'))
    assert.deepEqual(
      trace.filter((step) => step.startsWith('registry:dispose')),
      ['registry:dispose matchers=toBe'],
    )
    assert.equal(states(run.events).t, 'pass')
    assert.equal(states(run.events).b, 'pass')
  })

  it('keeps the environment, the globals and the custom matchers across files under none', async () => {
    const p = await project({ 'a.test.js': file, 'b.test.js': "test('b', () => {})" })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      isolation: 'none',
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    // Set up once, for the first file, with scope worker; torn down once, at stop.
    assert.deepEqual(
      trace.filter((step) => step.startsWith('env:')),
      [
        'env:prepare {}',
        'env:setup worker a.test.js {"prepared":true}',
        'env:teardown matchers=toBe+toBeEven',
      ],
    )
    assert.ok(trace.indexOf('registry:dispose matchers=toBe+toBeEven') >= 0)
  })
})

describe('the mock registry', () => {
  const probe = ['probeRegistry()', 'probeMocks()', "test('t', () => {})"].join('\n')

  /**
   * The mock steps of a trace, with the registry ids (which count up across the whole process)
   * renamed r1, r2, ... in order of first appearance, and the matcher notes dropped.
   */
  function mockSteps(trace: readonly string[]): string[] {
    const names = new Map<string, string>()
    return trace
      .filter((step) => /^(mocks:|env:teardown|registry:dispose)/.test(step))
      .map((step) => step.replace(/ matchers=.*/, ''))
      .map((step) =>
        step.replace(/^(mocks:\w+) (\d+)$/, (_, kind: string, id: string) => {
          if (!names.has(id)) names.set(id, `r${names.size + 1}`)
          return `${kind} ${names.get(id)}`
        }),
      )
  }

  it('is new for every file under registry, and disposed before the environment goes', async () => {
    const p = await project({ 'a.test.js': probe, 'b.test.js': probe })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    // Per file: the mocks first (the environment is alive), then the environment, then the registry.
    assert.deepEqual(mockSteps(trace), [
      'mocks:registry r1',
      'mocks:dispose r1',
      'env:teardown',
      'registry:dispose',
      'mocks:registry r2',
      'mocks:dispose r2',
      'env:teardown',
      'registry:dispose',
    ])
  })

  it('is the worker`s own under none: every file shares it, and stop disposes it first', async () => {
    const p = await project({ 'a.test.js': probe, 'b.test.js': probe })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      isolation: 'none',
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    // Nothing is disposed between the files; at stop the mocks go before the environment.
    assert.deepEqual(mockSteps(trace), [
      'mocks:registry r1',
      'registry:dispose',
      'mocks:registry r1',
      'registry:dispose',
      'mocks:dispose r1',
      'env:teardown',
    ])
  })

  it('keeps a file`s registries for the async work it leaves behind (a stale callback)', async () => {
    // A's promise continuation fires while B runs, released by B itself: no timer, no wait. It asks
    // the host for the registry and the mocks, and must get A's, not B's.
    // The hand-over goes through properties of the trace array: the environment deletes any global
    // a file adds, so a global of A's would be gone by the time B runs.
    const a = [
      'probeMocks()',
      '__trace.stale = new Promise((resolve) => { __trace.fire = resolve }).then(() => {',
      "  __trace.push('stale ' + currentRegistryFile())",
      '  probeMocks()',
      '})',
      "test('a', () => {})",
    ].join('\n')
    const b = [
      'probeMocks()',
      "test('b', async () => { __trace.fire(); await __trace.stale })",
    ].join('\n')
    const p = await project({ 'a.test.js': a, 'b.test.js': b })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    assert.deepEqual(
      trace.filter((step) => step.startsWith('stale ')),
      [`stale ${p.path('a.test.js')}`],
    )
    // A's registry, seen again from the callback while B runs: r1, r2 (B's own), r1.
    assert.deepEqual(
      mockSteps(trace).filter((step) => step.startsWith('mocks:registry')),
      ['mocks:registry r1', 'mocks:registry r2', 'mocks:registry r1'],
    )
  })

  it('refuses the host once the worker has stopped, under none too', async () => {
    // A file keeps the probe on the trace array (the environment deletes globals a file adds).
    const p = await project({ 'a.test.js': "__trace.probe = probeMocks\ntest('t', () => {})" })
    const config = runtimeConfig(p.dir)
    const trace: string[] & { probe?: () => void } = []
    await runJobs({
      config,
      isolation: 'none',
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js'))],
    })
    const probe = trace.probe
    assert.equal(typeof probe, 'function')
    assert.throws(() => probe?.(), { code: 'ORCH_NO_ACTIVE_FILE' })
  })

  it('hands the globals the policy`s mock slice', async () => {
    const p = await project({
      'a.test.js': "test('t', () => { __trace.push('policy ' + mockPolicyName()) })",
    })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({ config, trace, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.ok(trace.some((step) => /^policy \S/.test(step)))
  })

  it('charges a throwing dispose to the file and still runs the rest of the teardown', async () => {
    const p = await project({
      'a.test.js': ['probeRegistry()', 'probeMocks(true)', "test('t', () => {})"].join('\n'),
    })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    const job = runtimeJob(config, p.path('a.test.js'))
    const run = await runJobs({ config, trace, jobs: [job] })
    assert.equal(run.done.length, 1)
    assert.deepEqual(
      eventsOf(run.events, 'unhandled-error').map((event) => [event.ownerId, event.error.message]),
      [[job.fileId, 'mock dispose failed']],
    )
    assert.deepEqual(mockSteps(trace), [
      'mocks:registry r1',
      'mocks:dispose r1',
      'env:teardown',
      'registry:dispose',
    ])
    assert.equal(states(run.events).t, 'pass')
  })
})

describe('globals the environment could not remove (D22)', () => {
  const files = { 'a.test.js': "test('a', () => {})", 'b.test.js': "test('b', () => {})" }
  const consoleWarnings = (events: readonly WorkerEvent[]) =>
    eventsOf(events, 'console').filter((event) => event.level === 'warn')

  it('is a warning, not a failure: one console warn per file, before its fileDone, and the keys on fileDone', async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir, { environmentOptions: { leak: '__stuck,Symbol(s)' } })
    const jobs = [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))]
    const run = await runJobs({ config, jobs })

    assert.deepEqual(states(run.events), { a: 'pass', b: 'pass' })
    assert.equal(eventsOf(run.events, 'unhandled-error').length, 0)
    assert.equal(
      eventsOf(run.events, 'file-end').filter((e) => e.result.state === 'fail').length,
      0,
    )
    assert.deepEqual(
      run.done.map((done) => done.leakedGlobals),
      [
        ['__stuck', 'Symbol(s)'],
        ['__stuck', 'Symbol(s)'],
      ],
    )
    const warnings = consoleWarnings(run.events)
    assert.deepEqual(
      warnings.map((event) => [event.taskId, event.stream, event.level, event.origin]),
      [
        [null, 'stderr', 'warn', null],
        [null, 'stderr', 'warn', null],
      ],
    )
    for (const [index, name] of ['a.test.js', 'b.test.js'].entries()) {
      const text = warnings[index]?.text ?? ''
      assert.ok(text.includes(p.path(name)), `names the file: ${text}`)
      assert.ok(text.includes('__stuck, Symbol(s)'), `names the keys: ${text}`)
      assert.match(text, /Later files in this worker can see them\.\n$/)
    }
    // Each warning arrives after its own file ended and before the next file started.
    const kinds = run.events.map((event) => event.type)
    const warnAt = run.events.findIndex((event) => event.type === 'console')
    assert.ok(kinds.indexOf('file-end') < warnAt)
    assert.ok(warnAt < kinds.indexOf('file-collect-start', kinds.indexOf('file-end')))
  })

  it('leaves leakedGlobals empty on fileDone for a clean file, and sends no warning', async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir)
    const run = await runJobs({
      config,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    assert.deepEqual(
      run.done.map((done) => done.leakedGlobals),
      [[], []],
    )
    assert.deepEqual(consoleWarnings(run.events), [])
  })

  it('under none is reported once, when the worker stops: a warning before stopped, nothing on fileDone', async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir, { environmentOptions: { leak: '__stuck' } })
    const run = await runJobs({
      config,
      isolation: 'none',
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    assert.deepEqual(states(run.events), { a: 'pass', b: 'pass' })
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    assert.equal(eventsOf(run.events, 'unhandled-error').length, 0)
    assert.deepEqual(
      run.done.map((done) => done.leakedGlobals),
      [[], []],
      'the files leaked nothing the worker knew of while it ran',
    )
    const [warning, ...more] = consoleWarnings(run.events)
    assert.equal(more.length, 0)
    assert.equal(warning?.taskId, null)
    assert.equal(
      warning?.text,
      'Provino: the environment could not remove 1 global when the worker stopped: __stuck.\n',
    )
    // It is the last thing the worker sent: after the last file ended.
    assert.equal(run.events.at(-1), warning)
  })

  it('a teardown that throws is still charged to the file, with no keys reported', async () => {
    const p = await project(files)
    const config = runtimeConfig(p.dir, { environmentOptions: { failTeardown: true, leak: 'x' } })
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    assert.deepEqual(
      eventsOf(run.events, 'unhandled-error').map((event) => event.error.message),
      ['teardown failed'],
    )
    assert.deepEqual(run.done[0]?.leakedGlobals, [])
    assert.deepEqual(consoleWarnings(run.events), [])
  })
})

describe('stop', () => {
  it('tears the worker environment down and removes the matcher slot', async () => {
    const p = await project({ 'a.test.js': "test('a', () => {})" })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    const run = await runJobs({
      config,
      isolation: 'none',
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js'))],
    })
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    assert.equal(trace.at(-1), 'env:teardown matchers=toBe')
    assert.equal(Reflect.has(globalThis, MATCHERS_SLOT), false)
    // Worker-scoped: the globals the file saw were removed with the environment.
    assert.equal(Reflect.has(globalThis, 'describe'), false)
  })

  for (const isolation of ['registry', 'none'] as const) {
    it(`tears down an inline worker that was killed without a stop, so the next one can start (${isolation})`, async () => {
      const p = await project({
        'a.test.js': "test('a', () => { expect(1).toBe(1) })",
        'b.test.js': "test('b', () => { expect(1).toBe(1) })",
      })
      const config = runtimeConfig(p.dir)
      const first = await runJobs({
        config,
        isolation,
        end: 'kill',
        jobs: [runtimeJob(config, p.path('a.test.js'))],
      })
      assert.deepEqual(states(first.events), { a: 'pass' })

      // The same process, a second inline worker: it needs the matcher slot the first held.
      const second = await runJobs({
        config,
        isolation,
        jobs: [runtimeJob(config, p.path('b.test.js'))],
      })
      assert.deepEqual(
        eventsOf(second.events, 'unhandled-error').map((event) => event.error.code),
        [],
      )
      assert.deepEqual(states(second.events), { b: 'pass' })
      assert.equal(Reflect.has(globalThis, MATCHERS_SLOT), false)
      // Under none the environment was worker-scoped: the first worker's globals went with it.
      assert.equal(Reflect.has(globalThis, 'describe'), false)
    })
  }

  it('reports a killed inline worker only after its teardown ended, so the next one boots after it, even when the teardown awaits a macrotask', async () => {
    const p = await project({
      'a.test.js': "test('a', () => { expect(1).toBe(1) })",
      'b.test.js': "test('b', () => { expect(1).toBe(1) })",
    })
    // Under `none` the environment is torn down by the worker's `stop`, which is what a kill
    // queues; the matcher slot is released after it. The teardown takes a macrotask and an fs op.
    const config = runtimeConfig(p.dir, { environmentOptions: { slowTeardown: true } })
    // Set here, not through `runJobs`, so it stays in place when the first run returns.
    const trace: string[] = []
    Reflect.set(globalThis, '__trace', trace)
    try {
      const first = await runJobs({
        config,
        isolation: 'none',
        end: 'kill',
        jobs: [runtimeJob(config, p.path('a.test.js'))],
      })
      assert.deepEqual(states(first.events), { a: 'pass' })
      // The kill is reported only once the worker has torn down: nothing is left to run.
      assert.equal(trace.at(-1), 'env:teardown ended')
      assert.equal(Reflect.has(globalThis, MATCHERS_SLOT), false)

      const second = await runJobs({
        config,
        isolation: 'none',
        jobs: [runtimeJob(config, p.path('b.test.js'))],
      })
      assert.deepEqual(
        eventsOf(second.events, 'unhandled-error').map((event) => event.error.code),
        [],
      )
      assert.deepEqual(states(second.events), { b: 'pass' })
    } finally {
      Reflect.deleteProperty(globalThis, '__trace')
    }
    assert.deepEqual(
      trace.filter((step) => /^env:(prepare|teardown)/.test(step)),
      [
        'env:prepare {"slowTeardown":true}',
        'env:teardown matchers=toBe',
        'env:teardown ended',
        'env:prepare {"slowTeardown":true}',
        'env:teardown matchers=toBe',
        'env:teardown ended',
      ],
    )
  })

  it('copes with a worker whose start failed half-way', async () => {
    const p = await project({ 'a.test.js': "test('a', () => {})" })
    const config = runtimeConfig(p.dir, {
      environment: {
        module: runtimeConfig(p.dir).environment.module,
        export: 'notAnEnvironment',
        options: {},
      },
    })
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    // Expect was booted (the slot installed) before the environment failed; stop undid it.
    assert.equal(Reflect.has(globalThis, MATCHERS_SLOT), false)
    assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    assert.equal(run.done.length, 1)
  })
})

describe('a config the worker cannot use', () => {
  const codes = async (config: ReturnType<typeof runtimeConfig>, jobs: readonly FileJob[]) => {
    const run = await runJobs({ config, jobs })
    assert.equal(run.done.length, jobs.length, 'every file still gets its fileDone')
    return eventsOf(run.events, 'unhandled-error').map((event) => [event.ownerId, event.error.code])
  }

  it('is a coded error charged to every file', async () => {
    const p = await project({ 'a.test.js': '', 'b.test.js': '' })
    const base = runtimeConfig(p.dir)
    const jobs = [p.path('a.test.js'), p.path('b.test.js')].map((file) => runtimeJob(base, file))
    const bad = (overrides: Record<string, unknown>) =>
      ({ ...base, ...overrides }) as unknown as typeof base

    for (const overrides of [
      { name: 5 },
      { rootDir: undefined },
      { ci: 'yes' },
      { policy: { ...base.policy, core: null } },
      { environment: undefined },
      { environment: { ...base.environment, module: 3 } },
      // A ref that crosses must be absolute: the worker can't resolve a package from here.
      { environment: { ...base.environment, module: '@provino/env-node' } },
      { globals: { module: '@provino/dialect-jest/runtime', export: 'jestGlobals' } },
      { globals: { module: 'x' } },
      { setupFiles: 'setup.js' },
      { setupFilesAfterEnv: [1] },
      { loader: { ...base.loader, typescript: 'tsc' } },
      { loader: { ...base.loader, extensions: [1] } },
      { loader: { ...base.loader, mappers: [{ options: null }] } },
    ]) {
      assert.deepEqual(
        await codes(bad(overrides), jobs),
        jobs.map((job) => [job.fileId, 'ORCH_BAD_CONFIG']),
        JSON.stringify(Object.keys(overrides)),
      )
    }
  })

  it('names the key that is wrong', async () => {
    const p = await project({ 'a.test.js': '' })
    const base = runtimeConfig(p.dir)
    const config = {
      ...base,
      loader: { ...base.loader, typescript: 'tsc' },
    } as unknown as typeof base
    const run = await runJobs({ config, jobs: [runtimeJob(base, p.path('a.test.js'))] })
    assert.match(
      eventsOf(run.events, 'unhandled-error')[0]?.error.message ?? '',
      /loader\.typescript/,
    )
  })

  it('is ORCH_BAD_ENVIRONMENT for an environment that is missing, broken or not for this realm', async () => {
    const p = await project({ 'a.test.js': '' })
    const base = runtimeConfig(p.dir)
    const jobs = [runtimeJob(base, p.path('a.test.js'))]
    const ref = (overrides: { module?: string; export?: string }) =>
      runtimeConfig(p.dir, { environment: { ...base.environment, ...overrides } })
    for (const overrides of [
      { export: 'noSuchExport' },
      { export: 'notAnEnvironment' },
      { export: 'contextOnlyEnvironment' },
      { module: base.environment.module.replace('runtime-env', 'nonexistent') },
    ]) {
      assert.deepEqual(
        await codes(ref(overrides), jobs),
        jobs.map((job) => [job.fileId, 'ORCH_BAD_ENVIRONMENT']),
        JSON.stringify(overrides),
      )
    }
  })

  it('is ORCH_BAD_ENVIRONMENT for a setup that fails, charged to the file that hit it', async () => {
    const p = await project({ 'a.test.js': "test('a', () => {})" })
    const config = runtimeConfig(p.dir, { environmentOptions: { failSetup: true } })
    const run = await runJobs({ config, jobs: [runtimeJob(config, p.path('a.test.js'))] })
    const [error] = eventsOf(run.events, 'unhandled-error')
    assert.equal(error?.error.message, 'setup failed')
    assert.equal(error?.ownerId, runtimeJob(config, p.path('a.test.js')).fileId)
    assert.equal(eventsOf(run.events, 'test-end').length, 0)
  })
})

describe('isolation tiers', () => {
  it('"realm" is LOADER_NOT_IMPLEMENTED on the file, with nothing set up', async () => {
    const p = await project({ 'a.test.js': '', 'b.test.js': '' })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    const jobs = ['a', 'b'].map((name) => runtimeJob(config, p.path(`${name}.test.js`)))
    const run = await runJobs({ config, isolation: 'realm', trace, jobs })
    assert.deepEqual(
      eventsOf(run.events, 'unhandled-error').map((event) => [event.ownerId, event.error.code]),
      jobs.map((job) => [job.fileId, 'LOADER_NOT_IMPLEMENTED']),
    )
    assert.equal(run.done.length, 2)
    assert.deepEqual(
      trace.filter((step) => step.startsWith('env:setup')),
      [],
    )
  })

  it('"process" runs as registry: each file is isolated', async () => {
    const p = await project({ 'a.test.js': "test('a', () => {})" })
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    const run = await runJobs({
      config,
      isolation: 'process',
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js'))],
    })
    assert.equal(states(run.events).a, 'pass')
    assert.ok(trace.includes('env:setup file a.test.js {"prepared":true}'))
  })

  describe('a test file the shared registry already evaluated', () => {
    // Under `none` the registry outlives the file, so a module it evaluated once is cached.
    // The test file itself must be evaluated again, or it registers no tests.
    it('collects its tests each time the same file is queued under none', async () => {
      const p = await project({
        'a.test.js': "test('one', () => {})\ntest('two', () => {})",
      })
      const config = runtimeConfig(p.dir)
      const job = runtimeJob(config, p.path('a.test.js'))
      const run = await runJobs({ config, isolation: 'none', jobs: [job, job] })
      const collected = eventsOf(run.events, 'file-collect-end')
      assert.deepEqual(
        collected.map((event) => event.tasks.filter((task) => task.type === 'test').length),
        [2, 2],
      )
      assert.deepEqual(
        eventsOf(run.events, 'test-end').map((event) => event.result.state),
        ['pass', 'pass', 'pass', 'pass'],
      )
    })

    it('collects the tests of a file an earlier test file imported, under none', async () => {
      const p = await project({
        'a.test.js': "require('./b.test.js')\ntest('a', () => {})",
        'b.test.js': "test('b', () => {})",
      })
      const config = runtimeConfig(p.dir)
      const run = await runJobs({
        config,
        isolation: 'none',
        jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
      })
      const [first, second] = eventsOf(run.events, 'file-collect-end')
      const names = (event: typeof first) =>
        event?.tasks.filter((task) => task.type === 'test').map((task) => task.name)
      assert.deepEqual(names(first), ['b', 'a'])
      assert.deepEqual(names(second), ['b'])
    })

    it('is evaluated again under registry too, with a new registry each file', async () => {
      const p = await project({ 'a.test.js': "test('one', () => {})" })
      const config = runtimeConfig(p.dir)
      const job = runtimeJob(config, p.path('a.test.js'))
      const run = await runJobs({ config, isolation: 'registry', jobs: [job, job] })
      assert.deepEqual(
        eventsOf(run.events, 'test-end').map((event) => event.result.state),
        ['pass', 'pass'],
      )
    })
  })

  const leaky = {
    'a.test.js': [
      'globalThis.leak = 1',
      'Object.defineProperty(globalThis, "withGetter", { get: () => 2, configurable: true })',
      'expect.extend({ toBeEven: () => ({ pass: true, message: () => "" }) })',
      "test('a', () => {})",
    ].join('\n'),
    'b.test.js': [
      "test('b', () => {",
      "  __trace.push('b sees leak=' + typeof globalThis.leak + ' getter=' + typeof globalThis.withGetter",
      "    + ' matcher=' + typeof expect(1).toBeEven + ' static=' + typeof expect.toBeEven",
      "    + ' staticNot=' + typeof expect.not.toBeEven)",
      '})',
    ].join('\n'),
  }

  it('a global, a getter and a custom matcher set by file A are invisible to file B under registry', async () => {
    const p = await project(leaky)
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    assert.ok(
      trace.includes(
        'b sees leak=undefined getter=undefined matcher=undefined static=undefined staticNot=undefined',
      ),
      trace.filter((step) => step.startsWith('b sees')).join(),
    )
  })

  it('and visible under none', async () => {
    const p = await project(leaky)
    const config = runtimeConfig(p.dir)
    const trace: string[] = []
    await runJobs({
      config,
      isolation: 'none',
      trace,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    assert.ok(
      trace.includes(
        'b sees leak=number getter=number matcher=function static=function staticNot=function',
      ),
      trace.filter((step) => step.startsWith('b sees')).join(),
    )
  })
})
