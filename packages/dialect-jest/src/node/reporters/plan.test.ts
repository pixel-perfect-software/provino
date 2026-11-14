// `jestReporterPlan` against `TestScheduler._setupReporters` (jest-core 30.5.2 L382-L431): the order
// the reporters are added in, which names set the summary's options (the last wins), and the
// environment-dependent ones.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type JestReporterEnvironment, jestReporterPlan } from './plan.ts'

const PLAIN: JestReporterEnvironment = { agent: false, githubActions: false }

const entry = (name: string, options: Record<string, unknown> = {}) => [name, options] as const

describe('jestReporterPlan', () => {
  it('with none named runs default and a summary, as Jest does', () => {
    assert.deepEqual(jestReporterPlan({ reporters: undefined }, [{}], PLAIN), {
      steps: [{ kind: 'builtin', name: 'default', options: {} }],
      summary: { options: {} },
    })
  })

  it('with none named runs agent under an agent, and adds github-actions on GitHub Actions (D88)', () => {
    const plan = jestReporterPlan({ reporters: undefined }, [{}], {
      agent: true,
      githubActions: true,
    })
    assert.deepEqual(
      plan.steps.map((step) => step.kind === 'builtin' && step.name),
      ['agent', 'github-actions'],
    )
    assert.ok(plan.summary !== undefined)
  })

  it('makes default verbose when the global config or any project is verbose', () => {
    const named = { reporters: [entry('default')] }
    assert.deepEqual(jestReporterPlan({ ...named, verbose: true }, [{}], PLAIN).steps, [
      { kind: 'builtin', name: 'verbose', options: {} },
    ])
    const byProject = jestReporterPlan(named, [{}, { verbose: true }], PLAIN)
    assert.deepEqual(byProject.steps, [{ kind: 'builtin', name: 'verbose', options: {} }])
    // `verbose: false` is not verbose.
    assert.deepEqual(
      jestReporterPlan({ ...named, verbose: false }, [{ verbose: false }], PLAIN).steps,
      [{ kind: 'builtin', name: 'default', options: {} }],
    )
  })

  it('keeps the order of the names, with the summary as its own entry after them', () => {
    const plan = jestReporterPlan(
      {
        reporters: [
          entry('/abs/custom-a.js', { a: 1 }),
          entry('default'),
          entry('/abs/custom-b.js'),
          entry('summary', { summaryThreshold: 3 }),
        ],
      },
      [{}],
      PLAIN,
    )
    assert.deepEqual(plan.steps, [
      { kind: 'custom', path: '/abs/custom-a.js', options: { a: 1 } },
      { kind: 'builtin', name: 'default', options: {} },
      { kind: 'custom', path: '/abs/custom-b.js', options: {} },
    ])
    // The last of default, agent and summary decides the options.
    assert.deepEqual(plan.summary, { options: { summaryThreshold: 3 } })
  })

  it('has no summary when neither default, agent nor summary is named', () => {
    const plan = jestReporterPlan({ reporters: [entry('/abs/custom.js')] }, [{}], PLAIN)
    assert.equal(plan.summary, undefined)
    assert.equal(plan.steps.length, 1)
  })

  it('adds github-actions only on GitHub Actions when it is named, and not otherwise', () => {
    const named = { reporters: [entry('default'), entry('github-actions')] }
    assert.deepEqual(
      jestReporterPlan(named, [{}], PLAIN).steps.map(
        (step) => step.kind === 'builtin' && step.name,
      ),
      ['default'],
    )
    assert.deepEqual(
      jestReporterPlan(named, [{}], { ...PLAIN, githubActions: true }).steps.map(
        (step) => step.kind === 'builtin' && step.name,
      ),
      ['default', 'github-actions'],
    )
    // Named without a default, nothing adds a second one.
    const only = jestReporterPlan({ reporters: [entry('github-actions')] }, [{}], {
      ...PLAIN,
      githubActions: true,
    })
    assert.equal(only.steps.length, 1)
  })

  it("the last of several summary-setting names wins: ['summary'] after 'default'", () => {
    const plan = jestReporterPlan(
      {
        reporters: [
          entry('summary', { summaryThreshold: 1 }),
          entry('agent', { summaryThreshold: 2 }),
        ],
      },
      [{}],
      PLAIN,
    )
    assert.deepEqual(plan.summary, { options: { summaryThreshold: 2 } })
    assert.deepEqual(plan.steps, [
      { kind: 'builtin', name: 'agent', options: { summaryThreshold: 2 } },
    ])
  })
})
