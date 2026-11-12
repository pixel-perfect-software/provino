// B17a's end-to-end checks through a real `run()` and forked workers: the fake clock of a file
// (T4.9, T4.10: a callback fires as the test that scheduled it), and the errors a test leaves behind
// (T5.11: a late timer's exception fails the test that made the timer). The projects are generated
// into $TMPDIR as text (no `.js` is committed, D13).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { run } from 'provino/node'
import { Collect, type Project, trackedProjects, viewOfNormalized } from './support.ts'

const makeProject = trackedProjects()

/** Runs a project on forks with the normalized-json reporter, and reads back the file. */
async function runWithJson(project: Project) {
  const stdout = new Collect()
  const stderr = new Collect()
  const outputFile = project.path('out.json')
  const result = await run({
    config: project.config,
    pool: 'forks',
    maxWorkers: 1,
    cache: false,
    reporters: [['normalized-json', { outputFile }]],
    stdout,
    stderr,
  })
  const view = viewOfNormalized(await readFile(outputFile, 'utf8'))
  // Every test of every file, by its title path.
  const statuses = Object.fromEntries([...view.files.values()].flatMap((file) => [...file.tests]))
  return { result, view: { ...view, statuses }, stderr: stderr.text }
}

describe('fake timers through run()', () => {
  it('fires a callback as the test that scheduled it, whoever advances the clock', async () => {
    const project = await makeProject({
      'tests/attribution.test.js': [
        'const seen = []',
        "test('schedules', () => {",
        '  jest.useFakeTimers()',
        '  setTimeout(() => seen.push(expect.getState().currentTestName), 10)',
        '})',
        "test('advances', () => {",
        '  jest.advanceTimersByTime(10)',
        "  expect(seen).toEqual(['schedules'])",
        "  expect(expect.getState().currentTestName).toBe('advances')",
        '  jest.useRealTimers()',
        '})',
        '',
      ].join('\n'),
    })
    const { result, view } = await runWithJson(project)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(view.statuses, { schedules: 'passed', advances: 'passed' })
  })

  it('puts the real timers back at the end of the file', async () => {
    const project = await makeProject({
      'tests/a-leaves-fake.test.js': [
        "test('leaves fake timers installed', () => {",
        '  jest.useFakeTimers()',
        "  expect('clock' in setTimeout).toBe(true)",
        '})',
        '',
      ].join('\n'),
      'tests/b-sees-real.test.js': [
        "test('sees the real timers', () => {",
        "  expect('clock' in setTimeout).toBe(false)",
        '  expect(Date.now()).toBeGreaterThan(1_700_000_000_000)',
        '})',
        '',
      ].join('\n'),
    })
    const { result, view } = await runWithJson(project)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(Object.values(view.statuses), ['passed', 'passed'])
  })

  it('warns, with Jest`s text, when the clock is advanced while the timers are real', async () => {
    const project = await makeProject({
      'tests/not-faked.test.js': [
        "test('advances real timers', () => {",
        '  const lines = []',
        '  const warn = console.warn',
        "  console.warn = (...args) => { lines.push(args.join(' ')) }",
        '  try { jest.advanceTimersByTime(10) } finally { console.warn = warn }',
        '  expect(lines).toHaveLength(1)',
        '  expect(lines[0]).toMatch(/^A function to advance timers was called but the timers APIs are not replaced with fake timers\\. Call `jest\\.useFakeTimers\\(\\)` in this test file/)',
        "  expect(lines[0]).toContain('\\nStack Trace:\\n')",
        '})',
        '',
      ].join('\n'),
    })
    const { result, view } = await runWithJson(project)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(view.statuses, { 'advances real timers': 'passed' })
  })
})

describe('errors a test leaves behind, through run()', () => {
  it('fails the test whose timer throws after it ended, not the one that was running', async () => {
    const project = await makeProject({
      'tests/late.test.js': [
        'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
        "test('leaves a throwing timer', () => {",
        "  setTimeout(() => { throw new Error('thrown after its test ended') }, 30)",
        '})',
        "test('is running when it fires', () => sleep(150))",
        "test('runs after', () => {})",
        '',
      ].join('\n'),
    })
    const { result, view } = await runWithJson(project)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(view.statuses, {
      'leaves a throwing timer': 'failed',
      'is running when it fires': 'passed',
      'runs after': 'passed',
    })
  })

  it('fails the test that left a rejection nobody handled', async () => {
    const project = await makeProject({
      'tests/rejection.test.js': [
        "test('leaves a rejected promise', () => {",
        "  void Promise.reject(new Error('rejected and left unhandled'))",
        '})',
        "test('is fine', () => {})",
        '',
      ].join('\n'),
    })
    const { result, view } = await runWithJson(project)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(view.statuses, { 'leaves a rejected promise': 'failed', 'is fine': 'passed' })
  })
})
