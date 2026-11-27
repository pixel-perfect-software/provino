// A native jsdom file's queued work ends with its window (#227): a package that took `setImmediate`
// as it loaded (as React's scheduler does) and a test that queues work reading `window` as it
// ends; the file's own `setImmediate` flush helpers; a timer a file left that must not fire into
// the next file; and what a shared package keeps across files (its interval, its own port).
// Through the source bin.
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, POOLS, spawnCli } from './support.ts'

const JSDOM_CONFIG = "export default { include: ['tests/**/*.test.ts'], environment: 'jsdom' }\n"

/**
 * A queue that takes `setImmediate` once, as it loads, and posts one flush while work is waiting:
 * React's scheduler's shape (`localSetImmediate`, `isMessageLoopRunning`). A flush that never ran
 * would leave `posted` set, and no later work would ever run.
 */
const LATE_QUEUE: Readonly<Record<string, string>> = {
  'node_modules/late-queue/package.json':
    '{"name":"late-queue","version":"1.0.0","main":"index.js"}\n',
  'node_modules/late-queue/index.js': [
    "const localSetImmediate = typeof setImmediate === 'function' ? setImmediate : null",
    'let posted = false',
    'const waiting = []',
    'function flush() {',
    '  posted = false',
    '  while (waiting.length > 0) waiting.shift()()',
    '}',
    'exports.schedule = (work) => {',
    '  waiting.push(work)',
    '  if (!posted) {',
    '    posted = true',
    '    localSetImmediate(flush)',
    '  }',
    '}',
    '',
  ].join('\n'),
}

/** A test whose last act queues work that reads the window, as a component's commit does. */
function queuesAsItEnds(name: string): string {
  return [
    "import { expect, it } from 'provino'",
    "import { schedule } from 'late-queue'",
    "it('runs queued work while the window is there', async () => {",
    '  await new Promise((resolve) => schedule(resolve))',
    `  schedule(() => { document.title = '${name}' })`,
    "  expect(typeof setImmediate).toBe('function')",
    '})',
    '',
  ].join('\n')
}

/** React's own case: a component whose last update lands after the test body. */
const REACT_LATE = [
  "import { expect, it } from 'provino'",
  "import { createElement, useEffect, useState } from 'react'",
  "import { createRoot } from 'react-dom/client'",
  'function Late() {',
  "  const [answer, setAnswer] = useState('waiting')",
  "  useEffect(() => void Promise.resolve().then(() => setAnswer('done')), [])",
  "  return createElement('p', null, answer)",
  '}',
  "it('renders a component whose last update lands after the test body', async () => {",
  "  const root = document.body.appendChild(document.createElement('div'))",
  '  createRoot(root).render(createElement(Late))',
  '  // The first render commits on the scheduler, outside act(): a stuck scheduler never gets here.',
  "  while (root.textContent === '') await new Promise((resolve) => setTimeout(resolve, 5))",
  '  expect(root.textContent).toMatch(/^(waiting|done)$/)',
  '})',
  '',
].join('\n')

/** `react` and `react-dom` from this package's devDependencies, linked into a project. */
function linkReact(dir: string): void {
  const modules = fileURLToPath(new URL('../node_modules/', import.meta.url))
  for (const name of ['react', 'react-dom']) {
    symlinkSync(join(modules, name), join(dir, 'node_modules', name), 'dir')
  }
}

