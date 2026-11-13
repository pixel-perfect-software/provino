// Lazy variables end to end, on the built package in a real project layout: a TypeScript test file
// writes `import { lazy } from 'provino'` and it works under `provino jest` and `provino run`, in
// forked workers, with the dialect's `describe`/`it`/`expect` still its globals (and
// `@jest/globals` with `injectGlobals: false`). `lazy` is never a global. Every scenario is a test
// file that asserts inside the worker; the outer test reads the verdict of the run.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { childEnv, runBuilt, viewOfNormalized } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** The line of the one line of `text` that holds `marker` (1-based). */
function lineOf(text: string, marker: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(marker))
  assert.ok(index >= 0, marker)
  return index + 1
}

const MEMO = `import { lazy } from 'provino'

interface User {
  readonly name: string
}

let created = 0
const order: string[] = []
const $ = lazy
  .let('user', (): User => ({ name: \`user-\${++created}\` }))
  .let('greeting', ({ user }) => \`hello \${user.name}\`)

beforeEach(() => void order.push('before-1'))
const $db = lazy.eager('db', () => {
  order.push('eager')
  return { open: true }
})
beforeEach(() => void order.push('before-2'))
afterEach(() => void (order.length = 0))

it('is not a global', () => {
  expect(typeof (globalThis as { lazy?: unknown }).lazy).toBe('undefined')
})

describe('a memo per test', () => {
  it('reads the same value twice in one test', () => {
    expect($.user).toBe($.user)
    expect($.greeting).toBe(\`hello \${$.user.name}\`)
    expect($.user.name).toBe('user-1')
  })
  it('makes a new one for the next test', () => {
    expect($.user.name).toBe('user-2')
  })
})

describe('an override with parent()', () => {
  $.override('user', (_deps, { parent }): User => ({ name: \`\${parent().name}+over\` }))
  describe('nested', () => {
    $.override('user', (_deps, { parent }): User => ({ name: \`\${parent().name}!\` }))
    it('late-binds the greeting to the innermost override', () => {
      expect($.greeting).toMatch(/^hello user-\\d+\\+over!$/)
    })
  })
})

describe('eager', () => {
  it('runs between the two beforeEach hooks, in the order they were written', () => {
    expect(order).toEqual(['before-1', 'eager', 'before-2'])
    expect($db.db.open).toBe(true)
  })
})

describe('test.concurrent', () => {
  const $c = lazy.let('token', () => Symbol('token'))
  const seen: symbol[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15))
  test.concurrent('first', async () => {
    const own = $c.token
    await settle()
    expect($c.token).toBe(own)
    seen.push(own)
  })
  test.concurrent('second', async () => {
    const own = $c.token
    await settle()
    expect($c.token).toBe(own)
    seen.push(own)
  })
  afterAll(() => {
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})
`

const FILE_SCOPE = `import { lazy } from 'provino'

let opened = 0
const $ = lazy.let('conn', () => ({ id: ++opened }), { scope: 'file' })

describe('file scope', () => {
  it('opens one connection for the file', () => {
    expect($.conn.id).toBe(1)
  })
  it('reuses it in the next test', () => {
    expect($.conn).toBe($.conn)
    expect(opened).toBe(1)
  })
})
`

/** Both files import this one, so the worker value is keyed by one definition site. */
const WORKER_HELPER = `import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lazy } from 'provino'

// Each file has its own module copy and its own \`process\`, so the evaluations are counted on disk.
const log = join(process.cwd(), 'evaluations.log')
export const $ = lazy.let(
  'pool',
  () => {
    appendFileSync(log, 'x')
    return { id: readFileSync(log, 'utf8').length }
  },
  { scope: 'worker' },
)
export const evaluated = (): number => readFileSync(log, 'utf8').length
`

const WORKER_FILE = `import { $, evaluated } from './worker-helper.ts'

it('shares one worker value across the files of a worker', () => {
  expect($.pool.id).toBe(1)
  expect(evaluated()).toBe(1)
})
`

