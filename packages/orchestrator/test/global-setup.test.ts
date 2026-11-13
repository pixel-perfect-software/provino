// T9.15: global setup and teardown run in the coordinator, through the loader in coordinator mode
// (U5): once per distinct path, per project in the config's order, teardown after the run (in the
// order the policy says), a throw fails the run with the policy's text. The files run inline, so
// the setups, the tests and the reporter all write to one `globalThis.__trace`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResolvedGlobalSetup, ResolvedProject } from '@provino/config'
import {
  hookFailureReport,
  OrchestratorError,
  type RunProjectOptions,
  runProjects,
} from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { PolicyOverrides, Reporter } from '@provino/types'
import { Collect, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const JEST_HOOKS: NonNullable<PolicyOverrides['orchestrator']> = {
  globalSetup: {
    signature: 'global-and-project-config',
    teardownOrder: 'in-order',
    // `failure` stays the neutral behaviour: `<hook> <path> failed: <message>`.
  },
}

/** The trace the setups, the tests and the reporter share (inline workers run in this process). */
async function traced<T>(body: (trace: string[]) => Promise<T>): Promise<[T, string[]]> {
  const trace: string[] = []
  const previous = Reflect.get(globalThis, '__trace')
  Reflect.set(globalThis, '__trace', trace)
  try {
    const result = await body(trace)
    // The fixtures' recording environment and globals write their own steps to the same trace.
    return [result, trace.filter((step) => !/^(env|globals):/.test(step))]
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, '__trace')
    else Reflect.set(globalThis, '__trace', previous)
  }
}

const note = (step: string): string => `;(globalThis as any).__trace.push(${JSON.stringify(step)})`

function reporterOf(trace: string[]): Reporter {
  return {
    name: 'trace',
    'run:start': () => void trace.push('run:start'),
    'run:end': (summary) => void trace.push(`run:end ${summary.reason}`),
    error: (error, origin) => void trace.push(`error ${origin} ${error.message}`),
  }
}

async function runAll(
  projects: readonly ResolvedProject[],
  trace: string[],
  signal?: AbortSignal,
  extra: Partial<RunProjectOptions> = {},
): Promise<void> {
  await runProjects(projects, {
    bus: createReporterBus([reporterOf(trace)]),
    stderr: new Collect(),
    cache: false,
    pool: { kind: 'inline' },
    ...(signal === undefined ? {} : { signal }),
    ...extra,
  })
}

function withHooks(
  project: ResolvedProject,
  globalSetup: ResolvedGlobalSetup | undefined,
): ResolvedProject {
  return globalSetup === undefined ? project : { ...project, globalSetup }
}