describe('work a native jsdom file queued as it ended', () => {
  for (const pool of POOLS) {
    test(`runs with the window, and the next files' work still runs, on the ${pool} pool`, async () => {
      const dir = await nativeProject(
        {
          ...LATE_QUEUE,
          'tests/a.test.ts': queuesAsItEnds('a'),
          'tests/b.test.ts': queuesAsItEnds('b'),
          'tests/c.test.ts': queuesAsItEnds('c'),
        },
        JSDOM_CONFIG,
      )
      const ran = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      const outcomes = await outcomesByFile(dir)
      expect({
        a: outcomes.get('a.test.ts'),
        b: outcomes.get('b.test.ts'),
        c: outcomes.get('c.test.ts'),
      }).toEqual({ a: 'passed', b: 'passed', c: 'passed' })
      expect(ran.code).toBe(0)
    })
  }

  test("React's late commit passes, and React still renders in the next files of the worker", async () => {
    const dir = await nativeProject(
      {
        'tests/a.test.ts': REACT_LATE,
        'tests/b.test.ts': REACT_LATE,
        'tests/c.test.ts': REACT_LATE,
      },
      JSDOM_CONFIG,
    )
    linkReact(dir)
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    const outcomes = await outcomesByFile(dir)
    expect({
      a: outcomes.get('a.test.ts'),
      b: outcomes.get('b.test.ts'),
      c: outcomes.get('c.test.ts'),
    }).toEqual({ a: 'passed', b: 'passed', c: 'passed' })
    expect(ran.code).toBe(0)
  })

  test("a test's own setImmediate flush still runs during the test", async () => {
    const flush = [
      "import { expect, it } from 'provino'",
      "it('flushes with setImmediate', async () => {",
      '  let done = false',
      '  setTimeout(() => { done = true }, 0)',
      '  await new Promise((resolve) => setImmediate(resolve))',
      '  await new Promise((resolve) => setTimeout(resolve, 5))',
      '  expect(done).toBe(true)',
      '})',
      '',
    ].join('\n')
    const dir = await nativeProject({ 'tests/flush.test.ts': flush }, JSDOM_CONFIG)
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect((await outcomesByFile(dir)).get('flush.test.ts')).toBe('passed')
    expect(ran.code).toBe(0)
  })

  test('a timeout a file left does not fire into the next file of the worker', async () => {
    // Each file leaves a timeout as it ends and first checks that none of another file's fired:
    // whichever runs second holds the first to it.
    const leaving = (name: string): string =>
      [
        "import { expect, it } from 'provino'",
        "it('sees no timeout of another file', async () => {",
        '  await new Promise((resolve) => setTimeout(resolve, 80))',
        '  expect((globalThis as { __fired?: string }).__fired).toBeUndefined()',
        '})',
        "it('leaves a timeout behind', () => {",
        `  setTimeout(() => { (globalThis as { __fired?: string }).__fired = '${name}' }, 20)`,
        '})',
        '',
      ].join('\n')
    const dir = await nativeProject(
      { 'tests/a.test.ts': leaving('a'), 'tests/b.test.ts': leaving('b') },
      JSDOM_CONFIG,
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    const outcomes = await outcomesByFile(dir)
    expect({ a: outcomes.get('a.test.ts'), b: outcomes.get('b.test.ts') }).toEqual({
      a: 'passed,passed',
      b: 'passed,passed',
    })
    expect(ran.code).toBe(0)
  })

  test("a shared package's interval and its own MessagePort keep working in the next file", async () => {
    // Started on first use, in whichever file runs first, and kept by the worker's one copy.
    const ticker: Readonly<Record<string, string>> = {
      'node_modules/ticker/package.json': '{"name":"ticker","version":"1.0.0","main":"index.js"}\n',
      'node_modules/ticker/index.js': [
        'let ticks = 0',
        'let channel',
        'const pending = []',
        'exports.start = () => {',
        '  if (channel !== undefined) return',
        '  setInterval(() => { ticks++ }, 5).unref()',
        '  channel = new MessageChannel()',
        '  channel.port1.onmessage = () => pending.shift()()',
        '  channel.port1.unref()',
        '}',
        'exports.ticks = () => ticks',
        'exports.ping = () => new Promise((resolve) => { pending.push(resolve); channel.port2.postMessage(0) })',
        '',
      ].join('\n'),
    }
    const using = [
      "import { expect, it } from 'provino'",
      "import { ping, start, ticks } from 'ticker'",
      "it('ticks and answers', async () => {",
      '  start()',
      '  const before = ticks()',
      '  await new Promise((resolve) => setTimeout(resolve, 40))',
      '  expect(ticks()).toBeGreaterThan(before)',
      '  await ping()',
      '})',
      '',
    ].join('\n')
    const dir = await nativeProject(
      { ...ticker, 'tests/a.test.ts': using, 'tests/b.test.ts': using },
      JSDOM_CONFIG,
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    const outcomes = await outcomesByFile(dir)
    expect({ a: outcomes.get('a.test.ts'), b: outcomes.get('b.test.ts') }).toEqual({
      a: 'passed',
      b: 'passed',
    })
    expect(ran.code).toBe(0)
  })
})
