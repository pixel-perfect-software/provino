// The `provino` reporter's frames, pinned (B26 Phase 2): the fixture run through the reporter with
// the manual scheduler (a frame after each file ends) and a clock that moves 37 ms per event, as a
// plain stream and as a colour terminal, with the emoji and the fallback glyph sets, at 40 and 120
// columns; one footer state; the two end cards; and the `--tree` and `--map` views (B26 Phase 4)
// over the fixture's files laid out in folders. `PROVINO_UPDATE_GOLDENS=1` writes them.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ReporterBus, ReporterEvents } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import { expectGolden } from '../internal/golden.ts'
import {
  buildFile,
  error,
  FIXTURE_FILES,
  FIXTURE_SNAPSHOTS,
  type FileSpec,
  playRun,
} from '../internal/test-support.ts'
import { createStyle } from '../style.ts'
import { provinoReporter } from './reporter.ts'
import { GLYPHS } from './terminal/glyphs.ts'
import { fakeClock, manualScheduler, recordingSink } from './test-support.ts'
import { endCardLines } from './view/end-card.ts'

/** The sources the code frames come from, keyed by file name; the fixture's own files don't exist on disk. */
const SOURCES: Readonly<Record<string, string>> = {
  'fails.test.ts': [
    "import { expect, test } from 'provino'",
    "test('fails', () => {",
    '  expect(compute()).toBe(2)',
    '})',
    '',
  ].join('\n'),
  'discount.ts': [
    'export function discount(cart: Cart): number {',
    '  const rules = cart.rules',
    '  return rules.percent * cart.subtotal',
    '}',
    '',
  ].join('\n'),
  'snapshot.test.ts': [
    "test('matches a stored snapshot', () => {",
    '  expect({ value: makeValue() }).toMatchSnapshot()',
    '})',
    '',
  ].join('\n'),
}

const readSource = (path: string): Promise<string | undefined> =>
  Promise.resolve(SOURCES[path.slice(path.lastIndexOf('/') + 1)])