describe('Jest’s signature: fn(globalConfig, projectConfig)', () => {
  it('runs the setup before the first file and the teardown after the run, with the two configs', async () => {
    const p = await makeProject({
      'setup.ts': [
        'module.exports = async function setup(globalConfig: object, projectConfig: object) {',
        note('setup'),
        `  ;(globalThis as any).__trace.push('args ' + JSON.stringify([globalConfig, projectConfig]))`,
        '}',
      ].join('\n'),
      'teardown.ts': `module.exports = async function teardown() { ${note('teardown')} }`,
      'a.test.js': "__trace.push('file a')\ntest('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [p.path('setup.ts')],
      teardown: [p.path('teardown.ts')],
      args: { globalConfig: { rootDir: p.dir }, projectConfig: { name: 'rt' } },
    })
    const [, trace] = await traced((t) => runAll([project], t))
    assert.deepEqual(trace, [
      'setup',
      `args ${JSON.stringify([{ rootDir: p.dir }, { name: 'rt' }])}`,
      'run:start',
      'file a',
      'run:end passed',
      'teardown',
    ])
  })

  it('runs a path shared by two projects once, others in the projects’ order, and the teardowns in the policy’s order', async () => {
    const shared = `module.exports = async () => { ${note('shared setup')} }`
    const files = {
      'shared.ts': shared,
      'one.ts': `module.exports = async () => { ${note('setup one')} }`,
      'two.ts': `module.exports = async () => { ${note('setup two')} }`,
      'down-one.ts': `module.exports = async () => { ${note('teardown one')} }`,
      'down-two.ts': `module.exports = async () => { ${note('teardown two')} }`,
      'a.test.js': "test('a', () => {})",
    }
    for (const order of ['in-order', 'reverse'] as const) {
      const p = await makeProject(files)
      const policy = {
        orchestrator: { globalSetup: { ...JEST_HOOKS.globalSetup, teardownOrder: order } },
      }
      const first = withHooks(runtimeProject(p.dir, { name: 'first', policy }), {
        setup: [p.path('shared.ts'), p.path('one.ts')],
        teardown: [p.path('down-one.ts')],
      })
      const second = withHooks(runtimeProject(p.dir, { name: 'second', policy }), {
        setup: [p.path('shared.ts'), p.path('two.ts')],
        teardown: [p.path('down-one.ts'), p.path('down-two.ts')],
      })
      const [, trace] = await traced((t) => runAll([first, second], t))
      const hooks = trace.filter((step) => /setup|teardown/.test(step))
      assert.deepEqual(
        hooks.slice(0, 3),
        ['shared setup', 'setup one', 'setup two'],
        `setup, ${order}`,
      )
      assert.deepEqual(
        hooks.slice(3),
        order === 'in-order' ? ['teardown one', 'teardown two'] : ['teardown two', 'teardown one'],
        `teardown, ${order}`,
      )
    }
  })

  it('runs no setup and no teardown when the run only collects (--collectTests)', async () => {
    const p = await makeProject({
      'setup.ts': `module.exports = async () => { ${note('setup')} }`,
      'teardown.ts': `module.exports = async () => { ${note('teardown')} }`,
      'a.test.js': "__trace.push('file a')\ntest('a', () => { __trace.push('body') })",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [p.path('setup.ts')],
      teardown: [p.path('teardown.ts')],
    })
    const [, trace] = await traced((t) => runAll([project], t, undefined, { collectOnly: true }))
    // The file is imported (its top level runs); no hook and no body does.
    assert.deepEqual(trace, ['run:start', 'file a', 'run:end passed'])
  })

  it('leaves a project with no test file out: its setup never runs', async () => {
    const p = await makeProject({
      'quiet.ts': `module.exports = async () => { ${note('quiet setup')} }`,
      'busy.ts': `module.exports = async () => { ${note('busy setup')} }`,
      'a.test.js': "test('a', () => {})",
    })
    const quiet = withHooks(
      runtimeProject(p.dir, {
        name: 'quiet',
        include: ['nothing/**/*.test.js'],
        policy: { orchestrator: JEST_HOOKS },
      }),
      { setup: [p.path('quiet.ts')], teardown: [] },
    )
    const busy = withHooks(
      runtimeProject(p.dir, { name: 'busy', policy: { orchestrator: JEST_HOOKS } }),
      {
        setup: [p.path('busy.ts')],
        teardown: [],
      },
    )
    const [, trace] = await traced((t) => runAll([quiet, busy], t))
    assert.deepEqual(
      trace.filter((step) => step.includes('setup')),
      ['busy setup'],
    )
  })

  it('fails the run as the policy’s failure says when a setup throws: no file runs, reporters hear nothing, the cause is kept', async () => {
    const p = await makeProject({
      'setup.ts': "module.exports = async function setup() { throw new Error('setup failed') }",
      'teardown.ts': `module.exports = async () => { ${note('teardown ran')} }`,
      'a.test.js': "__trace.push('file a')\ntest('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [p.path('setup.ts')],
      teardown: [p.path('teardown.ts')],
    })
    const [error, trace] = await traced(async (t) => {
      try {
        await runAll([project], t)
      } catch (caught) {
        return caught
      }
      return undefined
    })
    assert.ok(error instanceof OrchestratorError)
    assert.equal(error.code, 'ORCH_GLOBAL_SETUP_FAILED')
    assert.equal(error.message, `globalSetup ${p.path('setup.ts')} failed: setup failed`)
    // The cause is the error the policy returned, which keeps what the hook threw as its own.
    const reported = error.cause
    assert.ok(reported instanceof Error)
    assert.equal(reported.message, error.message)
    assert.equal((reported.cause as Error).message, 'setup failed')
    assert.deepEqual(trace, [], 'no run:start, no file, and Jest runs no teardown here')
  })

  it('refuses a module that does not export a function, worded the same way', async () => {
    const p = await makeProject({
      'setup.ts': 'module.exports = { not: "a function" }',
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [p.path('setup.ts')],
      teardown: [],
    })
    await assert.rejects(
      traced((t) => runAll([project], t)),
      {
        code: 'ORCH_GLOBAL_SETUP_FAILED',
        message: `globalSetup ${p.path('setup.ts')} failed: globalSetup file must export a function at ${p.path('setup.ts')}`,
      },
    )
  })

  it('still tears down when the run is cut short, and a throwing teardown fails the run after its reporters have heard it', async () => {
    const p = await makeProject({
      'down-bad.ts': `module.exports = async () => { ${note('teardown bad')}; throw new Error('teardown failed') }`,
      'down-good.ts': `module.exports = async () => { ${note('teardown good')} }`,
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [],
      teardown: [p.path('down-bad.ts'), p.path('down-good.ts')],
    })
    // The run is interrupted once it has started (a signal before that sets nothing up).
    const abort = new AbortController()
    const [error, trace] = await traced(async (t) => {
      try {
        await runAll([project], t, abort.signal, {
          bus: createReporterBus([
            reporterOf(t),
            { name: 'interrupt', 'run:start': () => abort.abort() },
          ]),
        })
      } catch (caught) {
        return caught
      }
      return undefined
    })
    assert.ok(error instanceof OrchestratorError)
    assert.equal(error.message, `globalTeardown ${p.path('down-bad.ts')} failed: teardown failed`)
    assert.ok(trace.includes('run:end interrupted'), trace.join(', '))
    assert.ok(trace.indexOf('run:end interrupted') < trace.indexOf('teardown bad'))
    assert.ok(trace.includes('teardown good'), 'the teardown after the one that threw still ran')
  })
})