const SHARED = `import { itBehavesLike, lazy, sharedExamples } from 'provino'

const aNumber = sharedExamples<{ subject: number }, [label: string]>('a number', ($, label) => {
  const $g = $.let('double', ({ subject }) => subject * 2)
  it(\`\${label} doubles\`, () => {
    expect($g.double).toBe($g.subject * 2)
    expect([1, 5]).toContain($g.subject)
  })
})

const $ = lazy.let('subject', () => 1)
itBehavesLike(aNumber, $, 'plain')
describe('over', () => {
  $.override('subject', () => 5)
  itBehavesLike(aNumber, $, 'big')
})
`

const SITE = `import { lazy } from 'provino'

type Wide<T> = {
  readonly value: T
}
enum Mode {
  On,
  Off,
}
const mode: Mode = Mode.On

lazy.let('key', () => 1 as number)

let duplicate: { code?: string; site?: { file: string; line: number } } = {}
try {
  lazy.let('key', () => 2) // LAZY_SITE_MARK
} catch (error) {
  duplicate = error as typeof duplicate
}

it('names the duplicate where it is written, not in the transformed output', () => {
  expect(mode).toBe(Mode.On)
  expect(duplicate.code).toBe('LAZY_DUPLICATE')
  expect(duplicate.site?.file).toMatch(/site\\.test\\.ts$/)
  expect(duplicate.site?.line).toBe(Number(process.env.EXPECTED_SITE_LINE))
})
`

const NO_GLOBALS = `import { describe, expect, it } from '@jest/globals'
import { lazy } from 'provino'

const $ = lazy.let('n', () => 41).let('next', ({ n }) => n + 1)

describe('injectGlobals: false', () => {
  it('has no globals and still has lazy', () => {
    expect(typeof (globalThis as { it?: unknown }).it).toBe('undefined')
    expect(typeof (globalThis as { lazy?: unknown }).lazy).toBe('undefined')
    expect($.next).toBe(42)
  })
})
`

const DOM = `import { lazy } from 'provino'

const $ = lazy.let('node', () => {
  const el = document.createElement('p')
  el.textContent = 'lazy'
  document.body.append(el)
  return el
})

it('evaluates in a jsdom file', () => {
  expect(typeof window).toBe('object')
  expect($.node.ownerDocument).toBe(document)
  expect(document.body.textContent).toBe('lazy')
})
`

const FAILING = `import { lazy } from 'provino'

const $ = lazy
  .let('db', () => ({ open: true }))
  .let('user', ({ db }) => {
    if (db.open) throw new Error('no such user') // LAZY_THROW_MARK
    return 'ada'
  })
  .let('cart', ({ user }) => [user])
  .let('later', () => 1)

it('fails reading a cart whose user cannot be made', () => {
  void $.later
  void $.cart
})

it('passes and lists nothing', () => {
  expect($.db.open).toBe(true)
})
`

/** The files every project holds. */
const FILES: Readonly<Record<string, string>> = {
  'tests/memo.test.ts': MEMO,
  'tests/file-scope.test.ts': FILE_SCOPE,
  'tests/worker-helper.ts': WORKER_HELPER,
  'tests/worker-a.test.ts': WORKER_FILE,
  'tests/worker-b.test.ts': WORKER_FILE,
  'tests/shared.test.ts': SHARED,
  'tests/site.test.ts': SITE,
  'dom/dom.test.ts': DOM,
}

/** Tests under `tests/`: memo 7 (a global check, 2, 1, 1, 2 concurrent), 2, 1 + 1, 2, 1. */
const TEST_COUNT = 7 + 2 + 2 + 2 + 1
const SUITE_COUNT = 6

async function project(files: Readonly<Record<string, string>>, extra = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-lazy-'))
  after(() => rm(dir, { recursive: true, force: true }))
  const all: Record<string, string> = {
    'package.json': `{"type":"module","jest":{"testMatch":["**/tests/**/*.test.ts"]${extra}}}\n`,
    'provino.config.mjs': "export default { dialect: 'jest', include: ['tests/**/*.test.ts'] }\n",
    'jsdom.config.mjs':
      "export default { dialect: 'jest', environment: 'jsdom', isolation: 'registry', include: ['dom/**/*.test.ts'] }\n",
    ...files,
  }
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE, join(dir, 'node_modules', 'provino'), 'dir')
  return dir
}

