// T9.15: global setup and teardown run in the coordinator, through the loader in coordinator mode
// (U5): once per distinct path, per project in the config's order, teardown after the run (in the
// order the policy says), a throw fails the run with the policy's text. The files run inline, so
// the setups, the tests and the reporter all write to one `globalThis.__trace`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResolvedGlobalSetup, ResolvedProject } from '@provino/config'
import { OrchestratorError, type RunProjectOptions, runProjects } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { PolicyOverrides, Reporter } from '@provino/types'
import { Collect, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const JEST_HOOKS: NonNullable<PolicyOverrides['orchestrator']> = {
  globalSetup: {
    signature: 'global-and-project-config',
    teardownOrder: 'in-order',
    failureMessage: 'Hook {hook} at {path} said: {message}',
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

  it('fails the run with the policy’s text when a setup throws: no file runs, reporters hear nothing, the cause is kept', async () => {
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
    assert.equal(error.message, `Hook globalSetup at ${p.path('setup.ts')} said: setup failed`)
    assert.equal((error.cause as Error).message, 'setup failed')
    assert.deepEqual(trace, [], 'no run:start, no file, and Jest runs no teardown here')
  })

  it('refuses a module that does not export a function, by the same text', async () => {
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
        message: `Hook globalSetup at ${p.path('setup.ts')} said: globalSetup file must export a function at ${p.path('setup.ts')}`,
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
    const abort = new AbortController()
    abort.abort()
    const [error, trace] = await traced(async (t) => {
      try {
        await runAll([project], t, abort.signal)
      } catch (caught) {
        return caught
      }
      return undefined
    })
    assert.ok(error instanceof OrchestratorError)
    assert.equal(
      error.message,
      `Hook globalTeardown at ${p.path('down-bad.ts')} said: teardown failed`,
    )
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