/** A Jest-style hook that notes `what` with the name of the project config it was called with. */
const noting = (what: string): string =>
  `module.exports = async (_global: object, project: { name: string }) => { ${note(what)} ;(globalThis as any).__trace.push('  config ' + project.name) }`

describe('the run’s own hooks and the order of the projects (Jest’s runGlobalHook)', () => {
  it('runs the run’s hooks after the projects’, a path a project names once, the first project’s config for the rest', async () => {
    const p = await makeProject({
      'own.ts': noting('setup own'),
      'root.ts': noting('setup root'),
      'down-own.ts': noting('teardown own'),
      'down-root.ts': noting('teardown root'),
      'big.test.js': `// the larger file, so the first project is first in the sequenced list\ntest('big', () => {})`,
      'small.test.js': "test('small', () => {})",
    })
    const first = withHooks(
      runtimeProject(p.dir, {
        name: 'first',
        include: ['big.test.js'],
        policy: { orchestrator: JEST_HOOKS },
      }),
      {
        setup: [p.path('own.ts')],
        teardown: [p.path('down-own.ts')],
        args: { globalConfig: {}, projectConfig: { name: 'first' } },
      },
    )
    // No hook of its own: still carries the args, which the run's hook is called with when this
    // project is the first one.
    const second = withHooks(
      runtimeProject(p.dir, {
        name: 'second',
        include: ['small.test.js'],
        policy: { orchestrator: JEST_HOOKS },
      }),
      {
        setup: [],
        teardown: [],
        args: { globalConfig: {}, projectConfig: { name: 'second' } },
      },
    )
    const [, trace] = await traced((t) =>
      runAll([first, second], t, undefined, {
        globalSetup: {
          setup: [p.path('root.ts'), p.path('own.ts')],
          teardown: [p.path('down-own.ts'), p.path('down-root.ts')],
        },
      }),
    )
    assert.deepEqual(
      trace.filter((step) => /setup|teardown|config/.test(step)),
      [
        'setup own',
        '  config first',
        'setup root',
        '  config first',
        'teardown own',
        '  config first',
        'teardown root',
        '  config first',
      ],
    )
  })

  it('does not run the run’s hooks when no project has a file', async () => {
    const p = await makeProject({
      'root.ts': noting('setup root'),
      'a.test.js': 'test("a", () => {})',
    })
    const project = withHooks(
      runtimeProject(p.dir, {
        include: ['nothing/**/*.test.js'],
        policy: { orchestrator: JEST_HOOKS },
      }),
      { setup: [], teardown: [], args: { globalConfig: {}, projectConfig: {} } },
    )
    const [, trace] = await traced((t) =>
      runAll([project], t, undefined, {
        globalSetup: { setup: [p.path('root.ts')], teardown: [] },
      }),
    )
    assert.deepEqual(
      trace.filter((step) => step.includes('setup')),
      [],
    )
  })

  it('sets up in the order the sequenced list reaches the projects, which the larger test file decides, not the config’s', async () => {
    const p = await makeProject({
      'shared.ts': noting('setup shared'),
      'two.ts': noting('setup two'),
      'down-shared.ts': noting('teardown shared'),
      'down-two.ts': noting('teardown two'),
      'small.test.js': "test('small', () => {})",
      'large.test.js': `// the larger file: Jest's sequencer, with no history, runs the larger file first\ntest('large', () => {})`,
    })
    const first = withHooks(
      runtimeProject(p.dir, {
        name: 'first',
        include: ['small.test.js'],
        policy: { orchestrator: JEST_HOOKS },
      }),
      {
        setup: [p.path('shared.ts')],
        teardown: [p.path('down-shared.ts')],
        args: { globalConfig: {}, projectConfig: { name: 'first' } },
      },
    )
    const second = withHooks(
      runtimeProject(p.dir, {
        name: 'second',
        include: ['large.test.js'],
        policy: { orchestrator: JEST_HOOKS },
      }),
      {
        setup: [p.path('two.ts'), p.path('shared.ts')],
        teardown: [p.path('down-two.ts'), p.path('down-shared.ts')],
        args: { globalConfig: {}, projectConfig: { name: 'second' } },
      },
    )
    const [, trace] = await traced((t) => runAll([first, second], t))
    assert.deepEqual(
      trace.filter((step) => /setup|teardown|config/.test(step)),
      [
        // The second project's hooks, in its own order, then the first's that it didn't name.
        'setup two',
        '  config second',
        'setup shared',
        '  config second',
        'teardown two',
        '  config second',
        'teardown shared',
        '  config second',
      ],
    )
  })
})