const ENV = { EXPECTED_SITE_LINE: String(lineOf(SITE, 'LAZY_SITE_MARK')) }

describe('lazy variables on the built package', () => {
  test('provino jest: memo, override, eager, scopes over two files with -w 1, concurrent, shared, site', async () => {
    const dir = await project(FILES)
    const run = runBuilt(['jest', '--ci', '-w', '1'], { cwd: dir, env: ENV })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(
      run.stderr,
      new RegExp(`Tests:\\s+${TEST_COUNT} passed, ${TEST_COUNT} total`),
      run.stderr,
    )
    assert.match(
      run.stderr,
      new RegExp(`Test Suites:\\s+${SUITE_COUNT} passed, ${SUITE_COUNT} total`),
    )
  })

  test('provino run: the same files, as the neutral runner', async () => {
    const dir = await project(FILES)
    const run = runBuilt(
      [
        'run',
        '--config',
        'provino.config.mjs',
        '--maxWorkers',
        '1',
        '--pool',
        'forks',
        '--reporter',
        'json',
      ],
      { cwd: dir, env: ENV },
    )
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const view = viewOfNormalized(run.stdout)
    assert.equal(view.success, true)
    const statuses = [...view.files.values()].flatMap((file) => [...file.tests.values()])
    assert.equal(statuses.length, TEST_COUNT)
    assert.ok(
      statuses.every((status) => status === 'passed'),
      statuses.join(','),
    )
  })

  test('provino run in the inline pool', async () => {
    const dir = await project({ 'tests/memo.test.ts': MEMO, 'tests/shared.test.ts': SHARED })
    const run = runBuilt(
      ['run', '--config', 'provino.config.mjs', '--pool', 'inline', '--reporter', 'json'],
      { cwd: dir, env: ENV },
    )
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(viewOfNormalized(run.stdout).success, true)
  })

  test('a jsdom file', async () => {
    const dir = await project(FILES)
    const run = runBuilt(
      ['run', '--config', 'jsdom.config.mjs', '--reporter', 'json', '--pool', 'forks'],
      { cwd: dir, env: ENV },
    )
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const view = viewOfNormalized(run.stdout)
    assert.equal(view.success, true)
    assert.equal(view.files.size, 1)
  })

  test('injectGlobals: false', async () => {
    const dir = await project({ 'tests/no-globals.test.ts': NO_GLOBALS }, ',"injectGlobals":false')
    const run = runBuilt(['jest', '--ci'], { cwd: dir, env: ENV })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, /Tests:\s+1 passed, 1 total/)
  })

  test('lazy used outside a test file Provino runs says so', () => {
    const outside = `import { lazy } from 'provino'
try { lazy.let('x', () => 1) } catch (e) { console.log(e.code) }`
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', outside], {
      cwd: PACKAGE,
      encoding: 'utf8',
      env: childEnv(),
    })
    assert.equal(ran.stdout.trim(), 'LAZY_NO_RUNTIME', ran.stderr)
  })

  test('a failed test lists the lazy values it evaluated and the chain of the one that threw', async () => {
    const dir = await project({ 'tests/failing.test.ts': FAILING })
    const run = runBuilt(['jest', '--ci', '-w', '1'], { cwd: dir, env: ENV })
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`)
    const text = run.stderr
    assert.match(text, /no such user/)
    assert.equal(text.split('Lazy values evaluated before the failure:').length, 2, text)
    const throwLine = lineOf(FAILING, 'LAZY_THROW_MARK')
    assert.match(text, /later {2}tests\/failing\.test\.ts:\d+:\d+ {2}<?\d+ ms/)
    assert.match(text, /db {2}tests\/failing\.test\.ts:\d+:\d+/)
    assert.match(text, new RegExp(`user threw  tests/failing\\.test\\.ts:${throwLine - 1}:\\d+`))
    assert.match(text, /cart threw {2}tests\/failing\.test\.ts/)
    assert.equal(text.match(/chain: cart -> user/g)?.length, 1, text)
    assert.match(text, /Tests:\s+1 failed, 1 passed, 2 total/)
  })
})