/** Lets the code frames' reads settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const MODES = { plain: false, tty: true } as const
const SETS = { emoji: GLYPHS.emoji, fallback: GLYPHS.ascii } as const

function setup(options: {
  live: boolean
  colour: boolean
  columns: number
  glyphs: 'emoji' | 'fallback'
}) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: options.live,
    colour: options.colour,
    columns: options.columns,
    glyphs: SETS[options.glyphs],
    hyperlinks: false,
    cwd: '/project',
    readSource,
    scheduler,
  })
  return { clock, scheduler, sink, reporter }
}

describe('the provino reporter on the fixture run', () => {
  for (const [mode, terminal] of Object.entries(MODES)) {
    for (const glyphs of ['emoji', 'fallback'] as const) {
      for (const columns of [40, 120]) {
        test(`${mode}, ${glyphs}, ${columns} columns`, async () => {
          const { clock, scheduler, sink, reporter } = setup({
            live: terminal,
            colour: terminal,
            columns,
            glyphs,
          })
          const bus = createReporterBus([reporter])
          const stepped: ReporterBus = {
            add: (each) => bus.add(each),
            async emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]) {
              clock.advance(37)
              await bus.emit(event, ...args)
              if (event === 'file:end') {
                await settle()
                scheduler.tick()
              }
            },
          }
          await playRun(stepped, FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS, durationMs: 1234 })
          await expectGolden(`provino.${mode}.${glyphs}.${columns}`, sink.text())
        })
      }
    }
  }
})

describe('the footer with 16 busy workers, 3 over their expected time', () => {
  for (const glyphs of ['emoji', 'fallback'] as const) {
    for (const columns of [40, 120]) {
      test(`${glyphs}, ${columns} columns`, async () => {
        const { clock, scheduler, sink, reporter } = setup({
          live: true,
          colour: false,
          columns,
          glyphs,
        })
        const files = Array.from({ length: 20 }, (_, index) => ({
          ...buildFile({ path: `src/feature-${index}/module-${index}.test.ts` }).info,
          expectedMs: index < 3 ? 400 : 5000,
        }))
        await reporter['run:start']?.(
          { root: '/project', projects: [''], startTime: 0, watch: false, workers: 16 },
          files,
        )
        files.slice(0, 16).forEach((file, id) => {
          reporter['file:start']?.(file, id)
          clock.advance(10)
        })
        clock.advance(1500)
        scheduler.tick()
        await expectGolden(`provino-footer.${glyphs}.${columns}`, sink.text())
      })
    }
  }
})

describe('the end card', () => {
  const base = {
    reason: 'passed',
    passed: 4000,
    failed: 0,
    skipped: 0,
    todo: 0,
    filesDone: 1980,
    filesFailed: 0,
    durationMs: 12_400,
    slowest: [
      { path: 'src/a.test.ts', durationMs: 4200 },
      { path: 'src/b.test.ts', durationMs: 3900 },
      { path: 'src/c.test.ts', durationMs: 3100 },
    ],
    snapshots: undefined,
    openHandles: undefined,
    lateConsole: 0,
    failures: [],
    failuresMore: 0,
  } as const
  const plain = createStyle(false)

  test('pass', async () => {
    const text = endCardLines({ ...base, ok: true }, 120, GLYPHS.emoji, plain).join('\n')
    await expectGolden('provino-end.pass', `${text}\n`)
  })

  test('fail', async () => {
    const lines = endCardLines(
      {
        ...base,
        ok: false,
        reason: 'failed',
        passed: 3985,
        failed: 3,
        skipped: 12,
        filesFailed: 2,
        snapshots: { added: 0, matched: 8, unmatched: 1, updated: 0, unchecked: 2 },
        failures: [
          '  ❌ cart › total › applies the discount  src/cart/total.test.ts:41:22',
          '  ❌ cart › total › rounds  src/cart/total.test.ts:58:9',
          '  ❌ src/broken.test.ts',
        ],
        failuresMore: 0,
      },
      120,
      GLYPHS.emoji,
      plain,
    )
    await expectGolden('provino-end.fail', `${lines.join('\n')}\n`)
  })

  // B26 Phase 3 review: the seed (`--showSeed`, `--randomize`) and every snapshot outcome, with the
  // hint how to update them, in the provino reporter's own words.
  test('seed and snapshots', async () => {
    const lines = endCardLines(
      {
        ...base,
        ok: false,
        reason: 'failed',
        passed: 3999,
        failed: 1,
        filesFailed: 1,
        snapshots: {
          added: 2,
          matched: 8,
          unmatched: 1,
          updated: 0,
          unchecked: 3,
          filesRemoved: 1,
        },
        snapshotUpdate: 'new',
        snapshotHint: 're-run with `-u`',
        seed: 1234,
        failures: ['  ❌ cart › matches  src/cart.test.ts:4:7'],
        failuresMore: 0,
      },
      120,
      GLYPHS.emoji,
      plain,
    )
    await expectGolden('provino-end.seed-snapshots', `${lines.join('\n')}\n`)
  })

  test('snapshots updated under -u: removed files, no hint', async () => {
    const lines = endCardLines(
      {
        ...base,
        ok: true,
        snapshots: {
          added: 0,
          matched: 4,
          unmatched: 0,
          updated: 2,
          unchecked: 0,
          filesRemoved: 2,
        },
        snapshotUpdate: 'all',
        snapshotHint: 're-run with `-u`',
      },
      120,
      GLYPHS.emoji,
      plain,
    )
    await expectGolden('provino-end.snapshots-updated', `${lines.join('\n')}\n`)
  })
})

describe('a failure thrown deep in source: the call chain under the code frame', () => {
  const stack = [
    'Error: cannot read the discount',
    '    at discount (/project/src/cart/discount.ts:3:22)',
    '    at total (/project/src/cart/total.ts:12:20)',
    '    at node:internal/process/task_queues:105:5',
    '    at Object.<anonymous> (/project/src/cart/total.test.ts:8:19)',
    '    at lib (/project/node_modules/lib/index.js:1:1)',
    '    at step1 (/project/src/steps.ts:1:1)',
    '    at step2 (/project/src/steps.ts:2:1)',
    '    at step3 (/project/src/steps.ts:3:1)',
    '    at step4 (/project/src/steps.ts:4:1)',
  ].join('\n')
  const spec = {
    path: 'src/cart/total.test.ts',
    tests: [
      {
        path: ['cart', 'total', 'applies the discount'],
        state: 'fail' as const,
        errors: [error('cannot read the discount', { stack })],
      },
    ],
  }
  for (const [mode, terminal] of Object.entries(MODES)) {
    test(mode, async () => {
      const { clock, scheduler, sink, reporter } = setup({
        live: terminal,
        colour: terminal,
        columns: 100,
        glyphs: 'emoji',
      })
      const bus = createReporterBus([reporter])
      const stepped: ReporterBus = {
        add: (each) => bus.add(each),
        async emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]) {
          clock.advance(37)
          await bus.emit(event, ...args)
          if (event === 'file:end') {
            await settle()
            scheduler.tick()
          }
        },
      }
      await playRun(stepped, [spec], { durationMs: 900 })
      await expectGolden(`provino-stack.${mode}`, sink.text())
    })
  }
})

// The views over the fixture run laid out in folders, plus a failing file with nested describes
// and a folder of small passing files, so a folder wraps at 40 columns. The sources of the fixture's
// failures are looked up by file name, so moving the files changes no code frame.
const at = (folder: string, spec: FileSpec): FileSpec => ({
  ...spec,
  path: `${folder}/${spec.path}`,
})
const fixture = (path: string): FileSpec => {
  const spec = FIXTURE_FILES.find((each) => each.path === path)
  if (spec === undefined) throw new Error(`no fixture file ${path}`)
  return spec
}
const passing = (names: readonly string[], folder: string): FileSpec[] =>
  names.map((name, index) => ({
    path: `${folder}/${name}.test.tsx`,
    durationMs: 5 + index,
    tests: [{ path: [name, 'renders'], durationMs: 1 }],
  }))
const VIEW_FILES: readonly FileSpec[] = [
  at('src/math', fixture('math.test.ts')),
  {
    path: 'src/math/geometry.test.ts',
    durationMs: 310,
    tests: [
      { path: ['area', 'circle'], durationMs: 2 },
      { path: ['area', 'square'], durationMs: 1 },
      { path: ['perimeter'], durationMs: 1 },
    ],
  },
  {
    path: 'src/cart/total.test.ts',
    durationMs: 120,
    tests: [
      { path: ['cart', 'total', 'sums the items'], durationMs: 2 },
      {
        path: ['cart', 'total', 'applies the discount'],
        state: 'fail',
        durationMs: 5,
        errors: [error('expected 90, received 100\n\nExpected: 90\nReceived: 100')],
        location: { line: 41, column: 22 },
      },
      { path: ['cart', 'total', 'rounds up'], durationMs: 1 },
      { path: ['cart', 'empty', 'is zero'], durationMs: 1 },
      { path: ['cart', 'empty', 'has no items'], durationMs: 1 },
      { path: ['cart', 'tax', 'is planned'], state: 'todo' },
      { path: ['cart', 'tax', 'skips shipping'], state: 'skip', skipReason: 'modifier' },
      { path: ['cart', 'adds an item'], durationMs: 2 },
    ],
  },
  at('src/cart', fixture('fails.test.ts')),
  at('src/cart', fixture('snapshot.test.ts')),
  at('src/cart', fixture('broken.test.ts')),
  ...passing(
    [
      'button',
      'card',
      'checkbox',
      'dialog',
      'dropdown',
      'form',
      'icon',
      'input',
      'link',
      'list',
      'menu',
      'modal',
      'popover',
      'radio',
      'select',
      'tabs',
      'toast',
      'tooltip',
    ],
    'src/components',
  ),
  at('tests', fixture('skipped.test.ts')),
  at('tests', fixture('all-skipped.test.ts')),
  at('tests', fixture('todo-only.test.ts')),
  at('tests', fixture('console.test.ts')),
]

async function playViews(options: {
  views: { tree?: true; map?: true }
  colour: boolean
  columns: number
  glyphs: 'emoji' | 'fallback'
}): Promise<string> {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: false,
    colour: options.colour,
    columns: options.columns,
    glyphs: SETS[options.glyphs],
    hyperlinks: false,
    cwd: '/project',
    readSource,
    scheduler,
    views: options.views,
  })
  const bus = createReporterBus([reporter])
  const stepped: ReporterBus = {
    add: (each) => bus.add(each),
    async emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]) {
      clock.advance(37)
      await bus.emit(event, ...args)
      if (event === 'file:end') await settle()
    },
  }
  await playRun(stepped, VIEW_FILES, { snapshots: FIXTURE_SNAPSHOTS, durationMs: 1234 })
  assert.deepEqual(bus.failures(), [])
  return sink.text()
}

describe('the --tree and --map views over the fixture run in folders', () => {
  for (const view of ['tree', 'map'] as const) {
    for (const glyphs of ['emoji', 'fallback'] as const) {
      for (const columns of [40, 120]) {
        test(`${view}, ${glyphs}, ${columns} columns`, async () => {
          const text = await playViews({
            views: { [view]: true },
            colour: false,
            columns,
            glyphs,
          })
          await expectGolden(`provino-${view}.${glyphs}.${columns}`, text)
        })
      }
    }
    test(`${view} in colour, emoji, 120 columns`, async () => {
      const text = await playViews({
        views: { [view]: true },
        colour: true,
        columns: 120,
        glyphs: 'emoji',
      })
      await expectGolden(`provino-${view}.colour.120`, text)
    })
  }
})