/** The controllers a hook reaches as `__abort()` and `__force()`, so it can interrupt its own run. */
async function withSignals<T>(
  body: (signals: { abort: AbortController; force: AbortController }) => Promise<T>,
): Promise<T> {
  const signals = { abort: new AbortController(), force: new AbortController() }
  Reflect.set(globalThis, '__abort', () => signals.abort.abort('SIGINT'))
  Reflect.set(globalThis, '__force', () => signals.force.abort('SIGINT'))
  try {
    return await body(signals)
  } finally {
    Reflect.deleteProperty(globalThis, '__abort')
    Reflect.deleteProperty(globalThis, '__force')
  }
}

const HANG = 'await new Promise(() => {})'
const abortNow = ';(globalThis as any).__abort()'
const forceNow = ';(globalThis as any).__force()'

describe('what a hook is called with, and how its failure is reported', () => {
  /**
   * The error a run of a Jest-signature project whose setup throws `thrown` fails with, under
   * the neutral `failure` behaviour, or under the one `failureSource` writes into the project.
   */
  async function failedWith(thrown: string, failureSource?: string) {
    const p = await makeProject({
      'setup.ts': `module.exports = async () => { ${thrown} }`,
      'a.test.js': "test('a', () => {})",
      ...(failureSource === undefined ? {} : { 'failure.ts': failureSource }),
    })
    const project = withHooks(
      runtimeProject(p.dir, {
        policy: {
          orchestrator: {
            globalSetup: {
              ...JEST_HOOKS.globalSetup,
              ...(failureSource === undefined
                ? {}
                : { failure: { module: p.path('failure.ts'), export: 'failure' } }),
            },
          },
        },
      }),
      { setup: [p.path('setup.ts')], teardown: [] },
    )
    try {
      await traced((t) => runAll([project], t))
    } catch (error) {
      assert.ok(error instanceof OrchestratorError)
      return { error, path: p.path('setup.ts') }
    }
    return assert.fail('the run did not fail')
  }

  // The policy's behaviour, written as the project would supply it: it is given what was thrown,
  // the hook and the module, and its error is what the run fails with. Its stack is the header
  // alone, as the dialects' do for a value that is no Error.
  const FAILURE = [
    'export const failure = (thrown: unknown, context: { hook: string; path: string }) => {',
    "  const error = new Error(context.hook + ' at ' + context.path + ' threw <' + JSON.stringify(thrown) + '>')",
    "  error.stack = 'Error: ' + error.message",
    '  return error',
    '}',
  ].join('\n')

  it('fails with the error the policy’s failure makes of what the hook threw, and the hook and path it names', async () => {
    const { error, path } = await failedWith("throw { code: 42, nested: { list: ['a'] } }", FAILURE)
    assert.equal(error.code, 'ORCH_GLOBAL_SETUP_FAILED')
    assert.equal(
      error.message,
      `globalSetup at ${path} threw <{"code":42,"nested":{"list":["a"]}}>`,
    )
    assert.equal(
      hookFailureReport(error),
      `Error: ${error.message}\n`,
      'the policy’s error has no stack of its own to show',
    )
    const { error: text } = await failedWith("throw 'plain'", FAILURE)
    assert.match(text.message, /threw <"plain">$/)
  })

  it('prints the reported error’s class and message, then only its frames: a message that runs over lines is not repeated', async () => {
    // The neutral behaviour keeps the thrown error's frames under its own header.
    const { error, path } = await failedWith("throw new TypeError('bad\\nsecond line')")
    assert.equal(error.message, `globalSetup ${path} failed: bad\nsecond line`)
    const lines = hookFailureReport(error).split('\n')
    assert.equal(lines[0], `Error: globalSetup ${path} failed: bad`)
    assert.equal(lines[1], 'second line')
    const frames = lines.slice(2, -1)
    assert.ok(frames.length > 0, lines.join('\n'))
    assert.ok(
      frames.every((line) => /^\s+at /.test(line)),
      lines.join('\n'),
    )
    assert.equal(lines.filter((line) => line === 'second line').length, 1)
  })

  it('names the reported error’s own class in the header when the policy keeps the thrown error', async () => {
    const keeping = 'export const failure = (thrown: unknown) => thrown as Error'
    const { error } = await failedWith("throw new RangeError('out of range')", keeping)
    const [header, ...rest] = hookFailureReport(error).split('\n')
    assert.equal(header, 'RangeError: out of range')
    assert.ok(rest.slice(0, -1).every((line) => /^\s+at /.test(line)))
  })

  it('hands the hook the reader’s two configs as they are, the same objects to a setup and its teardown', async () => {
    const p = await makeProject({
      'setup.ts': [
        'module.exports = async (globalConfig: { rootDir: string; patterns: { isSet(): boolean } }) => {',
        "  ;(globalThis as any).__trace.push('seen ' + globalConfig.rootDir + ' ' + globalConfig.patterns.isSet())",
        '  ;(globalThis as any).__seen = globalConfig',
        '}',
      ].join('\n'),
      'teardown.ts': `module.exports = async (globalConfig: object) => { ;(globalThis as any).__trace.push('teardown ' + (globalConfig === (globalThis as any).__seen)) }`,
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [p.path('setup.ts')],
      teardown: [p.path('teardown.ts')],
      // Not JSON: a function and a class instance reach the hook whole.
      args: {
        globalConfig: { rootDir: '/the/root', patterns: { isSet: () => true } },
        projectConfig: new (class ProjectConfig {})(),
      },
    })
    try {
      const [, trace] = await traced((t) => runAll([project], t))
      assert.deepEqual(
        trace.filter((step) => /seen|teardown/.test(step)),
        ['seen /the/root true', 'teardown true'],
      )
    } finally {
      Reflect.deleteProperty(globalThis, '__seen')
    }
  })
})

