// `--notify` (B23d A4): the reporter that rebuilds Jest's `NotifyReporter` and where it finds
// `node-notifier`. What Jest sent a fake notifier for real projects is held by `provino`'s
// `jest-notify.test.ts` (`cli/notify-*`); these check each mode against the reporter's own table.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { AggregatedResult } from '@provino/dialect-jest/results'
import {
  createNotifyReporter,
  type JestNotifier,
  JestNotifierMissingError,
  loadJestNotifier,
} from './notify.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tmp(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-notify-')))
  made.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

function aggregate(counts: {
  readonly passed: number
  readonly failed: number
  readonly suitesBroken?: number
}): AggregatedResult {
  return {
    numFailedTests: counts.failed,
    numPassedTests: counts.passed,
    numTotalTests: counts.failed + counts.passed,
    numRuntimeErrorTestSuites: counts.suitesBroken ?? 0,
  } as AggregatedResult
}

/** The calls the reporter makes for one run in `notifyMode`. */
async function calls(
  notifyMode: string,
  result: AggregatedResult,
  rootDir = '/nowhere-at-all',
  icon?: string,
): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = []
  const notifier: JestNotifier = { notify: (options) => void sent.push({ ...options }) }
  const reporter = createNotifyReporter({
    globalConfig: { rootDir, notifyMode },
    loaded: { notifier, ...(icon === undefined ? {} : { icon }) },
    aggregated: () => result,
  })
  await reporter['run:end']?.({} as never)
  return sent
}

const PASSING = aggregate({ passed: 3, failed: 0 })
const FAILING = aggregate({ passed: 2, failed: 1 })

describe('which runs each notifyMode tells about (a first run, which is a change)', () => {
  for (const [mode, onPass, onFail] of [
    ['always', true, true],
    ['success', true, false],
    ['failure', false, true],
    ['change', true, true],
    ['success-change', true, true],
    ['failure-change', true, true],
  ] as const) {
    it(`${mode}: ${onPass ? 'a pass' : 'no pass'}, ${onFail ? 'a failure' : 'no failure'}`, async () => {
      assert.equal((await calls(mode, PASSING)).length, onPass ? 1 : 0)
      assert.equal((await calls(mode, FAILING)).length, onFail ? 1 : 0)
    })
  }

  it('says nothing when no test ran', async () => {
    assert.deepEqual(await calls('always', aggregate({ passed: 0, failed: 0 })), [])
  })

  it('counts a suite that failed to run as a failure', async () => {
    const sent = await calls('failure', aggregate({ passed: 3, failed: 0, suitesBroken: 1 }))
    assert.equal(sent.length, 1)
    assert.match(String(sent[0]?.title), /0% Failed$/)
  })
})

describe('the notification', () => {
  it('has Jest’s title and message, without a package prefix when there is no root package.json name', async () => {
    const [pass] = await calls('always', PASSING)
    assert.equal(String(pass?.title).includes('100% Passed'), true)
    assert.match(String(pass?.message), /3 tests passed$/)
    const [fail] = await calls('always', FAILING)
    assert.match(String(fail?.title), /34% Failed$/)
    assert.match(String(fail?.message), /1 of 3 tests failed$/)
    assert.equal(pass?.hint, 'int:transient:1')
    assert.equal(pass?.timeout, false)
  })

  it('pluralizes a single passing test', async () => {
    const [pass] = await calls('always', aggregate({ passed: 1, failed: 0 }))
    assert.match(String(pass?.message), /1 test passed$/)
  })

  it('starts the title with the root package.json’s name, the root when there is none, nothing for a nameless one', async () => {
    const named = await tmp({ 'package.json': '{"name":"demo"}' })
    assert.match(String((await calls('always', PASSING, named))[0]?.title), /^demo - 100% Passed$/)
    const bare = await tmp({ 'a.txt': '' })
    assert.equal((await calls('always', PASSING, bare))[0]?.title, `${bare} - 100% Passed`)
    const nameless = await tmp({ 'package.json': '{}' })
    assert.equal((await calls('always', PASSING, nameless))[0]?.title, '100% Passed')
  })

  it('names the icon the loader found, and none when it found none', async () => {
    const [sent] = await calls('always', PASSING, '/nowhere-at-all', '/somewhere/jest_logo.png')
    assert.equal(sent?.icon, '/somewhere/jest_logo.png')
    assert.equal('icon' in ((await calls('always', PASSING))[0] ?? {}), false)
  })
})

describe('where node-notifier comes from', () => {
  const FAKE = 'module.exports = { notify() {} }\n'

  it('is the project, found from its root', async () => {
    const root = await tmp({ 'node_modules/node-notifier/index.js': FAKE })
    const loaded = loadJestNotifier(root)
    assert.equal(typeof loaded.notifier.notify, 'function')
    assert.equal(loaded.icon, undefined, 'no @jest/reporters, no icon')
  })

  it('is the install of @jest/reporters when the project has none of its own', async () => {
    const root = await tmp({
      'node_modules/@jest/reporters/package.json': '{"name":"@jest/reporters"}',
      'node_modules/@jest/reporters/node_modules/node-notifier/index.js': FAKE,
      'node_modules/@jest/reporters/assets/jest_logo.png': 'x',
    })
    const loaded = loadJestNotifier(root)
    assert.equal(typeof loaded.notifier.notify, 'function')
    // The icon is the logo of that same install, found by the one search.
    assert.equal(loaded.icon, join(root, 'node_modules/@jest/reporters/assets/jest_logo.png'))
  })

  it('is Jest’s message, from where Jest builds the reporter, when it is nowhere', async () => {
    const root = await tmp({ 'a.txt': '' })
    assert.throws(
      () => loadJestNotifier(root),
      (error: unknown) =>
        error instanceof JestNotifierMissingError &&
        error.message ===
          'notify reporter requires optional peer dependency "node-notifier" but it was not found',
    )
  })

  it('is the same message for a module that has no notify function', async () => {
    const root = await tmp({ 'node_modules/node-notifier/index.js': 'module.exports = {}\n' })
    assert.throws(() => loadJestNotifier(root), JestNotifierMissingError)
  })
})