describe('a signal while global hooks run (Ctrl+C, SIGTERM)', () => {
  it('sets nothing up when the run was interrupted before its setup', async () => {
    const p = await makeProject({
      'setup.ts': `module.exports = async () => { ${note('setup ran')} }`,
      'teardown.ts': `module.exports = async () => { ${note('teardown ran')} }`,
      'a.test.js': "__trace.push('file a')\ntest('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [p.path('setup.ts')],
      teardown: [p.path('teardown.ts')],
    })
    const abort = new AbortController()
    abort.abort('SIGTERM')
    const [, trace] = await traced((t) => runAll([project], t, abort.signal))
    assert.deepEqual(
      trace,
      ['run:start', 'run:end terminated'],
      'no hook, no file; the signal’s reason',
    )
  })

  it('stops waiting for a setup that hangs, ends the run with the signal’s reason and tears down what had set up', {
    timeout: 60_000,
  }, async () => {
    const p = await makeProject({
      'one.ts': `export default () => () => { ${note('teardown one')} }`,
      'hang.ts': `export default async () => { ${note('setup hang')}; ${abortNow}; ${HANG} }`,
      'never.ts': `export default () => { ${note('setup never')} }`,
      'down.ts': `module.exports = async () => { ${note('teardown module')} }`,
      'a.test.js': "__trace.push('file a')\ntest('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir), {
      setup: [p.path('one.ts'), p.path('hang.ts'), p.path('never.ts')],
      teardown: [p.path('down.ts')],
    })
    const [, trace] = await traced((t) =>
      withSignals(({ abort }) => runAll([project], t, abort.signal)),
    )
    assert.deepEqual(trace, ['setup hang', 'run:start', 'run:end interrupted', 'teardown one'])
  })

  it('stops waiting for a teardown that hangs when the signal comes, and runs the next one', {
    timeout: 60_000,
  }, async () => {
    const p = await makeProject({
      'hang.ts': `module.exports = async () => { ${note('teardown hang')}; ${abortNow}; ${HANG} }`,
      'good.ts': `module.exports = async () => { ${note('teardown good')} }`,
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [],
      teardown: [p.path('hang.ts'), p.path('good.ts')],
    })
    const [, trace] = await traced((t) =>
      withSignals(({ abort }) => runAll([project], t, abort.signal)),
    )
    assert.deepEqual(trace, ['run:start', 'run:end passed', 'teardown hang', 'teardown good'])
  })

  it('gives a teardown its time after the run was interrupted, until the force signal, which also skips the rest', {
    timeout: 60_000,
  }, async () => {
    const p = await makeProject({
      'slow.ts': `module.exports = async () => { ${note('teardown slow start')}; await new Promise((resolve) => setTimeout(resolve, 50)); ${note('teardown slow end')} }`,
      'hang.ts': `module.exports = async () => { ${note('teardown hang')}; ${forceNow}; ${HANG} }`,
      'skipped.ts': `module.exports = async () => { ${note('teardown skipped')} }`,
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { policy: { orchestrator: JEST_HOOKS } }), {
      setup: [],
      teardown: [p.path('slow.ts'), p.path('hang.ts'), p.path('skipped.ts')],
    })
    const [, trace] = await traced((t) =>
      withSignals(({ abort, force }) => {
        // Interrupted as the run starts; the force signal comes from the hanging teardown.
        return runAll([project], t, abort.signal, {
          forceSignal: force.signal,
          bus: createReporterBus([
            reporterOf(t),
            { name: 'interrupt', 'run:start': () => abort.abort('SIGINT') },
          ]),
        })
      }),
    )
    assert.deepEqual(trace, [
      'run:start',
      'run:end interrupted',
      'teardown slow start',
      'teardown slow end',
      'teardown hang',
    ])
  })
})

describe('the neutral signature: setup(context), a returned teardown', () => {
  it('passes the project and a provide, runs a returned function (or a named export) as the teardown, last setup first', async () => {
    const p = await makeProject({
      'one.ts': [
        'export default function setup(context: { provide(k: string, v: unknown): void; project: { name: string; root: string } }) {',
        `  ${note('setup one')}`,
        "  context.provide('dbUrl', 'sqlite://one')",
        "  ;(globalThis as any).__trace.push('project ' + context.project.name)",
        `  return () => { ${note('teardown one')} }`,
        '}',
      ].join('\n'),
      'two.ts': [
        `export function setup() { ${note('setup two')} }`,
        `export function teardown() { ${note('teardown two')} }`,
      ].join('\n'),
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir, { name: 'named' }), {
      setup: [p.path('one.ts'), p.path('two.ts')],
      teardown: [],
    })
    const [, trace] = await traced((t) => runAll([project], t))
    assert.deepEqual(
      trace.filter((step) => /setup|teardown|project/.test(step)),
      ['setup one', 'project named', 'setup two', 'teardown two', 'teardown one'],
    )
  })

  it('tears down what it set up when a later setup throws', async () => {
    const p = await makeProject({
      'one.ts': `export default () => () => { ${note('teardown one')} }`,
      'two.ts': "export default () => { throw new Error('two broke') }",
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir), {
      setup: [p.path('one.ts'), p.path('two.ts')],
      teardown: [],
    })
    const [error, trace] = await traced(async (t) => {
      try {
        await runAll([project], t)
      } catch (caught) {
        return caught
      }
      return undefined
    })
    assert.ok(error instanceof OrchestratorError)
    assert.match(error.message, /two broke/)
    assert.deepEqual(trace, ['teardown one'])
  })

  it('refuses a provided value that cannot cross to a worker', async () => {
    const p = await makeProject({
      'one.ts':
        "export default (context: { provide(k: string, v: unknown): void }) => context.provide('fn', () => 1)",
      'a.test.js': "test('a', () => {})",
    })
    const project = withHooks(runtimeProject(p.dir), { setup: [p.path('one.ts')], teardown: [] })
    await assert.rejects(
      traced((t) => runAll([project], t)),
      (error: unknown) =>
        error instanceof OrchestratorError &&
        error.code === 'ORCH_GLOBAL_SETUP_FAILED' &&
        /provide\("fn"\)/.test(error.message),
    )
  })
})
